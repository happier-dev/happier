#!/usr/bin/env bash
# usage: commit-partial.sh <msgfile> <wholefilelist|-> <patch>...   whole files + cached patches
set -euo pipefail
# A wrapper re-execs the installed wrapper when it was replaced while this one waited (P03-GATE-FIX 2026-11-17:
# OVERBUILT-HUNT-5's pre-fix copy cycled 2 h 38 min through 27 passing gates; the current one landed in 6 min).
SELF=$(readlink -f "$0"); SELF_ID=$(stat -c '%d:%i' "$SELF" 2>/dev/null || true); ARGS=("$@")
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
branch=$(git symbolic-ref --short HEAD)
tooling=$(cd -- "$(dirname "$SELF")/../../../.." && pwd -P)
entry_phase=${P03_CP_ENTRY_PHASE:-0}
declaration_phase=${P03_CP_DECLARATION_PHASE:-0}
# The gate is a separate process; P03_COMMIT_GATE replaces it in scratch-repo selftests.
GATE=${P03_COMMIT_GATE:-/home/leeroy.guest/.happier-stack/workspace/0.3/.project/scripts/p03/cw-head/gate.sh}
# R3: every gate run executes a private copy. Bash reads a running script by offset, so an in-place edit
# of gate.sh/fastgate.sh crashed running gates (22:41Z); the copy is immune. (Sourced helpers and node
# programs are read whole when they start.)
gateScratch=
cleanup_gate() {
  [ -z "$gateScratch" ] || rm -rf -- "$gateScratch"
  gateScratch=
}
rungate() {
  local rc=0
  if [ "${P03_SCAN_CHEAP_ONLY:-0}" != 1 ]; then publish_head_cache "$1" || echo "gate cache: could not publish HEAD seed" >&2; fi
  seed_gate_cache
  gateScratch=$(mktemp -d "${TMPDIR:-/tmp}/p03-gate.XXXXXX") || return 75
  cp "$1" "$gateScratch/gate.sh" || { cleanup_gate; return 75; }
  shift
  P03_GATE_CACHE="$packetCache" P03_GATE_PACKET_CACHE=1 P03_COMMIT_TREE_HOST_TMP="${TMPDIR:-/tmp}" \
    P03_COMMIT_TREE_WORK_DIR="$gateScratch" TMPDIR="$gateScratch" bash "$gateScratch/gate.sh" "$@" 9>&- || rc=$?
  cleanup_gate
  if [ "${P03_SCAN_CHEAP_ONLY:-0}" != 1 ]; then publish_head_cache "$1" || echo "gate cache: could not publish HEAD seed" >&2; fi
  return "$rc"
}
# After a commit lands, kick the single rolling HEAD typecheck (it coalesces, never waits). The selftests'
# scratch repos replace it.
kick() { if [ -n "${P03_COMMIT_KICK:-}" ]; then $P03_COMMIT_KICK || true
  else node /home/leeroy.guest/.happier-stack/workspace/0.3/scripts/workspaces/commitPackageTypecheck.mjs --kick --commit="$commit" 9>&- || echo "rolling HEAD typecheck kick failed (not your commit; report to P03)"; fi; }
# Serialize replay, its cheap delta recheck, and CAS.
# Gates run with fd 9 closed, so detached children cannot keep the commit lock.
LOCK="$(git rev-parse --git-common-dir)/p03-commit-partial.lock"
cacheRoot=$(realpath -m -- "${P03_GATE_CACHE:-$HOME/.happier-stack/cache/p03-commit-gate}")
packetDir=
exec 9>"$LOCK"
trap 'rc=$?; unlock 2>/dev/null || true; cleanup_gate; [ -z "$packetDir" ] || rm -rf -- "$packetDir";
      if [ "$entry_phase:$declaration_phase" != 0:0 ] && [ "$rc" = 1 ]; then exit 10; fi' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
mkdir -p "$cacheRoot/head"
# A requeue keeps the packet and its accepted scan index. All of its files go away on the final EXIT.
if [[ ${P03_CP_FROZEN:-} == "$cacheRoot"/packet.??????/packet && -s "$P03_CP_FROZEN" ]]; then
  packetDir=${P03_CP_FROZEN%/packet}
else
  packetDir=$(mktemp -d "$cacheRoot/packet.XXXXXX")
fi
packet=$packetDir/packet
packetCache=$packetDir/cache
mkdir -p "$packetCache"
ln -sfn -- "$cacheRoot/fullscan.slot" "$packetCache/fullscan.slot"

# Gate producers publish completed files by rename. A hardlink lends these files to the packet
# without copying their contents or making an active reader depend on the next HEAD publication.
seed_gate_cache() (
  if [ "${P03_SCAN_CHEAP_ONLY:-0}" = 1 ]; then flock -n -s 6 || exit 0; else flock -s 6 || exit 0; fi
  local file
  for file in "$cacheRoot/head/"*; do
    [ -f "$file" ] && ln -- "$file" "$packetCache/" 2>/dev/null || true
  done
) 6>"$cacheRoot/head.lock"

publish_head_cache() (
  local rev=$1 sha tree packages key source scan= bundle=
  local -A keep=()
  flock -x 6 || exit 0
  [ "$(git rev-parse HEAD)" = "$rev" ] || exit 0
  pin() {
    local name=$1 dir
    for dir in "$packetCache" "$cacheRoot/head" "$cacheRoot"; do
      if [ -f "$dir/$name" ]; then
        [ "$dir/$name" -ef "$cacheRoot/head/$name" ] || ln -f -- "$dir/$name" "$cacheRoot/head/$name" || return 1
        keep[$name]=1
        return 0
      fi
    done
    return 1
  }
  packages=$(git rev-parse --verify "$rev:packages" 2>/dev/null) && pin "manifest-parsers-$packages.mjs" || true
  pin "hbg-$rev.txt" || true
  # When another writer moves HEAD without preparing a scan/bundle, keep its nearest usable seed.
  while read -r sha tree; do
    if [ -z "$scan" ] && pin "scan-v2-T$tree.txt"; then
      if pin "scanidx-v2-T$tree.gz"; then scan=1; else unset "keep[scan-v2-T$tree.txt]"; fi
    fi
    if [ -z "$bundle" ] && pin "hbx-$sha.json.gz"; then bundle=1; fi
    [ -z "$scan" ] || [ -z "$bundle" ] || break
  done < <(git log --first-parent -64 --format='%H %T' "$rev")
  for source in "$cacheRoot/head/"*; do
    key=${source##*/}
    if [ -f "$source" ] && [ -z "${keep[$key]:-}" ]; then rm -f -- "$source"; fi
  done
) 6>"$cacheRoot/head.lock"

# /proc/locks names the short-lived `flock` child, which exits at once, so the real holder (this wrapper,
# holding fd 9) looked "invisible" (2026-11-16 00:44Z, 01:14Z, 01:36Z asks). The holder writes who it is.
lock() { flock -x 9; printf 'pid=%s since=%s msg=%s\n' "$$" "$(date -u +%H:%M:%SZ)" "$msg" > "$LOCK.holder"; }
unlock() { if [ "$(sed -n 's/^pid=\([0-9]*\) .*/\1/p' "$LOCK.holder" 2>/dev/null)" = "$$" ]; then rm -f "$LOCK.holder"; fi; flock -u 9; }
compose() { # head -> $commit, $expected
  local head=$1 idx tree p f a b
  idx=$(mktemp "${TMPDIR:-/tmp}/p03cw-idx.XXXXXX"); unlink "$idx"
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
# Freeze the exact private-index packet once. Later worktree or patch-file edits belong to
# the next packet, never to a candidate whose gate already passed.
replay() { # new HEAD -> fresh tree and parent; never reuse an old tree with a new parent
  local idx tree
  idx=$(mktemp "${TMPDIR:-/tmp}/p03-replay-index.XXXXXX"); unlink "$idx"
  GIT_INDEX_FILE="$idx" git read-tree "$1"
  if ! GIT_INDEX_FILE="$idx" git apply --cached --check "$packet" ||
     ! GIT_INDEX_FILE="$idx" git apply --cached "$packet"; then
    rm -f "$idx"; echo "commit-partial: replay conflict on HEAD $1; no ref changed; refresh the packet with context (-U3)"; exit 1
  fi
  tree=$(GIT_INDEX_FILE="$idx" git write-tree); unlink "$idx"
  commit=$(git commit-tree "$tree" -p "$1" -F "$msg")
}
# A re-exec after replacement or a full recheck carries the exact frozen packet (P03_CP_FROZEN).
# With P03_CP_GATED="<candidate> <its head>" the packet's passed gate carries over too: the loop rechecks it on the
# moved HEAD instead of running the full gate again (20 wrappers re-gating at once on an install would cost ~5 GB each).
resumed=""
cas_losses=0
if [ -n "${P03_CP_FROZEN:-}" ] && [ -s "$P03_CP_FROZEN" ]; then
  [ "$P03_CP_FROZEN" = "$packet" ] || mv -f "$P03_CP_FROZEN" "$packet"
  unset P03_CP_FROZEN
  if [ -n "${P03_CP_GATED:-}" ] && git cat-file -e "${P03_CP_GATED%% *}^{commit}" 2>/dev/null; then
    commit=${P03_CP_GATED%% *}; head=${P03_CP_GATED#* }; resumed=1
    cas_losses=${P03_CP_CAS_LOSSES:-0}
  else head=$(git rev-parse HEAD); replay "$head"; fi
  unset P03_CP_GATED
  expected=$(git diff --no-renames --name-only "$head" "$commit" | sort -u)
  echo "commit-partial: resumed the frozen packet on the installed wrapper${resumed:+ (its passed gate carries over)}"
else
  head=$(git rev-parse HEAD); compose "$head"
  git diff --binary --full-index --no-renames -U3 "$head" "$commit" > "$packet"
fi
final_recheck_incomplete() {
  echo 'commit gate incomplete (final scoped recheck): {"code":"final-recheck-incomplete"}'
  exit 11
}
check_gate() {
  local rc=0 phase=${2:-}
  echo "BUILD GATE on candidate $commit"
  rungate "$GATE" "$1" "$commit" || rc=$?
  if [ "$rc" -ne 0 ] && [ "$rc" -ne 10 ] && [ "$rc" -ne 11 ]; then
    if [ "$phase" = final ]; then
      echo "final worker preparation unavailable (exit $rc)"
      final_recheck_incomplete
    fi
    echo "gate unavailable (exit $rc); re-running it once"
    rc=0; rungate "$GATE" "$1" "$commit" || rc=$?
  fi
  [ $rc -eq 0 ] || {
    [ $rc -eq 10 ] && { echo "candidate refused by the gate; abort"; exit 1; }
    [ "$rc" -eq 11 ] && { echo "candidate gate incomplete; no ref changed"; exit 11; }
    echo "gate unavailable twice (exit $rc; not your candidate); retry later or report to P03"; exit 75
  }
}
[ -n "$resumed" ] || check_gate "$head"
# Only a passed packet carries its seniority into new requests.
export HAPPIER_COMMIT_GATE_ARRIVED_AT=$P03_CP_ARRIVED_AT
[ -z "${DRY:-}" ] || { echo "DRY candidate $commit"; exit 0; }
# HEAD moved after this packet's gate (P03-GATE-FIX 2026-11-17). The packet is replayed exactly; then only what
# the landed commits can change for it is re-verified, against the real new HEAD (whose bundle/scan results are
# shared as a seed by every waiter):
# - a merged file (both sides edited it) is parsed again (syntaxgate) and its imports/exports rescanned;
# - a landed commit can drop an export the packet imports, disjoint path or not: the export scan of the replayed
#   candidate, derived from the last accepted candidate's scan, refuses any finding it adds over the new HEAD;
# - manifests, lockfile importers, producer closure, plugin boundary and import cycles rerun (seconds);
# - the bundles are not rebuilt: the packet's own bundle result was judged when it passed, each landed commit was
#   bundled by its own gate, and their cross-file interaction is a name or module the export scan judges. When both
#   sides edited a package manifest or the lockfile (dependency resolution), the full gate runs instead.
# A refusal (exit 10) is real: a true text conflict stops in replay, a broken interaction in the recheck.
# (12:12Z-version: any shared path re-ran the whole gate on a fresh synthetic base, minutes of uncached bundles
# and full scans, so a hot file moved again before it finished: DBW-SPINE, DBW-CAPTURE, TELEMETRY D25, lockfile.)
gated=$commit
both_sides_deps() { [ ${#overlap[@]} -gt 0 ] && printf '%s\n' "${overlap[@]}" | grep -Eq '(^|/)package\.json$|^pnpm-lock\.yaml$|^yarn\.lock$'; }
replay_onto_now() {
  mapfile -t overlap < <(comm -12 <(git log --format= --name-only "$head..$now" | sed '/^$/d' | sort -u) <(printf '%s\n' "$expected" | sort -u))
  replay "$now"
  echo "HEAD moved $(git rev-list --count "$head..$now") commit(s); overlapping paths: ${overlap[*]:-none}; rechecking only what they can change"
}
resume_frozen_packet() {
  exec 9>&-
  P03_CP_FROZEN=$packet P03_CP_GATED="$gated $head" P03_CP_CAS_LOSSES=$cas_losses \
    P03_CP_FINAL_PREPARED=$final_prepared P03_CP_ROUNDS=$rounds exec bash "$SELF" "${ARGS[@]}"
}
requeue_after_full_gate() {
  unlock
  P03_GATE_PRIOR=${1:-} check_gate "$now"
  head=$now
  gated=$commit
  resume_frozen_packet
}
final_prepared=${P03_CP_FINAL_PREPARED:-0}
entry_admission_incomplete() {
  printf 'commit gate incomplete (tree entry loads): {"code":"entry-load-admission-unavailable","status":%s}\n' "$1"
  exit 11
}
declaration_admission_incomplete() {
  printf 'commit gate incomplete (package declarations): {"code":"declaration-comparison-incomplete","reason":"admission-unavailable","status":%s}\n' "$1"
  return 11
}
run_final_declaration_phase() {
  local launcher=$1 projects=$2 entry_projects=$3 resource_class=gate-declaration-comparison
  local status=()
  # Own the child's scratch outside the lease being watched. The admission
  # broker can terminate its whole process group before the child's EXIT trap.
  gateScratch=$(mktemp -d "${TMPDIR:-/tmp}/p03-gate-final.XXXXXX") || { declaration_admission_incomplete 75; return 11; }
  (
    export TMPDIR=$gateScratch P03_CP_DECLARATION_PHASE=1
    # Serial checks share one grant and learn from the combined project set.
    if [ -n "$entry_projects" ]; then
      export P03_CP_ENTRY_PHASE=1
      resource_class=gate-final-recheck
      projects+=$'\n'$entry_projects
    fi
    "$launcher" --heavyweight-admission "--class=$resource_class" --machine=local "--projects=$projects" \
      --identity-arg=node --identity-arg=scripts/workspaces/commitGateTypecheck.mjs \
      -- bash "$SELF" "${ARGS[@]}"
  ) 9>&- | awk '
    /^HAPPIER_DECLARATION_COMPARISON_INCOMPLETE / {
      sub(/^[^ ]+ /, "")
      print "commit gate incomplete (package declarations): {\"code\":\"declaration-comparison-incomplete\",\"stall\":" $0 "}"
      stalled = 1
      fflush()
      next
    }
    { print; fflush() }
    END { if (stalled) exit 11 }'
  status=("${PIPESTATUS[@]}")
  cleanup_gate
  if [ "${status[1]}" = 11 ]; then return 11; fi
  case ${status[0]} in
    0|3|10|11|130|143) return "${status[0]}";;
    *) declaration_admission_incomplete "${status[0]}";;
  esac
}
# Reserve for the frozen packet's reachable set while the lock is free.
# The gate narrows both comparisons to the actual new commits after locking.
admit_final_phase() {
  [ "$entry_phase:$declaration_phase" = 0:0 ] && [ "$cas_losses" -ge 2 ] || return 0
  [ "$(git rev-parse HEAD)" != "$head" ] || return 0
  local entry_projects declaration_projects launcher=$tooling/apps/stack/bin/hstack-exec rc=0
  [ ! -x ./apps/stack/bin/hstack-exec ] || launcher=./apps/stack/bin/hstack-exec
  entry_projects=$(node "${P03_COMMIT_ENTRY_LOADS:-$tooling/scripts/workspaces/commitTreeEntryLoads.mjs}" --select --base "$head" --tree "$gated") || entry_admission_incomplete "$?"
  declaration_projects=$(node "$tooling/scripts/workspaces/commitGate.mjs" --select-declarations "--base=$head" "--tree=$gated") || {
    declaration_admission_incomplete "$?"
    exit 11
  }
  [ -n "$entry_projects$declaration_projects" ] || return 0
  while [ "$(git rev-parse HEAD)" != "$head" ]; do
    rc=0
    export P03_CP_FROZEN=$packet P03_CP_GATED="$gated $head" P03_CP_CAS_LOSSES=$cas_losses
    export P03_CP_FINAL_PREPARED=$final_prepared P03_CP_ROUNDS=$rounds
    if [ -n "$declaration_projects" ]; then
      run_final_declaration_phase "$launcher" "$declaration_projects" "$entry_projects" || rc=$?
    else
      "$launcher" --heavyweight-admission --class=gate-entry-loads --machine=local "--projects=$entry_projects" \
        --identity-arg=node --identity-arg=scripts/workspaces/commitTreeEntryLoads.mjs \
        -- bash -c 'export P03_CP_ENTRY_PHASE=1; exec bash "$@"' commit-entry-phase "$SELF" "${ARGS[@]}" 9>&- || rc=$?
    fi
    unset P03_CP_FROZEN P03_CP_GATED P03_CP_CAS_LOSSES
    unset P03_CP_FINAL_PREPARED P03_CP_ROUNDS
    case $rc in
      0|11|130|143) exit "$rc";;
      10) exit 1;;
      3)
        if [ "$final_prepared" -eq 1 ]; then final_recheck_incomplete; fi
        final_prepared=1
        now=$(git rev-parse HEAD)
        replay_onto_now
        local prior=$gated
        if both_sides_deps; then prior=; fi
        P03_GATE_PRIOR=$prior check_gate "$now" final
        head=$now; gated=$commit
        ;;
      *) entry_admission_incomplete "$rc";;
    esac
  done
}
locked_recheck() {
  local rc=0 t0=$SECONDS prior=$gated final_entry_recheck= final_declaration_recheck=
  while :; do
    replay_onto_now
    if [ "$cas_losses" -ge 2 ]; then
      echo "two CAS losses; final scoped recheck under the commit lock"
      if [ "$entry_phase" = 1 ]; then final_entry_recheck=1; fi
      if [ "$declaration_phase" = 1 ]; then final_declaration_recheck=1; fi
    fi
    if both_sides_deps; then
      prior=
      rc=3
      echo "both sides edited a package manifest or the lockfile"
    else
      rc=0
      P03_SCAN_CHEAP_ONLY=1 P03_GATE_PRIOR=$prior P03_GATE_FINAL_ENTRY_RECHECK=$final_entry_recheck \
        P03_GATE_FINAL_DECLARATION_RECHECK=$final_declaration_recheck \
        rungate "$GATE" "$now" "$commit" || rc=$?
    fi
    case $rc in
      0) gated=$commit; head=$now
         echo "recheck accepted in $((SECONDS - t0)) s (under the commit lock)"
         return;;
      10) echo "candidate refused by the gate; abort"; exit 1;;
      11) echo "candidate gate incomplete; no ref changed"; exit 11;;
    esac
    echo "recheck needs the full path (exit $rc); releasing the commit lock"
    if [ "$cas_losses" -lt 2 ]; then requeue_after_full_gate "$prior"; fi
    unlock
    # Preparation must release the broker grant before it queues.
    if [ "$entry_phase:$declaration_phase" != 0:0 ]; then packetDir=; exit 3; fi
    if [ "$final_prepared" -eq 1 ]; then final_recheck_incomplete; fi
    final_prepared=1
    P03_GATE_PRIOR=$prior check_gate "$now" final
    head=$now
    gated=$commit
    lock
    now=$(git rev-parse HEAD)
    if [ "$now" = "$head" ]; then return; fi
    prior=$gated
    t0=$SECONDS
  done
}
# Installs replace the file by mv (LANE-RULES). A new inode means new rules; carry the existing gate and packet.
reexec_if_replaced() {
  [ -n "$SELF_ID" ] && [ "$(stat -c '%d:%i' "$SELF" 2>/dev/null || true)" != "$SELF_ID" ] || return 0
  echo "commit-partial: the installed wrapper changed; re-running it with the same arguments"
  resume_frozen_packet
}
rounds=${P03_CP_ROUNDS:-0}
reexec_if_replaced
# Losing the accepted HEAD before CAS still costs the packet one recheck.
# Admission children inherit a loss already counted by the outer wrapper.
head_loss_counted=0
if [ "$entry_phase:$declaration_phase" = 0:0 ] && [ "$(git rev-parse HEAD)" != "$head" ]; then
  cas_losses=$((cas_losses + 1))
  head_loss_counted=1
fi
admit_final_phase
lock
now=$(git rev-parse HEAD)
if [ "$now" != "$head" ]; then
  rounds=$((rounds + 1))
  if [ "$entry_phase:$declaration_phase" = 0:0 ] && [ "$head_loss_counted" -eq 0 ]; then
    cas_losses=$((cas_losses + 1))
  fi
  if [ "$entry_phase:$declaration_phase" = 0:0 ] && [ "$cas_losses" -ge 2 ]; then
    unlock; admit_final_phase; lock
    now=$(git rev-parse HEAD)
  fi
  if [ "$now" != "$head" ]; then locked_recheck; fi
fi
while ! git update-ref -m "commit-partial: pid $$ $(head -1 "$msg" | cut -c1-80)" "refs/heads/$branch" "$commit" "$head"; do
  now=$(git rev-parse HEAD)
  if [ "$now" = "$head" ]; then
    echo "commit-partial: update-ref failed without a HEAD move; no ref changed; inspect the Git error above"; exit 75
  fi
  echo "CAS lost to a commit outside the wrapper (reflog: $(git reflog -1 --format=%gs "refs/heads/$branch" 2>/dev/null | cut -c1-80)); replaying the frozen packet"
  cas_losses=$((cas_losses + 1))
  rounds=$((rounds + 1))
  if [ "$entry_phase:$declaration_phase" = 0:0 ] && [ "$cas_losses" -ge 2 ]; then
    unlock; admit_final_phase; lock
    now=$(git rev-parse HEAD)
  fi
  if [ "$now" != "$head" ]; then locked_recheck; fi
done
unlock; publish_head_cache "$commit" || echo "gate cache: could not publish HEAD seed" >&2; echo "COMMITTED $commit parent $head (after $rounds recheck round(s))"
{ git show --stat --format="%h %s" "$commit" | head -40 || true; }
register_new_paths; kick; exit 0
