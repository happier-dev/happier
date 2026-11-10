# WAITER-MEMORY-1110

## Verdict

DONE — ROOT fix implemented; regression GREEN. Broad validation remains red
with every failing group reproduced against the pre-change broker.
Production adoption needs orchestrator-managed broker succession; no running
broker or worker was restarted by this lane.

## Deliverables and owner

- `apps/stack/scripts/utils/proc/admission_broker.mjs`: the existing memory
  sampler receives queued client PIDs and credits their exact proportional
  resident pages once, excluding descendants and already admitted trees.
- `apps/stack/scripts/utils/proc/admission_memory.mjs`: host availability receives
  the credit before the existing jobs-cgroup headroom clamp, capped by MemTotal.
- `apps/stack/scripts/native_admission_waiter_memory.test.mjs`: real native
  launcher → client → broker count regression, FIFO completion, and attribution
  controls for duplicate PIDs, descendants, admitted trees and unavailable PSS.
- Existing native fixture forwards queued PIDs and substitutes physical pages
  at its established OS boundary. Existing service-memory tests cover cgroup
  headroom and the physical-memory ceiling with waiting-client credit.
- `docs/testing.md`: current 0.3 development semantics and retained-broker adoption.

## Deciding evidence

Observed RED, constructed OS-memory pressure through real native processes:
4 queued clients × 70 MiB = 286720 KiB attributed waiting memory.
Before: availableMemoryKiB 3145728 → 2859008; regression failed on that difference.
GREEN: 3145728 → 3145728 with the same four waiting clients; FIFO completion passes.
This selects the brief's accounting option: Node clients remain resident.
The test substitutes physical pages, not broker decisions or queue state.

All deciding commands used `./apps/stack/bin/hstack-exec --local -- node --test`.
Logs under `.project/tmp/WAITER-MEMORY-1110/`:
- `validation.log`: native regression, broker, client, service-memory,
  host-global admission and full preferred_execution_launcher suites.
  Terminal: 382 tests; 354 pass, 24 fail, 2 cancelled, 2 skipped.
- `baseline.log`: four host-global failure groups and two launcher failure
  groups reproduce with the pre-change broker; 10 fail, 2 cancelled.
- `baseline-additional.log`: remaining eleven launcher failure groups reproduce
  with the pre-change broker and memory owner; 11 fail.
- `baseline-client.log`: the remaining client queue-reporting group reproduces
  with the pre-change broker; immediate passes, queued/older-broker fail with
  HSTACK_CPU_BUSY (3 failures counting their parent group).
- `owner-green.log`: not run; preparation failed with BUILD_INPUTS_CHANGED.
- `owner-green-retry.log`: completed after preparation retry; 79 tests,
  74 pass, 3 fail (the same baseline client group), 2 skipped.
  Native count/FIFO/attribution tests, broker suite and service-memory suite pass.

The test observation waits for a sample after writing physical pressure, so a
previous catch-up cannot produce a false GREEN. No TypeScript changed; Stack's
plain-MJS owners were loaded by their native test suites. No compiler lane applies.

## Corridor and self-review

Canonical ownership remains broker sampling plus the existing Linux OS-memory
adapter. Native shell admission, JS admission, and workspace-build callers all
reach that broker; none receives a second accounting decision. Arrival ordering,
no-wait semantics and FINDING 5's retained selected-worker wait are unchanged.
Same-shape sweep: queued-client pressure — one broker sampler fixed; its native
fixture was updated. Read-only sample/check consumers retain the broker's result.
Self-review added coverage preventing credit from bypassing the jobs cgroup and
preventing stale fixture observations from satisfying the count assertion.
Net mechanisms: +1 waiter-memory diagnostic / −0; +1 PSS validity predicate / −0;
+0 lifecycle states, error codes, timers or retries / −0; files +2 / −0.
The diagnostic explains the measured feedback loop at the existing capacity owner.
Other shared edits and inherited staging were preserved; private-index commit only.

## Residual risk and rollout

- Live worker memory was not remeasured: incumbent brokers were deliberately
  retained. Orchestrator succession is required to load this fix on workers.
- Linux: real local launcher/client/broker processes validated with constructed
  OS-memory pressure; inaccessible PSS conservatively receives zero credit.
- Windows Git Bash: standalone non-Linux path, real guest not validated.
- Windows WSL: Linux broker path, actual WSL guest not validated.
- macOS guest: standalone non-Linux path, real guest not validated.
- Broad-suite failures and two cancellations remain outside this patch; baseline
  reproductions establish they do not require this fix. This is not whole-Stack green.
