# PERF-E2E journey capture (development tooling)

Use the existing UI performance audit entry point. Its `journey` and `compare`
modes delegate cross-process capture to this Stack-owned directory. The older
UI stress scenarios remain available through that entry point; both modes use
the same CDP transport and sync telemetry report owner.

## CI and local regression reporting (0.3 development)

`node scripts/pipeline/run.mjs perf-validate --baseline-ref <ref> --profile pr --out <new-directory>`
runs the same capture owner against the existing `packages/tests` isolated
full-compose stress environment and deterministic synthetic Account. The
candidate driver and comparison checkouts use their own dependencies; they do
not reuse a live stack's dependency tree, database, credentials or Agent accounts.
Current/directory bases use the existing runtime authored-input inventory plus
the stress testkit/fixture inputs for their private source capture. Git-free
worker mirrors leave source SHA and dirty status unavailable in the comparison; such a
capture cannot supply a trusted clean exact-SHA baseline artifact. Explicit
historical Git refs still require an actual Git checkout.
Private installation is followed by canonical workspace dependency builds for
the stress driver and CLI before UI export or resource startup; an installed
workspace link alone does not supply its compiled JavaScript exports.
The source-web export owner prepares UI once per side. Existing exports may be
supplied with `--baseline-ui-dir` and `--candidate-ui-dir`. The existing stress
driver reuses its own environment per side across ordered captures, with a fresh
browser each time; it never borrows a live stack's dependencies. Stateful journey
effects remain part of that declared fixed sequence, not a claim of dataset reset.

CI consumes `--baseline-results-dir <directory>` only for a trusted successful
`dev`/`main` push artifact at the exact PR base SHA. The directory contains the
same `comparison.json` and relative canonical `runs/.../candidate/bundle.json`
files, not executable artifact code. Counts/bytes can compare across hosts;
historical timing is explicitly not a same-host paired ratio. With no exact-base
artifact, `--candidate-only` records all candidate observations and labels the
baseline unavailable; it does not rebuild the base or substitute a latest result.

`comparison.json` and `comparison.md` retain available counts, payload bytes,
timings, post-GC heap slope, backend/process observations and production JS/CSS
bytes. CI appends that same Markdown to its job summary and retains profiles.
Unavailable data stays explicitly unavailable, and noisy observations are labeled.
Scenario observations are informational; they do not fail releases or require
sign-off. Only owner-level contracts that reject an intentional real regression
and pass ten unchanged target-runner repeats may gate in the existing test jobs.
SQL counts and scheduler-sensitive whole-app counts remain diagnostic.

The fixed short PR profile has two counts-only captures: authenticated startup
and another Session streaming while unrelated content is mounted (four captures
for a local paired run). Only full-profile J1 startup collects five unperturbed
timing repetitions per side. The full
profile also covers cold startup, settled Home, New Session, exact Inbox approval
and the real Stop control. Docker/composed validation is authorized on nl1;
successful browser end-to-end execution and completed-step runtime remain
unverified. The observed unsuccessful cold PR step took 62.26 minutes, dominated
by UI export, so the five-minute cold target is not met. This documentation does
not claim CI has executed the new scenario integration.

The orchestrator owns `agent-qa-perf` lifecycle. This tool attaches to the
browser returned by `dev-targets browser start`; it never launches a browser,
server, daemon, Expo or Metro. Retain the browser command's TTY handle and send
it SIGINT after the round, then verify its terminal cleanup result.
Close the controller's matching `agent-browser --session <lane> --cdp <endpoint>
close` session too; warm repetitions may deliberately reuse it within the round.

```sh
node apps/ui/scripts/perf/agentBrowserUiPerfAudit.mjs journey J13 \
  --session=P0-H --cdp=http://127.0.0.1:PORT --url=RETURNED_BROWSER_URL \
  --home-selector='[data-testid="session-list-view-options-trigger"]' \
  --cache=warm --ui-mode=export --capture-mode=counts --out=.happier/qa/perf/P0-H/J13-warm-1
```

Use the current loaded Home's stable test ID if its composition differs from
that example. `--page-id=ID` is required when CDP has several page targets. Each
output directory must be new. A cold J1 needs a freshly launched, anonymous QA
browser; this tool does not delete authentication or Account state to reset it.
Validate restore with dummy stdin first. Then feed the approved dev test key
straight from its file into the command with shell stdin redirection and
`--restore-stdin`; never put the value in arguments, environment, a JSON batch,
an agent-browser fill command, or evidence. The restore subprocess is adapted
from the approved providers audit helper, suppresses locator diagnostics and
clears the field on failure. J1 warm measures authenticated reload and skips
restore. Recreate only the owned QA browser between cold repetitions.

`J13` prepares authenticated Home outside its window, then records exactly five
minutes without interaction. Cold means the browser HTTP cache is disabled and
cleared; it does not imply an empty server cache or database. Warm leaves the
browser cache enabled. Neither mode changes freshness, approvals or revocation.

Every journey explicitly selects `--capture-mode=timing|counts`. Timing sets a
pre-document diagnostic override at the canonical telemetry owner and leaves the
React fiber hook OFF. Counts turns store telemetry and the fiber hook ON, but
the existing pre-document counts override suppresses admission of the JS-thread-
lag sampler at its canonical owner. No 50ms sample or periodic sampler flush
timer runs; ordinary telemetry outside a capture is unchanged. Reload the app
after installing the override, before settling. The separately reported sampler
trace line must show zero proven fires, not a slice-subtracted substitute for OFF. Both
record CPU/network/long-task observations; count-run durations are never timing
evidence. The bundle records requested mode and observed enablement. An older UI
that cannot attest enablement fails with `RELOAD NEEDED`; only the orchestrator
refreshes the export. Use fresh cold browsers for five timing J1 repetitions,
then a separate count run for component/store attribution. Each bundle includes
B1–B8 declared report-status snapshots and actual host load before/after; report
status is not proof that another lane was actively capturing. Concurrent runs
are not a quiet-host baseline, even when percentiles can be computed.

Production captures require the stack to report `sourceUi=export` and both
server/daemon identities to have nonempty matching selected/loaded values and
live stack-owned PIDs. Configure `HAPPIER_UI_EXPORT_SOURCE_MAPS=1` before the
orchestrator's export start for original module/symbol attribution. The export
producer includes that option in its existing reuse decision. Source maps are
read after the capture, so their fetch/decoding is outside its counts/profile.
For component-name investigation, the orchestrator can select borrowed dev UI
and the lane uses `--ui-mode=dev`; dev timings never enter production comparison.

Bundles contain a CPU profile and mapped/generated summary, component commit
and render counts, canonical store/selector telemetry, safe network records
(initiator stacks, endpoint, body/transfer byte counts and overlapping duplicate
candidates), Socket.IO names/RPC method identifiers and frames per second,
long tasks, host load, and request/query/daemon diagnostics for the window.
The hook records its own overhead. It promotes PERF10's corrected alternate
identity rule, avoiding stale `PerformedWork` flags on unchanged children.
Store telemetry stays in `syncPerformanceTelemetry`; the canonical Zustand
storage hook reports actual notifications and per-selector evaluations/output
identity changes without changing subscription equality or storing values.
Selector events aggregate by function name, never by per-render function ids.
Anonymous inline selectors share an explicit anonymous bucket. Minified names
can change between exports and name collisions coalesce; use CPU source maps
and component evidence for callsite-level conclusions. Output identity-change
fields remain per-closure observations, not a count of component renders.

No headers, bodies, SQL parameters, credential material or socket argument values
are saved. The protocol owns capability-path redaction. A salted per-run digest
compares full request URLs/bodies without exposing them. A candidate means
overlapping equal requests, not proof of wasted work; unknown request bodies
cannot establish equality. Network transfer bytes include protocol overhead.

The same bundle/comparison also includes decoded HTTP chunk bytes from responses
completed within the window, and sent/received WebSocket message counts and
decoded payload bytes. These follow the [CDP 1.3 Network contract](https://github.com/ChromeDevTools/devtools-protocol/blob/master/json/browser_protocol.json):
`dataReceived.dataLength` counts decoded chunk bytes; `loadingFinished` supplies
encoded transfer bytes. WebSocket payloads use UTF-8 for text and base64 for all
other opcodes. The socket counts include protocol/control messages; payload bytes
exclude framing and do not establish compressed wire bytes. Missing older decoded
counters remain unavailable. All these scenario metrics remain informational
pending the required regression and unchanged-run calibration.

Server query counts are Prisma operation attempts from existing `db.*` latency
spans, not PostgreSQL physical-query counts (one Prisma operation may emit
multiple SQL statements). `db.transaction.*` phases are counted separately,
not added to those operation attempts; total DB phase records remain available.
Server spans correlate by diagnostic request ID.

The isolated stress observer's physical SQL counter is informational. A failed
probe records `null` and an unavailable reason, not zero. A delta requires valid,
nondecreasing in-window endpoints with unchanged reset/eviction metadata; outer
setup/finalization probes do not define that delta. Missing or reset SQL evidence
leaves an explicit bundle gap without discarding browser/CPU evidence. Container,
image and daemon identity checks still fail closed.

UI/server correlation uses returned request IDs where present, otherwise the
time window. Daemon diagnostics expose control completions, external Action
stages and latency spans; these are distinguished from browser RPC calls and
must not be counted as one RPC per stage. Daemon successful `/ping` probes are
intentionally suppressed by the existing logger, so their count is unavailable
from that source. Use endpoint/frame counts and the B7 investigation for intent.

Host CPU/RSS endpoint samples bracket the browser capture and include remote
command overhead; the bundle records their actual wider interval. RSS is not a
peak or retained heap. Daemon time-only log timestamps use the file date, local
timezone and observed midnight rollovers; long silent gaps spanning days cannot
be reconstructed from time-only lines. Missing sources produce explicit gaps
and an `INCOMPLETE` bundle with exit 2. A failed phase writes `failure.json` and
exits 1. No partial run supplies timing evidence. The caller still owns browser
SIGINT/cleanup after either result.

Round-4 collector details:

- Counts mode requests eight async scheduling hops with CDP
  `Debugger.setAsyncCallStackDepth`; timing explicitly requests zero. Inline
  parents and out-of-line `parentId` stacks use the same frame-only URL
  redaction. Parent lookup failure is explicit; absence of a caller is not proof
  that no caller exists. Depth is recorded in instrumentation and reset to zero
  on normal/aborted cleanup. This adds counts-mode overhead, never timing work.
- `readiness.authState` records beginning/end visible `shell`, `welcome` or
  `unknown` surfaces; `cleanup.json` records its pre-cleanup surface and the
  fresh OFF document's surface. These are DOM markers, not credential authority:
  Personal Home may retain a shell while unauthenticated. `authenticated` stays
  null. The app exposes no browser retirement/sign-out reason, so its reason
  field is explicitly null/unavailable; nothing is inferred from a welcome
  marker, URL, network error, storage or React props.

- Failed steps finalize available CPU/network/React/store/socket evidence and
  write a `FAILED`, ineligible bundle plus the original phase in `failure.json`.
  Failed bundles enter neither comparison means nor percentiles. Disconnected
  sources are recorded, not replaced by zero counters.
- `cleanup.json` separates setup/cleanup CDP phase/kind failures from saved-window
  status. Raw browser errors remain suppressed. SIGINT keeps the observer alive
  through finalization. After failure/abort, cleanup reloads the owned page with
  a temporary timing override and records actual fresh-document OFF/OFF, or an
  explicit failure. Removing injection alone cannot turn an initialized store OFF.
- Periodic counts summaries use the existing emitter's `nativeLoggingHook`
  branch and one CDP binding: export Babel removes `console.info`. Console echoes
  are not counted. Every emitted delta is summed once, including identical
  deltas; the terminal flush is only the remainder and retains the end marker.
  No product telemetry change or new export is needed for this delivery repair.
- Network starts are bracket-filtered. Records retain safe Chromium failure
  codes/cancellation/blocking/CORS identifiers, actual returned request ID,
  request/send/header/response/completion times and TTFB. Pending-at-end requests
  stay pending there even if they complete during finalization. Observed bytes
  are separate from bytes completed within the window; no extra grace timeout
  is added. `observedThroughMs` is the observation cutoff, not capture end.
  Route classes exclude fixed `active`/`metadata-upgrades` Session paths from
  exact-row comparisons. Equal fingerprints do not prove equal authority/waste.
- Prefixed multiline server traces retain scalar `transactionClass`, status/code
  and SQLSTATE; Session IDs, error messages, parameters, SQL and nested bags stay
  excluded. Browser IDs join only equal returned server request IDs. Missing
  relay mappings are not invented from proximity or independent UUIDs.
- Server/daemon collection starts a continuous source-side `tail -F` observer
  before capture through the existing configured executor/control-stdin owner.
  It reuses the same safe parser as standalone snapshots and sends projected
  records only, never raw log lines. Closing the observer drains and confirms
  its owned tails before map loading. Large maps and slow remote command setup
  must not push log reads past the debug log's short rotation horizon. Process
  samples use this same observer channel. The existing Pino emitter timestamp
  takes precedence over the later Stack tee receipt timestamp.
- `--viewport=390x844` (or a declaration's `viewport` object) sets and verifies
  CSS dimensions before capture and after each step. Observations are recorded
  even without a declaration. A declaration's `readiness` describes its actual
  ready selector; the default Home selector means shell presence only. Journey
  lanes still own hydration, fixture and full-membership scroll assertions.
- `sameWindowProcessSamples` records interior endpoints after capture begins and
  before it ends; wider outer brackets remain separately labeled. Sampling adds
  automation overhead. Shared process samples include all clients, not per-lane
  CPU/RSS, peaks or allocated DB backends. Suppressed pings cannot establish
  poll rates; missing operation/constructor counts remain unavailable.
- Current development bundles use schema 6. Comparisons keep schema versions separate as
  well as journey/cache/UI/instrumentation mode: legacy unbracketed requests,
  terminal-only telemetry and delayed rotating-log reads cannot be silently
  pooled with corrected captures. Fixed/exact Session route-class metrics are
  included in comparisons; a missing legacy metric stays unavailable.
- Clock mapping uses only coherent native `Network.requestWillBeSent`
  `wallTime`/`timestamp` pairs, including preparation traffic. There is no
  renderer `Date.now()` / `Performance.getMetrics` calibration: a queued renderer
  response is not a simultaneous sample. A request's start is its native wall
  time; its response/completion uses that request's own offset, so later pairs
  cannot shift its lifetime. Socket timestamps use the preceding native pair
  (the first pair for earlier frames), and are buffered until a pair is known.
  Missing pairs are explicit collection errors, never epoch-zero fallback.
  Network records retain original native wall/monotonic timestamps; bundle
  `clock.nativePairs` retains the raw numeric evidence and unmapped counts.
  Schema-2/3 clock-dependent membership/correlation is not certified and cannot
  generally be repaired: filtered-out starts and original native walls were not
  retained. Redo the cohort; do not pool it with schema 4. Controller shell
  durations and profile-wide CPU remain distinct from exact-window evidence.

### Backend CPU and event-loop capture

Add `--backend-profile=server,daemon` to the existing journey command, or put
`"backendProfiles": ["server", "daemon"]` in its JSON definition. Either role can
also be selected alone. This opt-in development diagnostic uses the existing
configured, colocated POSIX Node QA host and host-observer control channel.
It never starts or restarts a backend, changes its environment, or reads the
database. Windows controllers can use the configured POSIX host; a Windows
profiling worker is explicitly unsupported because this mode uses SIGUSR1.

The observer verifies each recorded PID, process incarnation, stack binding and
selected/loaded runtime before signalling it. It refuses an occupied inspector.
A short loopback CDP connection starts a process-local Node inspector Session
and a 20 ms `monitorEventLoopDelay` histogram, then releases the TCP inspector;
both processes can therefore record concurrently without changing debug ports.
Finalization reconnects to the original process, stops its profiler, removes its
monitor and disconnects its Session. Control EOF or interruption also finalizes
owned captures. Runtime changes and failed cleanup produce incomplete evidence.
The implementation uses Node's [inspector API](https://nodejs.org/api/inspector.html)
and the existing Stack `summarizeProfile` reducer.

Each bundle includes `backendProfileRoles` and `backendProfiles`, with runtime
identity, exact backend window, process CPU, event-loop utilization, delay
percentiles, memory endpoints and cleanup status. Raw profiles and full CPU
summaries are saved as `server.cpuprofile`, `server-cpu-summary.json` and
`server-runtime.json`, with corresponding daemon files; `backend-profiles.json`
references them. Profiles sample the main V8 isolate; process CPU includes
native threads, and event-loop utilization is elapsed activity rather than CPU.
Backend windows bracket browser work and include attach/profiling overhead.
They measure shared processes across all clients, not one journey's exclusive
CPU. Comparisons separate role sets, and backend-profiled runs do not supply
unperturbed browser timing percentiles. Keep these artifacts private like other
CPU profiles; no request bodies, credentials or database rows are collected.

### Opt-in browser attribution and settled Home

Development schema-6 captures report transfer through this owner. Each journey's
native start/end bracket is its phase: use separate journey captures for cold,
warm, settled and busy windows. Requests belong to their start window; responses
finishing later remain pending at its end. Frames belong to their native timestamp.

`network.json.endpoints` includes request counts and body bytes, decoded body
bytes, encoded body chunks, and encoded response bytes (including headers), grouped
by method, sanitized endpoint and route class. Missing evidence is `null`; HEAD,
204 and 304 bodies are zero. Cached decoded data with zero encoded chunk evidence
does not establish zero wire-body bytes. The older `encodedBytes` aggregate retains
its observed-response convention; use the availability-aware transfer fields for
regression measurements. No raw bodies, headers or query values are saved.

`sockets.json` projects allowlisted event families, payload types and explicit
`hint`/`full` delivery alongside frame sizes. Unknown names/types stay in an
`unknown` bucket. Engine ping/pong and WebSocket control frames are separate.
Binary headers are classified, while binary attachments remain unattributed
`binary` frames; these are frame counts, not reconstructed logical messages.
WebSocket bytes are decoded payload bytes, not compressed wire-byte evidence.

`bundle.json.counts` carries `transfer.http.<method>.<route-class>.*` and
`transfer.socket.<direction>.<family>.<type>.<delivery>.*` into the existing
comparison JSON/Markdown and CI summary. Absent buckets are zero only when the
capture has `transfer.measured: 1`; unknown measurements remain `null`.
These measurements are report-only until PERFCI calibration; this adds no gate.

Pass `--profiling` (or set `"profiling": true` in the journey) to collect a
full Chrome trace, Long Animation Frames, React Performance Track measures,
sampling heap profile, root changed-key notifications and a physical socket
timeline in the same schema-6 bundle. This extends the existing collector;
ordinary timing/counts capture does not enable these diagnostic observers.
`compare` separates profiling-on/off and backend role sets, and never uses
heavily instrumented runs for timing percentiles.

`--profiling` also attributes React render causes in the browser probe, in the
bundle's probe `diagnostics` next to the other diagnostic rows. `updateRoots`
counts, per window, components that rendered (mounts excluded) under a nearest
component ancestor that did not render in that commit, keyed by a short
component path (nearest four named ancestors; generic wrappers skipped).
`updateCauses` counts `Component :: cause` where the cause is `props`
(changed props identity), the hooks whose update queue changed (`state#<index>`,
or `uSES(<getSnapshot source excerpt>)` for external stores), or
`context:<displayName>{changedKeys}`; `unknown` means none of those changed.
Only names and a sanitized 90-character source excerpt are recorded, never prop,
state or context values. The walk is counted in `hookMs`; a failed attribution
increments `attributionErrors`.

`trace.json.gz` contains sanitized trace events for `devtools.timeline`,
`disabled-by-default-devtools.timeline`, `v8.execute`, `blink.user_timing` and
`disabled-by-default-v8.cpu_profiler`. In-page start/end marks establish the
renderer window, independently of delayed controller receipts. `profiling.json`
contains interval-unioned task, style/layout/paint and GC summaries; nested
durations must not be added. Missing marks or dropped trace data fail closed.
The 2 GiB diagnostic trace buffer replaces Chrome's observed insufficient
200 MiB default; it is not a product resource limit.

Counts mode also enables sync telemetry's otherwise default-off 50ms JS lag
sampler. With `--profiling`, `profiling.json` reports its proven timer slices
separately at `trace.instrumentation.jsThreadLagSampler`, including its summary
flush, GC overlap and residual task occupancy/long tasks/GC. Loaded Metro factory
locations are resolved before measurement; a direct sampler module URL also
supplies ownership. Missing proof or dropped trace data is unavailable, not
zero cost. Other 50ms timers and whole tasks containing unrelated callbacks are
not assigned to the sampler. The counts probe stays enabled.

The residual is arithmetic subtraction of observed slices, **not a sampler-off
counterfactual**: induced GC outside callbacks, altered scheduling and other
diagnostic overhead remain. Raw summaries and J13 assertions are unchanged;
residuals never waive a failing idle gate or certify production CPU. Aggregate
component commit counts overlap, and neither those counts nor Scheduler Update
measures record the subscription cause of every renderer commit.

The pre-document `PerformanceObserver` preserves React's U+200B component
measures before `webReactPerformanceMeasures.ts` clears them. Only name, timing
and scalar track/group metadata are retained, never React prop/detail bags.
`react.json` holds these measures, LoAF script attribution and timestamped
changed top-level root keys. The canonical storage notification owner supplies
keys without storing values; missing source registration is unavailable, not
zero notifications. `socket-timeline.json` contains physical WebSocket events,
Engine.IO ping/pong and Socket.IO frame kinds with the existing native clock
mapping. Physical connect events alone do not prove a logical root reconnect;
request starts are in `network.json`.
The development recorder's `browser-capture.json.socketConnections` supplies
opaque per-capture connection ids, allowlisted purpose (Account, scoped-RPC,
other or unknown) and client role, observed transports including probes, upgrade outcome and
observed lifetime lower bounds. Polling request records and WebSocket frames
carry `socketConnectionId` for joining those observations. Initial polling opens
without an Engine.IO id remain unjoined. Arm the recorder before navigation and
namespace admission to observe purpose; a connection admitted before attachment
may remain unknown. Raw Engine.IO ids, query values and admission payloads stay
inside the recorder and are discarded on close. A failed WebSocket probe does
not establish that its polling connection closed.

Profiling captures also expose `browser-capture.json.socketSetup`. Its
`producerAvailable` bit reports whether the loaded UI supplied the opt-in scoped
pool observer; missing instrumentation is unavailable, not zero acquisitions.
`phases` contains only a phase, epoch timestamp and opaque joins. The UI records
entry reservation (`acquire`), retiring-entry waits, readiness and connect/admission;
CDP records successful upgrade, namespace admission (`registered`),
`rpc-register-sent` and `request-sent`. Namespace admission is distinct from reverse
method registration, and upgrade need not precede admission or the first RPC.
Polling reply bodies are not fetched, so a namespace ACK carried only by polling
has the UI's `connected` marker but no native `registered` marker.
`poolConnectionId` identifies a logical pooled Socket within one document;
`socketConnectionId` identifies its observed physical Engine connection. Private
Engine ids and origins join these inside the recorder, including WebSocket-only
Engine-open packets, and are discarded on cleanup. A logical Socket can reconnect:
events with an Engine id join exactly, while earlier events join only one
unambiguous lifetime and otherwise retain a null physical join. A new document
cannot reuse the previous document's local ordinal. Arm before the cold action
and load the current UI observer: late attachment cannot reconstruct an earlier
acquisition. Compare native handshake/namespace timestamps with the UI's
`connected` timestamp and the main-thread trace to separate transport progress
from delayed JavaScript delivery; the subsequent gap to `request-sent` also
includes Machine admission and crypto preparation. A direct HTTP route is visible
in network records, not as a Socket.IO request phase. These diagnostics add no
timer or poll and do no clock or join work without a profiling observer.

In the current development UI, `serverScopedRpcSocketPool` owns both logical
client leases and pending native acknowledgements. Releasing a client cannot
idle-retire its still-issued request, including through Socket.IO `timeout()`;
after the final acknowledgement settles, the existing five-second idle policy
applies. Explicit pool shutdown/network withdrawal still closes the transport.
Background-task sockets remain independent one-shots and close after their last
use. For a settled healthy Home, measure after finite mount reads retire: expect
zero new scoped acquisitions, recreations, polling or registrations. An aggregate
WebSocket count without its connection purpose does not identify that producer.

LoAF support is recorded rather than assumed on every browser.

`heap.heapprofile` uses 1 MiB allocation sampling, including objects collected
by major/minor GC. Its mapped function estimates cover the sampling lifecycle
(including setup/finalization), not retained heap or an exact-window allocation
rate. CPU summaries normalize signed/out-of-order sampling deltas before
clipping to the same trace window. Dev React profiling overhead remains part
of the observed trace: these are attribution captures, not production savings.

Run `journey J13-settled` with the same required attachment/cache/UI/mode
arguments as J13. It prepares populated, non-loading Home, then measures exactly
300000 ms without input. Its `bundle.assertions` requires busy time strictly
below 5%, conservatively zero long tasks, and no empty changed-key notification.
FAIL or UNAVAILABLE exits 1; ordinary missing evidence still exits 2. A failing
product assertion does not erase its capture. Missing observations cannot pass.
This reference-identity check cannot certify semantic remote changes or polling
intent; those remain owner-level evidence obligations. A no-op notification
with nonempty keys is not automatically a legitimate change. Use export runs
for CI regression baselines; dev captures are useful for React track diagnosis.

Sampling allocations do not diagnose retained closure leaks. The X2 research
recipe (warm-up, stationary repeated interactions, forced GC, V8 closure groups
by source location, then retainer inspection) is a separate informational
investigation, not a J13 gate. No retained-closure heuristic or raw heap snapshot
is enabled here: this live Account has real background inventory/history
changes, and a stationary no-new-history interaction plus safe snapshot handling
has not been established. Do not interpret allocation growth as retained growth,
copy a rounds-based threshold, or save credential-bearing heap strings into
ordinary performance bundles.

Other lanes add small JSON journey files with `id`, `intent`, `prepare` and
`steps`. Operations are `open` (optional path), `home`, `idle` (milliseconds),
`browser` (non-secret agent-browser argument array) and `restore`. `when` selects
`cold` or `warm`. Pass `--journey=PATH` for an external definition. Use real
control clicks and test IDs; keep mutation authority with the lane's brief.

```sh
node apps/ui/scripts/perf/agentBrowserUiPerfAudit.mjs compare BEFORE_DIRECTORY AFTER_DIRECTORY
```

Comparison keeps journey, cold/warm, export/dev and capture-mode groups separate. Counts are
per-run means. Timing p50/p95 use nearest rank and require at least five complete
export timing-mode runs with both instruments observed OFF on each side;
otherwise they are unavailable. Legacy unspecified-mode bundles never qualify. Inspect captured host
load and gaps before treating any comparison as a performance result.
