BLOCKED — #175 native guest pairing uses the shared repo-dev Home origin; owner P03-HOME-IDENTITY must repair the descriptor before the guest-dependent cells can complete.

## Basis and ownership

- Reload: #175 `80b81aa45db`, `agent-qa-servers-deploy`, daemon `tree-daemon-0f0abe4b`.
- Assigned identity: `qa-sd-c2` (ORCH-TOP READY at 10:04Z). I did not start, stop, or reload the stack. The earlier `qa-sd-j` probe was deleted and is not credited because ORCH-TOP assigned it to ROWS-FLEET-176.
- Fresh c2 acquire: provisioner check and Docker/image options passed. Acquire accepted `cmwlz411c08d7iemc2daymmrw`, then operation `5519cad4-699b-44b6-8a78-0b86ffc83ae6` failed at `ssh.auth.wait` with `home_not_guest_reachable`; the typed details identify the shared repo-dev Home origin and unavailable HTTPS carrier. The product delete action settled and `machines.managed.get` verified `allocation: confirmed-absent`, `observation.availability: absent`.
- Canonical owner handoff: P03-HOME-IDENTITY owns the Home descriptor. MACH-SANDBOX-GENERIC-1115 owns the guest-reachability route only if the descriptor fix leaves a reachability gap. ORCH-TOP confirmed the split on the main board at 10:19Z.

## Cell sweep

| Cell | State | Basis revision | Evidence |
|---|---|---|---|
| C30 J20b | BLOCKED: fresh guest cannot pair | `80b81aa45db` | `c2-operation-snapshot.json`; prior setup context in `MACH-REPLAY-A1-1117.md` |
| C52 J42/S0-02 | BLOCKED/PARTIAL: provisioner check/options pass, acquire stops before enrollment | `80b81aa45db` | `c2-check.json`, `c2-options.json`, `c2-operation-snapshot.json` |
| C87 DJ01/DJ02 | BLOCKED/PARTIAL: same guest prerequisite as C52 | `80b81aa45db` | `c2-operation-snapshot.json`; no second owner path added |
| C88 DJ01 isolation error | BLOCKED: no genuine isolation failure can be created without an enrolled guest | `80b81aa45db` | `c2-operation-snapshot.json` |
| C56 J46 | BLOCKED: matching-runtime file/inline/exit23 replay cannot reach guest | `80b81aa45db` | `c2-operation-snapshot.json`; prior partial replay `MACH-REPLAY-A1-1117.md` |
| C101 F26 | BLOCKED: delegated/Home replay shares the same pairing prerequisite | `80b81aa45db` | `c2-operation-snapshot.json`; prior partial replay `MACH-REPLAY-A1-1117.md` |
| C62 J52 | BLOCKED: restore canaries and restored-service read require a guest | `80b81aa45db` | `c2-operation-snapshot.json`; prior restore partial in `MACH-REPLAY-A1-1117.md` |
| C65 J55 | BLOCKED: recovery-before-network proof requires a recoverable enrolled guest | `80b81aa45db` | `c2-operation-snapshot.json`; prior partial in `MACH-REPLAY-A1-1117.md` |
| S-UPDATE | BLOCKED: retained-controller update cannot start | `80b81aa45db` | `c2-operation-snapshot.json` |
| S-BOOTSTRAP | BLOCKED: fresh bootstrap cannot reach pairing | `80b81aa45db` | `c2-operation-snapshot.json` |
| S-CLONE | BLOCKED: public clone needs a reachable native guest | `80b81aa45db` | `c2-operation-snapshot.json` |
| S-STALL | BLOCKED: native lifecycle observation cannot be established | `80b81aa45db` | `c2-operation-snapshot.json` |
| C14 J05 Action leg | BLOCKED before native installation settlement | `80b81aa45db` | prior partial `MACH-REPLAY-B-1117.md`; current pairing blocker |
| C38 J28 Action leg | BLOCKED before guest session lifecycle | `80b81aa45db` | prior partial `MACH-REPLAY-B-1117.md`; current pairing blocker |
| C40 J30 Action leg | BLOCKED before two-guest custody proof | `80b81aa45db` | prior partial `MACH-REPLAY-B-1117.md`; current pairing blocker |
| C60 J50 Action leg | BLOCKED before interactive native guest turn | `80b81aa45db` | prior partial `MACH-REPLAY-B-1117.md`; current pairing blocker |
| C61 J51 Action leg | BLOCKED before appended-log native push | `80b81aa45db` | prior partial `MACH-REPLAY-B-1117.md`; current pairing blocker |
| C71 J61 Action leg | BLOCKED before app/compose native repair | `80b81aa45db` | prior partial `MACH-REPLAY-B-1117.md`; current pairing blocker |

## Validation and residual risk

- Focused owner suites passed locally through `hstack-exec --local`: 4 files, 53 tests. Evidence: `.project/tmp/BL-HEADLESS-NATIVE-1118/focused-tests-local.log`.
- The routed duplicate submission was interrupted while queued and is explicitly not run. No package typecheck/build was claimed because the shared integration wave was occupied by unrelated work.
- No production source change was made. The current failure is a descriptor/identity-owner issue, so adding a native-lane workaround would create a split brain. No new timers, retries, states, guards, or protocol changes were added.
- Fixture cleanup passed for both probes. The first `qa-sd-j` probe and the assigned `qa-sd-c2` probe were deleted through `machines.managed.delete` and verified absent.
- Re-run all 18 cells after P03-HOME-IDENTITY posts the descriptor fix and ORCH-TOP provides a new loaded basis. C56/C101 still require the specified file/inline/exit23 plus delegated/Home replay, C62/C65 require their full recovery/restore legs, and C88 still requires a genuine isolation prerequisite failure.
