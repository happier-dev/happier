# Sourced by gate.sh: per-commit result cache (a result depends only on the commit, so the sha is the key).
# Lives outside the synced checkout. The wrapper provides a live packet cache that it removes
# on EXIT. Standalone and older running wrappers still use the legacy age-based shared cache.
GATE_CACHE=${P03_GATE_CACHE:-$HOME/.happier-stack/cache/p03-commit-gate}
mkdir -p "$GATE_CACHE"
if [ "${P03_GATE_PACKET_CACHE:-0}" != 1 ]; then
  find "$GATE_CACHE" -maxdepth 1 -type f -mmin +1440 -delete 2>/dev/null || true
  # Export-scan input indexes (~9 MB each) only seed the next HEAD's incremental scan, so keep them briefly.
  find "$GATE_CACHE" -maxdepth 1 -type f -name 'scanidx-*' -mmin +90 -delete 2>/dev/null || true
  # Bundle input indexes (bundlegate.mjs, ~0.9 MB each) seed the next HEAD's and candidate's derivation the same way.
  find "$GATE_CACHE" -maxdepth 1 -type f -name 'hbx-*' -mmin +240 -delete 2>/dev/null || true
fi
# cached <key> <producer...>: print the cached result for key, or run producer (stdout) and cache it.
# A failing producer is never cached. Concurrent gates on one key share one producer run: the first takes
# the key's lock and produces, the others wait on it and read the result (2026-11-16 census: three gates
# each ran the same ~100 s base scan, four the same base headbuild). A killed holder releases the lock and
# the next waiter produces; the result is still written to a temp file and renamed into place.
cached() { local f="$GATE_CACHE/$1"; shift
  if [ -f "$f" ] && cat "$f" 2>/dev/null; then touch -c "$f" 2>/dev/null; return 0; fi
  # A cheap-only caller (P03_SCAN_CHEAP_ONLY=1, under the commit lock) never waits on another producer of the key.
  ( if [ "${P03_SCAN_CHEAP_ONLY:-0}" = 1 ]; then flock -n -x 8 || exit 3; else flock -x 8; fi
    if [ -f "$f" ] && cat "$f" 2>/dev/null; then exit 0; fi
    t=$(mktemp "$f.XXXXXX.part") || exit 1; rc=0
    "$@" > "$t" 8>&- || rc=$?
    if [ $rc -ne 0 ]; then rm -f "$t"; exit $rc; fi
    cat "$t"; mv -f "$t" "$f" ) 8>"$f.lock"; }
