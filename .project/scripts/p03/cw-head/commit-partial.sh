#!/usr/bin/env bash
# usage: commit-partial.sh <msgfile> <wholefilelist|-> <patch>...   whole files + cached patches
set -euo pipefail
SELF=$(readlink -f "$0")
msg=$1; list=$2; shift 2; patches=("$@")
# Keep the packet's first arrival across wrapper re-exec. A pre-upgrade Linux
# writer already carrying a frozen packet retains the original process start.
if [ -z "${P03_CP_ARRIVED_AT:-}" ]; then
  if [ -n "${P03_CP_FROZEN:-}" ] && started=$(stat -c '%Y' "/proc/$$" 2>/dev/null); then
    P03_CP_ARRIVED_AT=$((started * 1000))
  else
    P03_CP_ARRIVED_AT=$(node -p 'Date.now()')
  fi
fi
export P03_CP_ARRIVED_AT
# Context-free patches cannot safely be replayed onto moving HEAD.
case " ${APPLY_FLAGS:-} " in *--unidiff-zero*) echo "commit-partial: context patches (-U3) required; --unidiff-zero is forbidden"; exit 1;; esac
files=(); [ "$list" = "-" ] || mapfile -t files < "$list"
# R2 (process audit 1116: 9 whole-file sweeps of other lanes' hunks). A whole-file entry commits every
# working-tree hunk of the file, so it is allowed only for a file absent at HEAD (new) or a deletion.
# A tracked file comes as a patch holding only your hunks.
tracked=()
for f in "${files[@]}"; do [ -n "$f" ] && [ -e "$f" ] && git cat-file -e "HEAD:$f" 2>/dev/null && tracked+=("$f"); done
if [ ${#tracked[@]} -gt 0 ]; then
  for f in "${tracked[@]}"; do
    echo "commit-partial: refused whole-file entry for tracked file $f ($(git --no-optional-locks -c diff.autoRefreshIndex=false diff -U0 HEAD -- "$f" | grep -c '^@@') working-tree hunk(s), possibly other lanes' edits)."
  done
  echo "Commit tracked files by patch with only your hunks, e.g. git --no-optional-locks -c diff.autoRefreshIndex=false diff HEAD -- <file> > mine.patch, delete the hunks that are not yours, and pass mine.patch after the list. Whole-file entries are for new files and deletions."
  exit 1
fi
for p in "${patches[@]}"; do
  awk '/^diff --git a\//{f=$3; sub(/^a\//,"",f)} /^@@/{n[f]++} END{for (k in n) printf "patch %s: %s: %d hunk(s)\n", FILENAME, k, n[k]}' "$p"
done
ref=$(git symbolic-ref HEAD)
tooling=$(cd -- "$(dirname "$SELF")/../../../.." && pwd -P)
cacheRoot=$(realpath -m -- "${P03_GATE_CACHE:-$HOME/.happier-stack/cache/p03-commit-gate}")
mkdir -p "$cacheRoot"
# Adopt the same frozen file from an existing packet at switch-over, without recapturing checkout bytes.
if [[ ${P03_CP_FROZEN:-} == "$cacheRoot"/packet.??????/packet && -s "$P03_CP_FROZEN" ]]; then
  packetDir=${P03_CP_FROZEN%/packet}
else
  packetDir=$(mktemp -d "$cacheRoot/packet.XXXXXX")
fi
packet=$packetDir/packet
trap 'rm -rf -- "$packetDir"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
compose() { # head -> $commit, $expected
  local head=$1 idx tree p f a b
  idx=$(mktemp "$packetDir/index.XXXXXX"); unlink "$idx"
  GIT_INDEX_FILE="$idx" git read-tree "$head"
  [ ${#files[@]} -eq 0 ] || GIT_INDEX_FILE="$idx" git add -- "${files[@]}"
  for p in "${patches[@]}"; do GIT_INDEX_FILE="$idx" git apply --cached --check --recount ${APPLY_FLAGS:-} "$p" && GIT_INDEX_FILE="$idx" git apply --cached --recount ${APPLY_FLAGS:-} "$p" || { echo "patch fails $p"; unlink "$idx"; exit 1; }; done
  GIT_INDEX_FILE="$idx" git diff --cached --check "$head" -- . ':(exclude)patches/*.patch' || { echo "check failed"; unlink "$idx"; exit 1; }
  for f in "${files[@]}"; do [ -e "$f" ] || continue; a=$(GIT_INDEX_FILE="$idx" git ls-files -s -- "$f" | awk '{print $2}'); b=$(git hash-object -- "$f"); [ "$a" = "$b" ] || { echo "blob mismatch $f"; unlink "$idx"; exit 1; }; done
  expected=$( { printf '%s\n' "${files[@]}"; for p in "${patches[@]}"; do grep '^diff --git a/' "$p" | sed 's#^diff --git a/\(.*\) b/.*#\1#'; done; } | grep -v '^$' | sort -u)
  tree=$(GIT_INDEX_FILE="$idx" git write-tree); unlink "$idx"
  commit=$(git commit-tree "$tree" -p "$head" -F "$msg")
  diff <(git diff --no-renames --name-only "$head" "$commit" | sort) <(echo "$expected") || { echo "unexpected paths"; exit 1; }
}
# A private-index commit of a file the shared index never tracked leaves that path staged as deleted in
# the shared index (presence-deadline 23:59Z, stored_content_bytes 01:46Z migrations). Register only such
# new paths, and only when the checkout bytes equal the committed blob; every other entry stays the lane's.
register_new_paths() {
  local f entry
  while IFS= read -r f; do
    [ -n "$f" ] && [ -e "$f" ] || continue
    git ls-files --error-unmatch -- "$f" >/dev/null 2>&1 && continue
    entry=$(git ls-tree "$commit" -- "$f") || continue
    [ -n "$entry" ] && [ "$(git hash-object -- "$f")" = "$(printf '%s' "$entry" | awk '{print $3}')" ] || continue
    git update-index --add --cacheinfo "$(printf '%s' "$entry" | awk '{print $1}')","$(printf '%s' "$entry" | awk '{print $3}')","$f" \
      && echo "shared index: registered new path $f" || echo "shared index: could not register $f (realign it yourself)"
  done <<< "$expected"
}
# The ref update leaves the checkout untouched. For a dirty file, check if its
# current bytes would change when the landed delta is merged on its exact parent.
checkout_has_landed_change() {
  local path=$1 old_mode=$2 new_mode=$3 old_blob=$4 new_blob=$5 audit=$packetDir/checkout-audit
  case "$new_mode" in
    000000) [[ ! -L "$path" && ( ! -e "$path" || -d "$path" ) ]]; return;;
    120000) [ -L "$path" ] && [ "$(readlink -n -- "$path" | git hash-object --stdin)" = "$new_blob" ]; return;;
    160000) [ -e "$path/.git" ] && [ "$(git -C "$path" rev-parse --verify HEAD)" = "$new_blob" ]; return;;
  esac
  [[ -f "$path" && ! -L "$path" ]] || return 1
  if [ "$old_mode" != "$new_mode" ]; then
    case "$new_mode" in
      100644) [ ! -x "$path" ] || return 1;;
      100755) [ -x "$path" ] || return 1;;
    esac
  fi
  local observed
  observed=$(git hash-object -- "$path") || return 1
  [ "$observed" = "$new_blob" ] && return 0
  [ "$observed" != "$old_blob" ] || return 1
  [[ "$old_mode" = 100644 || "$old_mode" = 100755 ]] || return 1
  mkdir -p -- "$audit" &&
    git cat-file --filters --path="$path" "$old_blob" > "$audit/base" &&
    git cat-file --filters --path="$path" "$new_blob" > "$audit/landed" &&
    git merge-file -p -q -- "$path" "$audit/base" "$audit/landed" | cmp -s -- "$path" -
}
warn_checkout_drift() {
  git diff-tree --no-commit-id --raw --no-abbrev --no-renames -r -z "$head" "$commit" |
    while IFS= read -r -d '' entry && IFS= read -r -d '' path; do
      read -r old_mode new_mode old_blob new_blob _ <<< "${entry#:}"
      checkout_has_landed_change "$path" "$old_mode" "$new_mode" "$old_blob" "$new_blob" ||
        printf 'WARNING HSTACK_COMMITTED_CHECKOUT_DRIFT %q after %s (landed change missing or unverifiable)\n' "$path" "$commit" >&2
    done
}

head=$(git rev-parse --verify "$ref")
# A detached packet carries the commit it was authored against. Freeze it
# there; the locked gate composes it over the current ref.
if [ -n "${P03_CP_PACKET_BASE:-}" ]; then
  base=$(git rev-parse --verify --end-of-options "${P03_CP_PACKET_BASE}^{commit}")
  git merge-base --is-ancestor "$base" "$head" || { echo "packet base must be an ancestor of $ref"; exit 1; }
  head=$base
fi
if [ -n "${P03_CP_FROZEN:-}" ] && [ -s "$P03_CP_FROZEN" ]; then
  [ "$P03_CP_FROZEN" = "$packet" ] || cp -- "$P03_CP_FROZEN" "$packet"
  # A frozen patch supplies its own exact paths, including rename pairs as add/delete.
  patches=("$packet")
  files=()
  unset APPLY_FLAGS
  compose "$head"
else
  compose "$head"
  git diff --binary --full-index --no-renames -U3 "$head" "$commit" > "$packet"
fi
cp -- "$msg" "$packetDir/message"
dry=()
[ -z "${DRY:-}" ] || dry+=(--dry)
export HAPPIER_COMMIT_GATE_ARRIVED_AT=$P03_CP_ARRIVED_AT
rc=0
node "$tooling/scripts/workspaces/commitGate.mjs" --candidate="$commit" --ref="$ref"   --packet="$packet" --message="$packetDir/message" "${dry[@]}" > "$packetDir/verdict" || rc=$?
cat "$packetDir/verdict"
case $rc in
  0) ;;
  10) echo "candidate refused by the gate; no ref changed"; exit 1;;
  *) echo "candidate gate incomplete or unavailable; no ref changed"; exit "$rc";;
esac
[ -z "${DRY:-}" ] || exit 0
read -r verdict commit _ head < "$packetDir/verdict"
[ "$verdict" = COMMITTED ]
{ git show --stat --format="%h %s" "$commit" | head -40 || true; }
expected=$(git diff --no-renames --name-only "$head" "$commit")
register_new_paths
warn_checkout_drift
if [ -n "${P03_COMMIT_KICK:-}" ]; then
  $P03_COMMIT_KICK || true
else
  node "$tooling/scripts/workspaces/commitPackageTypecheck.mjs" --kick --commit="$commit" || echo "rolling HEAD typecheck kick failed; report to P03"
fi
