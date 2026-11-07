FIXED: remote relay observation performs zero Mutagen operations; overall Stack info latency remains high.

The new regression tests pass on both transport branches. The adjacent executor
suite passed 30/32 tests: two source-test preparation-mode assertions failed.
The live command returned successfully before and after the correction.

Observed cause and correction

- `hstack.mjs` → `stack.mjs` → `stack_commands.mjs#cmdInfo` →
  `stack_info_snapshot.mjs#readStackInfoSnapshot` →
  `server/infra/iroh/runtime.mjs#inspectStackRelay` →
  `placement.mjs#inspectRelayOnTarget` → `executor.mjs#runDevTargetCommand` →
  `prepareDevTargetSourceCommand` → private `flushDevTarget` → native control
  helper → `mutagen sync flush`. This was not `flushDevTargetSync`.
- The relay placement owner now declares inspection source-independent through
  `sourceAdmission: 'skip'`; the existing executor skips source admission while
  retaining its command, cancellation and platform transport owners.
- `dev_targets.mjs` browser start reads this same snapshot to resolve its URL;
  `qa_browser_signin.mjs` and `doctor.mjs` also reach the corrected observation.
  Explicit browser URLs bypass snapshot resolution. Local relay status uses the
  existing local inspection owner and does not reach this transport.
- Relay preparation retains automatic source admission and one flush. Ordinary
  execution and restart barriers remain unchanged. Remote source-runtime probes
  already use direct SSH observation without this executor flush.

Loaded timing evidence (seconds; agent-qa-providers, source-snapshot)

| Phase | Before | After |
| --- | ---: | ---: |
| Complete command, rc 0 | 137.162 | 135.148 |
| Child startup to first OS probe | 42.783 | 45.536 |
| Concurrent remote source probes, longest SSH interval | 30.144 | 34.131 |
| Mutagen readiness list | 0.698 | 0 |
| Mutagen flush | 18.711 | 0 |
| Relay SSH operation, including remote execution | 40.989 | 51.463 |
| Actual Mutagen flush count | 1 | 0 |

These are observed intervals, not a claim that all SSH time is network latency
or all startup time is CPU work. Intervals overlap and omit small local probes.
Both results contained a ready relay. Observed placement was server nl3/daemon
nl1, differing from the brief's earlier all-nl3 placement. The 2.014-second total
difference does not establish a general speedup. Source startup and remote source
execution remain the dominant follow-up investigation.

Verification and evidence

- Constructed RED: the real relay observation/placement/executor path performed
  two Mutagen captures instead of zero on POSIX and Windows targets (2/2 failed).
- Constructed GREEN: the same two tests passed; live host inspection still ran,
  and the preparation positive control retained exactly one source flush.
- Native test command: `./apps/stack/bin/hstack-exec -- node
  --conditions=happier-source --import ./apps/stack/bin/localSourceRuntimeBootstrap.mjs
  --test apps/stack/scripts/utils/server/infra/iroh/placement.test.mjs`.
- Existing executor suite: 30 passed, 2 failed, 0 cancelled. The failures expect
  `--validation-kind=source-test` for arbitrary apps/cli Vitest commands, while
  the current classifier selects runtime. Neither fixture uses the added test
  paths or inspection policy. No unrelated test expectation was changed.
- Deciding terminal projections and child-process trace are retained under
  `.project/tmp/stack-info-read-flush-1107/` (red-source.log, green.log,
  adjacent.log, phases.jsonl). Scratch preloader recorded names/timing/stacks,
  without arguments, environment or payloads; no instrumentation was shipped.
- Initial timing attempts encountered Protocol schema initialization failure;
  the later loaded measurements succeeded without Protocol edits in this lane.
  Two initial misclassified validation launches remain queued and are not used
  as RED/GREEN evidence. No TypeScript changed; native import/test loads apply.
- Own-path diff whitespace check passed. The full producer closure has an
  existing extra blank line at tailscale_serve.mjs EOF, preserved unchanged.

Delivery and mechanism delta

- Own hunks: executor inspection admission, relay placement policy, regression
  test, native source-test registration, this report and Stack documentation.
- Commit includes the pre-existing untracked Iroh producer modules and
  tailscale_serve.mjs needed by the relay imports, as the minimal source closure;
  those modules' broader feature implementation is existing work, not this fix.
  Other tracked concurrent hunks are excluded through a private index.
- +1 explicit executor admission option and +1 non-required internal result;
  −1 readiness check and −1 flush per remote observation. +1 test file, +1 report;
  no new timers, retries, error codes, persisted state or dependencies.

Residual risk: overall info latency remains about 135 seconds. Windows transport
was constructed, not exercised on a native Windows host. Full browser startup
was not run; its shared URL-resolution caller was traced. Separately, remote
daemon status still reaches the unconditional flush in remote_stack_operation.mjs;
Systemic should address that independent dispatcher. The two adjacent failures
and unrelated queued validation launches remain visible rather than claimed green.
