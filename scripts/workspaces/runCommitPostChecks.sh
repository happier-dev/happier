#!/usr/bin/env bash
# Compare two landed trees for the rolling report or an exact parent check.
set -uo pipefail
tooling=$(cd -- "$(dirname "$0")/../.." && pwd -P)
toolsDir="$tooling/.project/scripts/p03/cw-head"
if ! [ -f "$toolsDir/bundlegate.mjs" ] || ! [ -f "$toolsDir/scanrev.sh" ]; then
  echo "post-commit broad check unavailable: $toolsDir is missing its bundle or export runner" >&2
  exit 75
fi
if [ "${1:-}" != "--bundle" ]; then
  entryStatus=0
  node "$tooling/scripts/workspaces/commitTreeEntryLoads.mjs" --post-commit --base "$1" --tree "$2" || entryStatus=$?
  case $entryStatus in 0) ;; 10) exit 10;; *) exit 75;; esac
  exec "$tooling/apps/stack/bin/hstack-exec" --heavyweight-admission --class=compilation --machine=local \
    --identity-arg=bash --identity-arg=scripts/workspaces/runCommitPostChecks.sh \
    -- bash "$0" --bundle "$1" "$2"
fi
shift
structuralStatus=0
node "$tooling/scripts/workspaces/commitGate.mjs" --post-commit --base="$1" --tree="$2" || structuralStatus=$?
case $structuralStatus in 0) ;; 10) exit 10;; *) exit 75;; esac
unset P03_SCAN_CHEAP_ONLY P03_GATE_PRIOR SCAN_FROM
refuse() {
  local check=$1 path=$2 key=$3
  printf 'HAPPIER_POST_COMMIT_FAILURE\t%s\t%s\t%s\n' "$check" "$path" "$key"
  echo "POST-COMMIT RED: $check"
  exit 10
}
checked() {
  local check=$1 key
  printf 'HAPPIER_POST_COMMIT_CHECK\t%s\n' "$check"
  while IFS= read -r key; do
    if [ -n "$key" ]; then printf 'HAPPIER_POST_COMMIT_CHECK\t%s\t%s\n' "$check" "$key"; fi
  done
}
first_path() {
  awk -F '\t' '$1 ~ /[^[:space:]]/ { sub(/^ +/, "", $1); sub(/:[0-9]+$/, "", $1); print $1; exit }'
}
# bundlegate.mjs runs headbuild.mjs only for the targets (cli, scripts, server) whose recorded inputs the change
# since the nearest cached ancestor touches, and reuses the ancestor's errors for the rest: a docs/test/UI-only
# commit bundles nothing (P03-GATE-COST 2026-11-17: ~160-180 CPU-s and ~5 GB per candidate bundle before).
HB="$toolsDir"/bundlegate.mjs
norm() { sed -E 's/NOT_AT_[0-9A-Za-z]+/NOT_AT_REV/; s/^  \t/  /' | grep '^  ' | sort -u; }
. "$toolsDir"/cache.sh
. "$toolsDir"/compare.sh
. "$toolsDir"/scanrev.sh
# Exit 75 = post-commit check unavailable (a check could not judge: crashed bundle, empty/failed scan). It is never a
# baseline and never blamed on the candidate.
# headbuild always ends with a TOTAL line; without it the bundle crashed and its error list means nothing.
hbrun() { local out; out=$(node $HB "$PWD" "$1" 2>&1); printf '%s\n' "$out" | grep '^bundlegate:' >&2; printf '%s\n' "$out" | grep -q '^TOTAL ' || { echo "HEADBUILD FAILED rev=$1: $(printf '%s' "$out" | tail -c 300)" >&2; return 1; }
  printf '%s\n' "$out" | norm || true; }
hb() { local sha; sha=$(git rev-parse "$1"); cached "hbg-$sha.txt" hbrun "$sha"; }
b=$(hb "$1") || { echo "gate unavailable: base bundle failed"; exit 75; }
c=$(hbrun "$(git rev-parse "$2")") || { echo "gate unavailable: candidate bundle failed"; exit 75; }
echo "gate: base $(printf '%s' "$b" | grep -c .) errors, candidate $(printf '%s' "$c" | grep -c .) errors"
printf '%s\n' "$c" | cut -c1-220
bundleCheck="Bundle and import check"
printf '%s\n' "$c" | build_error_keys | checked "$bundleCheck"
# Any esbuild error the candidate adds (CLI incl. bundled plugins, server, and every .mjs/.cjs script under
# apps/stack, scripts/ and packages/*/scripts) fails: a missing module is kept external and recorded, so
# missing-export link errors are never hidden behind it.
bad=$(new_build_errors <(printf '%s\n' "$b") <(printf '%s\n' "$c") | grep . || true)
if [ -n "$bad" ]; then
  echo "NEW BUILD/IMPORT ERRORS:"
  echo "$bad" | cut -c1-250
  first=${bad%%$'\n'*}
  refuse "$bundleCheck" "$(printf '%s\n' "$first" | first_path)" "$(printf '%s\n' "$first" | build_error_keys)"
fi
# Type-level and re-export check, whole repository (esbuild bundles a missing TS re-export as undefined,
# and drops type-only imports entirely, so a consumer reading a type its producer never committed slips
# through the bundle). The base result is cached per commit; only findings the candidate adds fail.
# Fail closed: a scan that exits non-zero or prints nothing for the whole repository (HEAD always has
# findings) is a broken scan, never "no missing exports". (2026-11-15: five empty caches let gates pass.)
# Raw output and stderr go to this process's own temp files (2026-11-15: a concurrent gate deleted the
# shared .err/.raw, 'SCAN FAILED rc=0').
src=0; bs=$(fullscan "$1") || src=$?
[ $src -eq 0 ] || { echo "gate unavailable: base scan failed"; exit 75; }
src=0; cs=$(fullscan "$2") || src=$?
[ $src -eq 0 ] || { echo "gate unavailable: candidate scan failed"; exit 75; }
exportCheck="Export scan"
printf '%s\n' "$cs" | checked "$exportCheck"
miss=$(lines_added <(printf '%s\n' "$bs") <(printf '%s\n' "$cs"))
if [ -n "$miss" ]; then
  # Confirm apparent additions with the same scanner against the exact parent. A cached whole-tree
  # result can omit an inherited row. Rescan only the importers we would otherwise blame.
  if ! parent_rows=$(env -u OVERLAY -u PREFETCH -u INDEX_OUT "REV=$1" EXACT=1 \
    node "$toolsDir/scan/scan.cjs" "$PWD" <(printf '%s\n' "$miss" | cut -f1 | sort -u) \
    | sed -E 's/:[0-9]+\t/\t/'); then
    echo "gate unavailable: exact parent export recheck failed"
    exit 75
  fi
  preexisting=$(lines_common <(printf '%s\n' "$parent_rows") <(printf '%s\n' "$miss"))
  if [ -n "$preexisting" ]; then
    printf 'Pre-existing export findings (also at parent %s):\n%s\n' "$1" "$preexisting"
  fi
  miss=$(lines_added <(printf '%s\n' "$parent_rows") <(printf '%s\n' "$miss"))
fi
if [ -n "$miss" ]; then
  echo "MISSING EXPORTS (new, whole repo):"
  echo "$miss" | cut -c1-250
  first=${miss%%$'\n'*}
  refuse "$exportCheck" "$(printf '%s\n' "$first" | first_path)" "$first"
fi
echo "scan: no new missing exports anywhere in apps/ or packages/"
