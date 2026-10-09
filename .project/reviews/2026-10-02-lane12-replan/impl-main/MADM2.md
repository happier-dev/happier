# MADM2 — remote preparation admission deadlock

## Outcome

Fixed the second remote admission/dist-lock cycle at both canonical POSIX dispatch adapters. Remote dependency bootstrap remains unadmitted; remote workspace validation preparation now reserves the existing `compilation` heavyweight envelope before it can take a workspace dist lock, releases that envelope, and only then admits the requested payload.

This is the smallest systemic lock-order correction: it reuses the existing admission owner, the existing maximum compiler class, and existing reentrant nested admission. It adds no timeout, lease, watchdog, capacity, or parallel decision-maker.

## Ownership and affected paths

- Canonical native dispatcher: `apps/stack/bin/hstack-exec`.
- Canonical explicit POSIX command builder: `apps/stack/scripts/utils/dev_targets/remote_commands.mjs`.
- Regression owner: `apps/stack/scripts/remote_preparation_admission.test.mjs`.
- Dependency bootstrap deliberately stays outside admission because it can itself wait on dependency-refresh locks whose holders need admission.
- Workspace preparation is admitted because it can own workspace dist locks while invoking reentrant package compilers.
- Payload admission remains separate and begins only after preparation has released its locks and envelope.
- Local execution and the Windows command builder are unchanged; the observed cycle and heavyweight admission implementation are POSIX-target paths.

No competing remote POSIX preparation path was retained: the native shell dispatcher and explicit JavaScript builder now enforce the same order. Payload-specific dependency declarations alone were rejected because workspace preparation can build hidden/transitive dist dependencies for multiple command classes, not only the observed docs payload.

## RED → GREEN evidence

Focused command (remote, serialized):

`./apps/stack/bin/hstack-exec --target=mac3-linux -- node --test --test-concurrency=1 apps/stack/scripts/remote_preparation_admission.test.mjs`

- RED, with the production ordering hunks temporarily absent: exit 1; 5 tests, 3 passed, 2 failed. Both the native and explicit real-lock cases failed with `workspace dist preparation reached its lock before heavyweight admission`. The dependency-bootstrap cases remained green.
- GREEN, after restoring the implementation: exit 0; 5 tests passed, 0 failed (about 17 seconds).
- Static validation on the final bytes: `/bin/sh -n apps/stack/bin/hstack-exec` passed; `git diff --check` for the three implementation/test files passed.

The new test uses the real `withWorkspaceBundleLock` owner and covers both remote command-construction paths. It also updates the prior lock regression to prove dependency bootstrap—not workspace preparation—remains before admission.

## Broader validation limitation and live-cycle evidence

An adjacent six-file test batch on `mac3-linux` and a subsequent focused rerun attempt on `mac2-linux` could not reach the test payload because pre-fix remote invocations were still cycling in preparation/admission queues. I cancelled only this lane's waiting controllers (exit 130) and did not terminate or modify any other process.

Observed on mac3: validation preparation waited on a workspace dist lock while admitted compilation owners `3591495` and `3624323` remained at approximately zero CPU for more than 850 seconds. Observed on mac2: the queue remained at 22 with the admission envelope exhausted (`18874368/18874368 KiB`), behind validation owners `1665803` and `3908028`, approximately 6,300 and 3,700 seconds old with near-zero CPU. Main must retire those already-running pre-fix cycles if broader validation is to proceed immediately.

This does not invalidate the completed focused GREEN run; the final code and discriminating test bytes are the same revision that passed. The broader adjacent batch is explicitly not claimed as passed.

## Rollout and residual risk

The changed dispatcher scripts are Mutagen-synced to the remote checkout. A running process keeps the script and lock order it already loaded; the fix is picked up by the next invocation after sync. Existing pre-fix cycles are therefore not self-rewritten and may require Main's process handling.

Adversarial check: a docs-only dependency declaration would leave other hidden dist-build entry points vulnerable; moving all setup under payload admission would recreate the dependency-lock cycle; and admitting preparation with a smaller class could let nested compilers require an upgrade while holding a dist lock. The selected existing maximum `compilation` envelope avoids those neighboring failures without new machinery. Residual risk is limited to the broader adjacent suite not completing while the remote workers retain old live cycles.

STATUS: DONE
