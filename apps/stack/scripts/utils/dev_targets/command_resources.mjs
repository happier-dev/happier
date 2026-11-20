// Admission resource metadata shared by command policy and pre-bootstrap disk checks.
export const LEGACY_VALIDATION_ADMISSION_CLASSES = Object.freeze(['targeted-validation', 'full-validation']);
export const SOURCE_WEB_EXPORT_MEMORY = Object.freeze({ serialKiB: 8236000, parallelKiB: 32907788,
  intermediateKiB: 12711296, intermediateThreads: 8, parallelThreads: 47,
  gibKiB: 1024 * 1024 });
// 2026-11-04 validation-floor-sizing-1104/measurements.json: successful
// cli-file, server-file and package-file runs (six each, two Linux workers).
// Nearest-rank p95 of per-run sampled tree RSS peaks; no additional margin.
// UI components have their own class and are excluded from focused calibration.
export const COMMAND_MEMORY_MEASUREMENTS = Object.freeze({
  'focused-validation': Object.freeze({ samples: 18, p95KiB: 779072, maxKiB: 779072, roundingKiB: 1024 * 1024 }),
  // 2026-11-10 completed-slot-memory.jsonl across linux1, windows2-linux, nl1, nl3:
  // package-dist n=310; retain that sample count and p95 below.
  // P03-BUILD-REUSE/run2-batch-cold/rss-peaks.jsonl (2026-11-13):
  // K=2 batch tree RSS peak 5,327,920 KiB; round to next 0.5 GiB.
  // Owner GO (Continuation 2); no extra margin beyond rounding.
  'package-dist': Object.freeze({ samples: 310, p95KiB: 4624416, maxKiB: 5327920, roundingKiB: 512 * 1024 }),
});
export const SOURCE_RELOAD_ADMISSION_CLASS = 'source-reload';
const ENTRY_LOAD_MEMORY_KIB = 3 * 1024 * 1024;
const COMPILATION_COLD_MEMORY_KIB = Math.ceil(11_364_896 * 1.5 / (1024 * 1024)) * 1024 * 1024;
export const HEAVYWEIGHT_COMMAND_RESOURCES = Object.freeze({
  // Owner 2026-11-17: daemon Plugin UI preparation in QA reload #172 waited
  // behind validation. Retain its observed 17 GiB reservation (17825792 KiB)
  // and validation disk/host CPU shape; only queue precedence changes.
  [SOURCE_RELOAD_ADMISSION_CLASS]: { memoryKiB: 17825792, cpuCores: 'host', diskClass: 'validation', headPriority: 2 },
  // Owner Q1 (2026-10-29): successful measured peak rounded up to whole GiB,
  // with no blanket margin. Three loaded deployment-protocol suite runs
  // peaked at 1,825,056 KiB; validation-floor-sizing-1104/measurements.json.
  validation: { memoryKiB: 2 * 1024 * 1024, cpuCores: 'host', diskClass: 'validation' },
  // 2026-11-04 loaded Linux workers, focused UI/CLI/server/package files:
  // largest successful sampled tree RSS 779,072 KiB, rounded without margin.
  // validation-floor-sizing-1104/measurements.json retains all run peaks.
  'focused-validation': { memoryKiB: Math.ceil(COMMAND_MEMORY_MEASUREMENTS['focused-validation'].maxKiB / (1024 * 1024)) * 1024 * 1024, cpuCores: 1, diskClass: 'validation', focusedTest: true },
  // 2026-11-05 windows1-linux UI component trees exceeded the
  // utility-only calibration above. Round the measured peak without margin:
  // focused-vitest-reservation-1105/measure-v2.log (2,995,796 KiB RSS).
  'focused-validation-ui': { memoryKiB: 3 * 1024 * 1024, cpuCores: 1, diskClass: 'validation', focusedTest: true },
  // CLI files exceed the utility calibration: focused-vitest-reservation-1105
  // measurements.json, accountArtifactStore.test.ts 1,783,032 KiB live HWM,
  // rounded to whole GiB without margin.
  'focused-validation-cli': { memoryKiB: 2 * 1024 * 1024, cpuCores: 1, diskClass: 'validation', focusedTest: true },
  // 2026-11-04 repeated loaded entry-load runs reached 2,361,852 KiB.
  // validation-floor-sizing-1104/measurements.json; round up without margin.
  'entry-loads': { memoryKiB: ENTRY_LOAD_MEMORY_KIB, cpuCores: 'host', diskClass: 'validation' },
  // The gate uses the entry-load envelope and learns its exact-tree identity separately.
  'gate-entry-loads': { memoryKiB: ENTRY_LOAD_MEMORY_KIB, cpuCores: 'host', diskClass: 'validation' },
  // Fresh Linux source-test processes peaked at 103,824 KiB;
  // SYSTEMIC-DELETE/step10-native-source-test-measurement.log. Only one
  // proven built-in/source-only file receives this class;
  // emitted imports, loaders, subprocesses and whole suites keep their class.
  'native-source-test': { memoryKiB: 1 * 1024 * 1024, cpuCores: 1, diskClass: 'validation' },
  // 2026-10-24 nl1 Linux/amd64, canonical custody build flags: warm reused
  // output n10 sampled tree RSS p95 31,852 KiB; fresh cached output n1 peak
  // 122,144 KiB. Current Go1.26.6 with an empty GOCACHE at GOMAXPROCS46,
  // n1 cold build: tree RSS/live-HWM 366,000 KiB (268 snapshots, max gap
  // 35.773 ms); validation-cost-1024-go-cold-corrected.jsonl retains raw
  // samples and successful terminal result. Round the peak to 1 GiB without
  // a blanket margin. Samples are not a certified maximum or cross-platform
  // calibration. Go still checks source.
  'native-custody': { memoryKiB: 1 * 1024 * 1024, cpuCores: 1, diskClass: 'package-dist' },
  // UI source assets (the atmosphere worklet core): one esbuild bundle measured
  // 2026-11-11 on the controller at ~53 MB peak RSS in ~0.1 s (n2). Round to
  // 1 GiB like native-custody; one core.
  'source-asset': { memoryKiB: 1 * 1024 * 1024, cpuCores: 1, diskClass: 'package-dist' },
  // Successful isolated Linux x64 server source bundle, 2026-11-08:
  // sampled tree RSS 11,856,864 KiB, rounded up without a blanket margin.
  // admission-floor-classes-1108/c2-isolated-source-server-measurement.json.
  'source-bundle': { memoryKiB: 12 * 1024 * 1024, cpuCores: 'host', diskClass: 'source-bundle' },
  'source-web-export': { memoryKiB: Math.ceil(SOURCE_WEB_EXPORT_MEMORY.parallelKiB / SOURCE_WEB_EXPORT_MEMORY.gibKiB) * SOURCE_WEB_EXPORT_MEMORY.gibKiB, cpuCores: 'workers', diskClass: 'source-web-export' },
  // Two fresh isolated canonical dependency installs succeeded; larger live
  // tree VmHWM sum 2,374,684 KiB rounds to 3 GiB. Retained raw evidence:
  // SYSTEMIC-DELETE/step10-dependency-install{,-topological-setup}-measurement.log.
  'dependency-install': { memoryKiB: 3 * 1024 * 1024, cpuCores: 'host', diskClass: 'dependency-install' },
  'package-dist': { memoryKiB: Math.ceil(COMMAND_MEMORY_MEASUREMENTS['package-dist'].maxKiB / COMMAND_MEMORY_MEASUREMENTS['package-dist'].roundingKiB) * COMMAND_MEMORY_MEASUREMENTS['package-dist'].roundingKiB, cpuCores: 'host', diskClass: 'package-dist' },
  // 2026-10-29 linux1 x64 strict Protocol build, n2 cold + n2 warm:
  // sampled peak tree RSS 4,482,316 KiB; live VmHWM sum 4,483,876 KiB.
  // Plus the legacy unmeasured margin rounds to 6 GiB for that workload,
  // not this shared class. Full daemon artifact builds also use this owner;
  // their historical reported 16,442,992 KiB + 1,608,848 rounds to 18 GiB.
  // Retain that envelope: its original capture is unavailable, and Protocol
  // alone cannot recalibrate the larger full-runtime workload.
  'runtime-build': { memoryKiB: 18874368, cpuCores: 'host', diskClass: 'runtime-build' },
  // 2026-11-19 controller compilation class, four completed identities:
  // max dedicated-cgroup working set 11,364,896 KiB (commit type coherence).
  // No completed general-compilation rows on nl1, nl3 or windows2-linux.
  // Max × 1.5, rounded up to a whole GiB, gives a 17 GiB cold reservation.
  // Evidence: .project/tmp/P03-ADMISSION-4/cold-floor-before-controller.log.
  compilation: { memoryKiB: COMPILATION_COLD_MEMORY_KIB, cpuCores: 'host', diskClass: 'compilation' },
  // Both gate compiler steps have the ordinary cold envelope and independent history.
  'gate-package-typecheck': { memoryKiB: COMPILATION_COLD_MEMORY_KIB, cpuCores: 'host', diskClass: 'compilation' },
  'gate-declaration-comparison': { memoryKiB: COMPILATION_COLD_MEMORY_KIB, cpuCores: 'host', diskClass: 'compilation' },
  'compilation-ui': { memoryKiB: 20 * 1024 * 1024, cpuCores: 'host', diskClass: 'compilation' },
  // Host memory: 2026-11-07, 51 live snapshots over 25 minutes, three tsrs UI
  // holders. Max live VmHWM sum 9,477,228 KiB + measured within-holder RSS
  // range 41,512 KiB, rounded up to whole GiB, gives 10 GiB. Evidence:
  // .project/tmp/finalizer-floor-1106/live-holders-summary.json. Microsoft UI
  // retains 20 GiB (18,909,772 KiB historical peak).
  // Waiting diagnostics show this floor; capacity/OOM refusal owns recovery.
  'compilation-ui-tsrs': { memoryKiB: 10 * 1024 * 1024, cpuCores: 'host', diskClass: 'compilation' },
  'compilation-cli': { memoryKiB: 15 * 1024 * 1024, cpuCores: 'host', diskClass: 'compilation' },
  'compilation-server': { memoryKiB: 16 * 1024 * 1024, cpuCores: 'host', diskClass: 'compilation' },
});

// Owner ruling 2026-11-16 ("small suites local"): focused test runs placed
// on the invoking machine start without the shared admission queue. Placed
// workers and explicit admission wrappers keep their admission.
export const FOCUSED_TEST_ADMISSION_CLASSES = Object.freeze(Object.keys(HEAVYWEIGHT_COMMAND_RESOURCES)
  .filter(className => HEAVYWEIGHT_COMMAND_RESOURCES[className].focusedTest));

// A host broker outlives catalog edits, so the client resolves the disk shape
// from its current catalog and sends that on the wire; the broker's own
// catalog then only has to know the stable disk shapes.
export function resolveAdmissionDiskClass(className) {
  return HEAVYWEIGHT_COMMAND_RESOURCES[className]?.diskClass
    ?? (LEGACY_VALIDATION_ADMISSION_CLASSES.includes(className) ? 'validation' : className);
}

// Consume the compiler resolver's decision, never infer it from flags or host.
export function resolveTypeScriptAdmissionClass(admissionClass, compiler) {
  if (admissionClass === 'compilation-ui' || admissionClass === 'compilation-ui-tsrs') {
    return compiler === 'tsrs' ? 'compilation-ui-tsrs' : 'compilation-ui';
  }
  return admissionClass;
}

// Cold core charges for commands without a worker declaration. Short cgroup
// cpu.stat deltas (2026-11-19 22:16Z, controller, nl1, nl3, windows2-linux):
// source-bundle 1.079 and tsrs UI 11.153. Use 1.5×, rounded up. Generic
// validation keeps 3 cores against the completed 2.946-core maximum.
// Completed cgroup averages (2026-11-20 01:14Z, nl1/nl3/windows2-linux):
// dependency-install 1.590 max (7 runs) and source-reload 1.856 max
// (4 runs), also 1.5×. Package-dist completed p95 was 2.050 cores (111
// nl3 rows, 1.308 nl1, 1.099 windows2-linux). Three cores covers p95 × 1.4
// and both the 2.547 completed max and earlier 2.552 short delta.
// Entry-loads use the validation envelope. Completed local identities replace
// cold estimates. Fixed worker classes and dynamic exports use their declarations.
// The 1.38-core compilation observation was single-threaded. Reserve two
// cores for that explicit mode and six for an ordinary native compile:
// four default TS7 checkers × 1.5 for front-end and runtime work.
const SINGLE_THREADED_TYPESCRIPT_CPU_CORES = 2;
const TYPESCRIPT_CPU_CORES = 6;
const ENTRY_LOAD_CPU_CORES = 3;
export const COLD_ADMISSION_CPU_CORES = Object.freeze({
  [SOURCE_RELOAD_ADMISSION_CLASS]: 3,
  validation: 3,
  'entry-loads': ENTRY_LOAD_CPU_CORES,
  'gate-entry-loads': ENTRY_LOAD_CPU_CORES,
  'source-bundle': 2,
  'dependency-install': 3,
  'package-dist': 3,
  'runtime-build': 4,
  compilation: TYPESCRIPT_CPU_CORES,
  'gate-package-typecheck': TYPESCRIPT_CPU_CORES,
  'gate-declaration-comparison': TYPESCRIPT_CPU_CORES,
  'compilation-ui': TYPESCRIPT_CPU_CORES,
  'compilation-ui-tsrs': 17,
  'compilation-cli': TYPESCRIPT_CPU_CORES,
  'compilation-server': TYPESCRIPT_CPU_CORES,
});
export const UNKNOWN_ADMISSION_CPU_CORES = COLD_ADMISSION_CPU_CORES['package-dist'];

export function isTypeScriptCompilationClass(className) {
  return HEAVYWEIGHT_COMMAND_RESOURCES[className]?.diskClass === 'compilation';
}

export function isSingleThreadedTypeScript(args) {
  const index = args.findLastIndex(arg => /^--singlethreaded(?:=|$)/i.test(arg));
  if (index === -1) return false;
  const [, value] = args[index].toLowerCase().split('=');
  return value === undefined ? args[index + 1]?.toLowerCase() !== 'false' : value === 'true';
}

// The destination broker sizes symbolic host-class costs from its own history.
export function resolveAdmissionCpuCost(className, args = []) {
  if (isTypeScriptCompilationClass(className) && isSingleThreadedTypeScript(args)) {
    return SINGLE_THREADED_TYPESCRIPT_CPU_CORES;
  }
  return HEAVYWEIGHT_COMMAND_RESOURCES[className]?.cpuCores ?? 'host';
}

export function resolveColdAdmissionCpuCost(className) {
  const declared = resolveAdmissionCpuCost(className);
  return declared !== 'host' ? declared : Object.hasOwn(COLD_ADMISSION_CPU_CORES, className)
    ? COLD_ADMISSION_CPU_CORES[className] : UNKNOWN_ADMISSION_CPU_CORES;
}

export function resolveAdmissionCpuCores(cost, { totalCpuCores, workers, requestedCpuCores = 0, className } = {}) {
  // An explicit count sizes ordinary Vitest runs more directly than a class sample.
  if (className === 'validation' && Number.isSafeInteger(requestedCpuCores) && requestedCpuCores > 0) return requestedCpuCores;
  const base = cost === 'workers' ? workers ?? totalCpuCores : cost === 'host' ? totalCpuCores : cost;
  return Math.max(base, requestedCpuCores === 'host' ? totalCpuCores : requestedCpuCores);
}

export const ADMISSION_CPU_WORKER_ENV_NAMES = Object.freeze([
  'GOMAXPROCS', 'HAPPIER_VITEST_MAX_WORKERS', 'VITEST_UI_MAX_FORKS',
  'VITEST_MAX_FORKS', 'VITEST_MAX_THREADS', 'VITEST_MIN_FORKS', 'VITEST_MIN_THREADS',
  'HAPPIER_VITEST_GOVERNOR_MAX_WORKERS',
]);
export const ADMISSION_CPU_WORKER_FLAGS = Object.freeze([
  '--maxWorkers', '--max-workers', '--minWorkers', '--min-workers',
  '--poolOptions.threads.maxThreads', '--poolOptions.forks.maxForks',
  '--poolOptions.threads.minThreads', '--poolOptions.forks.minForks',
]);

export function resolveRequestedAdmissionCpuCores({ env = process.env, args = [] } = {}) {
  const values = ADMISSION_CPU_WORKER_ENV_NAMES.map(name => env[name]);
  for (let index = 0; index < args.length; index += 1) {
    const [flag, value] = args[index].split('=', 2);
    if (ADMISSION_CPU_WORKER_FLAGS.includes(flag)) {
      const size = value ?? args[index + 1];
      if (size === undefined) return 'host';
      values.push(size);
    }
  }
  // Percentages and other explicit sizing are evaluated by the tool itself;
  // retain that behavior and reserve the host instead of guessing its meaning.
  if (values.some(value => value !== undefined && value !== '' &&
    (typeof value !== 'string' || !/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))))) return 'host';
  return values.reduce((maximum, value) => typeof value === 'string' && /^\d+$/.test(value)
    && Number.isSafeInteger(Number(value)) ? Math.max(maximum, Number(value)) : maximum, 0);
}
