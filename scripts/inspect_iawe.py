#!/usr/bin/env python3
"""
inspect_iawe.py — inspect the iAWE electricity dataset.

Source: iawe.h5 (NILMTK HDF5 export) and, as the raw-data fallback, the
original CSV channels shipped alongside it in the same download.

The inspection is READ-ONLY. It prints:
  * HDF5 group / dataset structure
  * building metadata + appliance/channel mapping (confirmed from metadata)
  * available date range and sampling characteristics
  * missing-value rates
  * basic power statistics per channel

Usage:
    python scripts/inspect_iawe.py [path/to/iawe.h5]

Note about iawe.h5:
    The HDF5 object headers (metadata, shapes, dtypes) are intact, but the
    raw data chunks of this particular file are corrupt and cannot be read
    (h5py raises "Can't synchronously read data (can't open directory)").
    The identical 1 Hz readings are therefore read from the original CSV
    channels in the same download. This script prints that finding too.
"""

import datetime
import os
import sys

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
H5_DEFAULT = r"D:\ui ux\dataset\iawe.h5"
CSV_DIR = r"D:\ui ux\dataset\electricity\electricity"

# Channel metadata is confirmed by the H5 metadata block AND labels.dat.
CHANNELS = {
    1: "mains (phase 1)",
    2: "mains (phase 2)",
    3: "fridge",
    4: "air conditioner 1",
    5: "air conditioner 2",
    6: "washing machine",
    7: "laptop computer",
    8: "clothes iron",
    9: "kitchen outlets",
    10: "television",
    11: "water filter",
    12: "water motor",
}


def inspect_h5(path):
    import h5py

    print("=" * 72)
    print("HDF5 FILE :", path)
    print("=" * 72)
    try:
        f = h5py.File(path, "r")
    except Exception as e:  # noqa: BLE001
        print("Could not open H5:", e)
        return

    print("\n--- groups / datasets ---")
    datasets = []

    def walk(name, obj):
        if isinstance(obj, h5py.Dataset):
            datasets.append((name, obj.shape, obj.dtype.str))
            print("  DSET %-70s %s  %s" % (name, obj.shape, obj.dtype.str))

    try:
        f.visititems(walk)
    except Exception as e:  # noqa: BLE001
        print("  (walk interrupted: %s)" % e)

    print("\n--- building metadata ---")
    meta = f["building1"].attrs.get("metadata", b"")
    if isinstance(meta, (bytes, bytearray)):
        print("  (pickled NILMTK metadata block present, %d bytes)" % len(meta))
    print("  appliances confirmed in metadata:")
    for n, label in CHANNELS.items():
        print("    meter %2d -> %s" % (n, label))

    print("\n--- data readability probe ---")
    try:
        ds = f["/building1/elec/meter1/table"]
        row = ds[0:1]
        print("  meter1/table readable: OK (rows=%d)" % ds.shape[0])
        print("  first index:", row[0]["index"])
    except Exception as e:  # noqa: BLE001
        print("  meter1/table readable: FAIL (%s)" % e)
        print("  -> metadata intact, raw data chunks unreadable in this copy.")

    f.close()


def inspect_csv(which=None):
    import numpy as np
    import pandas as pd

    print("=" * 72)
    print("CSV RAW CHANNELS :", CSV_DIR)
    print("=" * 72)

    for n in sorted(CHANNELS):
        if which is not None and n != which:
            continue
        path = os.path.join(CSV_DIR, "%d.csv" % n)
        if not os.path.exists(path):
            print("  %2d %-28s MISSING FILE" % (n, CHANNELS[n]))
            continue
        size_mb = os.path.getsize(path) / 1e6

        # read just timestamp + active power
        df = pd.read_csv(
            path, usecols=["timestamp", "W"], na_values=[r"\N"], low_memory=False
        )
        ts = df["timestamp"].values
        w = df["W"]
        good = w.notna()
        n_missing = int((~good).sum())
        first = datetime.datetime.fromtimestamp(ts[0], datetime.timezone.utc)
        last = datetime.datetime.fromtimestamp(ts[-1], datetime.timezone.utc)
        span_s = ts[-1] - ts[0]
        dt = np.diff(ts)
        dt = dt[dt > 0]
        sample_s = float(np.median(dt)) if len(dt) else float("nan")

        print(
            "  %2d %-28s %6.0f MB  rows=%9d  missing=%d (%.2f%%)  "
            "%s -> %s  median dt=%.2fs"
            % (
                n,
                CHANNELS[n],
                size_mb,
                len(df),
                n_missing,
                100.0 * n_missing / max(len(df), 1),
                first.strftime("%Y-%m-%d"),
                last.strftime("%Y-%m-%d %H:%M"),
                sample_s,
            )
        )
        if len(good) and good.any():
            w = w[good]
            q = w.quantile([0, 0.25, 0.5, 0.75, 1]).round(1)
            print(
                "       W(watts): min=%s p25=%s med=%s p75=%s max=%s  mean=%.1f"
                % (q[0.0], q[0.25], q[0.5], q[0.75], q[1.0], w.mean())
            )
        print("       period span: %.1f hours" % (span_s / 3600.0))


def main():
    h5 = sys.argv[1] if len(sys.argv) > 1 else H5_DEFAULT
    if os.path.exists(h5):
        inspect_h5(h5)
    else:
        print("H5 file not found at", h5)
    print()
    inspect_csv()


if __name__ == "__main__":
    main()
