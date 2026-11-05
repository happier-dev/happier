// Admission resource metadata shared by command policy and pre-bootstrap disk checks.
export const LEGACY_VALIDATION_ADMISSION_CLASSES = Object.freeze(['targeted-validation', 'full-validation']);
export const SOURCE_WEB_EXPORT_MEMORY = Object.freeze({ serialKiB: 8236000, parallelKiB: 32907788,
  intermediateKiB: 12711296, intermediateThreads: 8, parallelThreads: 47,
  gibKiB: 1024 * 1024 });
export const HEAVYWEIGHT_COMMAND_RESOURCES = Object.freeze({
  // Owner Q1 (2026-10-29): successful measured peak rounded up to whole GiB,
  // with no blanket margin. Three loaded deployment-protocol suite runs
  // peaked at 1,825,056 KiB; validation-floor-sizing-1104/measurements.json.
  validation: { memoryKiB: 2 * 1024 * 1024, diskClass: 'validation' },
  // 2026-11-04 loaded Linux workers, focused UI/CLI/server/package files:
  // largest successful sampled tree RSS 779,072 KiB, rounded without margin.
  // validation-floor-sizing-1104/measurements.json retains all run peaks.
  'focused-validation': { memoryKiB: 1 * 1024 * 1024, diskClass: 'validation' },
  // 2026-11-05 windows1-linux UI component trees exceeded the
  // utility-only calibration above. Round the measured peak without margin:
  // focused-vitest-reservation-1105/measure-v2.log (2,995,796 KiB RSS).
  'focused-validation-ui': { memoryKiB: 3 * 1024 * 1024, diskClass: 'validation' },
  // 2026-11-04 repeated loaded entry-load runs reached 2,361,852 KiB.
  // validation-floor-sizing-1104/measurements.json; round up without margin.
  'entry-loads': { memoryKiB: 3 * 1024 * 1024, diskClass: 'validation' },
  // Fresh Linux source-test processes peaked at 103,824 KiB;
  // SYSTEMIC-DELETE/step10-native-source-test-measurement.log. Only one
  // proven built-in/source-only file receives this class;
  // emitted imports, loaders, subprocesses and whole suites keep their class.
  'native-source-test': { memoryKiB: 1 * 1024 * 1024, diskClass: 'validation' },
  // 2026-10-24 nl1 Linux/amd64, canonical custody build flags: warm reused
  // output n10 sampled tree RSS p95 31,852 KiB; fresh cached output n1 peak
  // 122,144 KiB. Current Go1.26.6 with an empty GOCACHE at GOMAXPROCS46,
  // n1 cold build: tree RSS/live-HWM 366,000 KiB (268 snapshots, max gap
  // 35.773 ms); validation-cost-1024-go-cold-corrected.jsonl retains raw
  // samples and successful terminal result. Round the peak to 1 GiB without
  // a blanket margin. Samples are not a certified maximum or cross-platform
  // calibration. Go still checks source.
  'native-custody': { memoryKiB: 1 * 1024 * 1024, diskClass: 'package-dist' },
  'source-bundle': { memoryKiB: 10 * 1024 * 1024, diskClass: 'source-bundle' },
  'source-web-export': { memoryKiB: Math.ceil(SOURCE_WEB_EXPORT_MEMORY.parallelKiB / SOURCE_WEB_EXPORT_MEMORY.gibKiB) * SOURCE_WEB_EXPORT_MEMORY.gibKiB, diskClass: 'source-web-export' },
  // Two fresh isolated canonical dependency installs succeeded; larger live
  // tree VmHWM sum 2,374,684 KiB rounds to 3 GiB. Retained raw evidence:
  // SYSTEMIC-DELETE/step10-dependency-install{,-topological-setup}-measurement.log.
  'dependency-install': { memoryKiB: 3 * 1024 * 1024, diskClass: 'dependency-install' },
  'package-dist': { memoryKiB: 6291456, diskClass: 'package-dist' },
  // 2026-10-29 linux1 x64 strict Protocol build, n2 cold + n2 warm:
  // sampled peak tree RSS 4,482,316 KiB; live VmHWM sum 4,483,876 KiB.
  // Plus the legacy unmeasured margin rounds to 6 GiB for that workload,
  // not this shared class. Full daemon artifact builds also use this owner;
  // their historical reported 16,442,992 KiB + 1,608,848 rounds to 18 GiB.
  // Retain that envelope: its original capture is unavailable, and Protocol
  // alone cannot recalibrate the larger full-runtime workload.
  'runtime-build': { memoryKiB: 18874368, diskClass: 'runtime-build' },
  // General compilation also covers commit coherence across CLI + UI.
  // 2026-11-04 admission holder 2355054: sampled tree RSS 38,992,620 KiB,
  // rounded to 38 GiB without margin. Its recorded 26 GiB floor uniquely
  // identifies this class; package-specific classes were not identified.
  // Evidence: .project/tmp/compile-reservation-peaks-1104/holder-snapshot.json.
  compilation: { memoryKiB: 38 * 1024 * 1024, diskClass: 'compilation' },
  'compilation-ui': { memoryKiB: 20 * 1024 * 1024, diskClass: 'compilation' },
  'compilation-cli': { memoryKiB: 15 * 1024 * 1024, diskClass: 'compilation' },
  'compilation-server': { memoryKiB: 16 * 1024 * 1024, diskClass: 'compilation' },
});
