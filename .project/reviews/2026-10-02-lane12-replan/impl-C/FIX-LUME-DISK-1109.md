IMPLEMENTED_NOT_VERIFIED — source correction verified; Fork C owes new-Darwin-payload live proof. Package typecheck has two untouched-file diagnostics below.
Same-shape sweep: machine-* home-relative path measurement/comparison — 3 sites screened: fixed Lume; Cua absolute CUA_HOME (`remoteDeclarations.ts:102,107`) and Crabbox host-issued absolute credentials (`direct.ts:44–47`) excluded; routed none.

| Gap | Canonical owner reused | RED → GREEN | Live evidence |
| --- | --- | --- | --- |
| Single `home` storage at `~/.lume` lost disk headroom | `machine-lume/src/machine/hostResources.ts:26`, SDK `expandHomePath` + host `os.homedir()` | Recorded native-client fixture: both `~/` and `~\` RED missing disk; GREEN 40/40 tests | Original attempt 4 observed ~103 GB available; corrected Darwin payload not loaded here |

- Observed fixture basis: `qa-shots5/lume-live2/attempt4-before-native.log:4`; native Lume 0.6.1 storage projection, not a substituted absolute path.
- Deciding RED: 2 failed / 1 passed, missing `availableDiskBytes`; initial ESM-spy harness failure was corrected before this run and is not RED evidence.
- GREEN: `hstack-exec --cwd=packages/plugins/machine-lume -- pnpm exec vitest run src/machine/hostResources.test.ts src/machine/provider.test.ts` → 2 files / 40 tests passed.
- Cost contract at observed scale: one native location, two consecutive checks → one filesystem measurement per check; two locations → zero measurements and unknown disk.
- Touched-file compiler: `hstack-exec -- pnpm run tsc --noEmit --ignoreConfig --strict --skipLibCheck --target ES2022 --module ESNext --moduleResolution Bundler --types node <hostResources.ts> <hostResources.test.ts>` → exit 0, no diagnostics.
- Package compiler: `hstack-exec --cwd=packages/plugins/machine-lume -- pnpm run typecheck` → exit 2: untouched `src/machine/passwordPolicy.ts:68` TS2741 and `:97` TS2339; no package-baseline attribution claimed.
- Entry-loads: `hstack-exec --script=check:entry-loads` → 13/13 graphs passed, exit 0. All AUTO handles reached terminal results; none requeued manually.
- Evidence: `qa-shots5/gaps/FIX-LUME-DISK-1109/{red,green,touched,entry-loads,package}.log`.
- Touched code: `packages/plugins/machine-lume/src/machine/{hostResources.ts,hostResources.test.ts}`; private-index/CAS packet also contains this report.
- Consumer path retained: native client `hostFacts` → provider `check.localResources` → existing configurator; no second disk owner, selection channel, SDK/schema change or UI change. Existing absolute paths remain covered by provider tests.
- Net product mechanisms: checks/states/error codes/timers/retries +0/−0; existing path expansion reused. Code files +0/−0 (2 modified in this packet); artifacts +1 report and +5 retained logs.
- Self-review: both separator forms and ambiguous locations falsified; path disclosure remains absent. No canonical documentation contract changed.
- Residual risk / Fork C action: build/load a new Darwin payload and repeat the read-only Lume configurator check; package diagnostics remain for the integration owner. Available CPU stays out of scope.
