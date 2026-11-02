STATUS: DONE
Orchestrator summary: mac-host transport restored; case-only source filenames were the cause, not a rogue writer.
T-U5-LOGIC renamed the presentation module; canonical Mutagen flush and normal read-only transport passed.
Prevention assessed: no small existing validation hook covers files added during an active continuous sync; no new machinery added.

## Observed cause and writer identity
- Controller had two different, untracked files in `apps/ui/sources/components/workflows/navigation/`: `WorkflowNavigation.tsx` (6,440 bytes) and `workflowNavigation.tsx` (7,212 bytes). Beta held 7,212 bytes. Case-insensitive APFS aliases those paths; the second source filename explains the apparent recreation and create/file-exists error.
- T-U5-LOGIC confirmed the case collision and renamed the presentation module atomically to `WorkflowNavigationViews.tsx`, updating five importers (board REPLY 2026-11-02 14:28 UTC). This lane made no UI source edits and does not claim the UI owner's validation.
- Canonical session: `sync_fwDXUMgB8O0PXv48GOAGaNhiRRCFgWyHddOLeEyxD01`, `happier-mac--host`, one-way-replica; controller checkout → `happier-dev-target-mac-host:/Users/leeroy/.happier-stack/workspace-mirror/0.3`.
- Canonical daemon PID 47785 owns `repo-dev-a1cc5e0671/mutagen/data/daemon/daemon.sock`. Controller SSH PIDs 760867, 47919 and 336178 all have parent 47785; their TCP connections map respectively to Mac agents 11154, 68769 and 74799.
- Pausing only the exact canonical session removed Mac agent 74799; the other two agents remained. No agent was killed, and no Simulator, Metro or database was changed.
- Mac staging dirs `sync_MMDIGUkaHz8Lhpmk2MR2BWgJiWzdru0A63fIhxSNn2l-beta`, `sync_bMbZW6n1MXW4xswxcIRIeVs2Es4IxsLoWCQLER6EIbj-beta`, `sync_0LLFX5EJwCDrFMxPtd7C970HEZ3cjt2UxRz7Lf51dI3-beta` have October 28 directory mtimes, no matching canonical live session, and no observed live staging-file holder. Historical controller ownership was not established; these are not evidence of another live writer.
- Mac-local session inventory showed dev→windows/mac/mac2 paused and remote-dev→windows active; none targets the affected mirror. Controller default daemon had zero sessions. The canonical daemon has only one session targeting this exact beta path; its other mac-host sessions target 0.2 and pr640-native.
- `fs_usage` requires root and noninteractive sudo was unavailable. Permitted one-second stat observation for 65 seconds after quarantine, while the canonical session was paused, recorded the path absent throughout.

## Recovery and retained copies
- Copied both beta files before recovery to `~/.happier/mac-mirror-quarantine-1102/WorkflowNavigation.tsx.mac-142554` and `sendSessionMessage.ts.mac-142554` on the Mac; also moved the aliased navigation entry to `WorkflowNavigation.tsx.removed-142554`. Earlier orchestrator quarantine is retained.
- After the UI owner's rename, resumed only the same canonical session and completed `mutagen sync flush` (exit 0). The staged chmod issue required no manual permission change; it is absent after convergence.
- Read-only hash comparison observed controller=Mac for `WorkflowNavigationViews.tsx` (6,460 bytes), `workflowNavigation.tsx` (7,327 bytes after the owner's concurrent edits), and `apps/cli/src/session/services/sendSessionMessage.ts` (114,477 bytes).
- Normal transport: `./apps/stack/bin/hstack-exec --target=mac-host -- python3 -c 'import os; print("MAC_HOST_TRANSPORT_OK",os.getcwd())'` exited 0 and printed the expected mirror cwd, with its own successful causal sync flush (14:29:24Z).
- Follow-up structured session inspection at 14:31:26Z: paused=false, alpha/beta scanProblems=[], alpha/beta transitionProblems=[]. Session status scanning is normal active convergence, not a terminal failure.
- The navigation quarantine is an alias artifact and may be discarded by its owner; per orchestrator instruction this lane leaves every quarantine copy in place.

## Prevention assessment
- Searched scripts, Stack utilities, CI configuration and root scripts for case-only/case-insensitive/casefold/path-collision checks; no existing source-filename collision owner was found. Existing matches concern command/path normalization or Mutagen state, not source-name validation.
- Root `package.json` `lint:local` invokes oxlint; `apps/stack/scripts/lint.mjs` delegates to that policy. Neither exposes an existing repository pathname-inventory hook. Adding a separate repository checker and root-script wiring would establish a new owner, rather than extend an existing source-path validator.
- `apps/stack/scripts/utils/dev_targets/replica_source_bytes.mjs:12` already enumerates authored tracked/untracked inputs, but only to measure preparation bytes. `sync_project.mjs:334` owns project preparation and `:398` checks replica destination safety, not each later source arrival. A check there cannot prevent this reproduced mid-session creation.
- The continuously running Mutagen process observes source changes independently of a later read-only transport flush. A controller-wide inventory on each transport call would run after source could already reach beta and add per-request full-tree work; a new watcher/interception hook exceeds the explicitly authorized small existing-owner check. Therefore no guard was implemented; the user-authorized report fallback is taken.

## Validation, ownership and residual risk
- Operational recovery only: exact-session pause/resume/flush, 65-second stat observation, three controller/beta byte comparisons, structured clean session inspection, and canonical read-only mac-host transport all ran successfully.
- Inventory caveat: Mutagen status queries can start idle per-stack daemons when stale daemon sockets exist. Controller inventory observed newly started empty daemons; no sessions were created or changed there, and none was killed under the writer-only instruction.
- No production behavior changed in this lane; RED/GREEN, package typechecks and entry-loads were not run for its report/board-only commit. T-U5-LOGIC owns the mechanical UI rename and its source commit/validation.
- Self-review falsifier: the apparent writer could have been another controller; all three live agent connections instead traced to canonical daemon 47785, and quarantine remained absent while its exact session was paused. Distinct module names then converged and the real transport succeeded.
- Net mechanism delta in this lane: checks +0/−0, states +0/−0, errors +0/−0, timers +0/−0, retries +0/−0, production files +0/−0. One requested report and two addressed board posts document diagnosis/recovery; no runtime guard was added.
- Residual risk: future case-only filenames can recur until a suitable source-validation owner exists. No guarantee was added against continuous-sync source collisions. Historical abandoned staging ownership remains unknown and irrelevant to the proven active path. Quarantine copies intentionally remain.
