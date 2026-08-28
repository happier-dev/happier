# Terminal Bench

Local TERM fixture runner for byte/base64 terminal workloads. The scripts produce local artifacts only; do not commit generated reports.

Run every repo-owned terminal workload through bounded base64 frames:

```bash
node scripts/terminal-bench/run.mjs --out .project/logs/terminal-bench/local.json
```

Run a smaller workload subset:

```bash
node scripts/terminal-bench/run.mjs --workload ansi-burst --workload long-scrollback --repeat 3 --frame-bytes 8192 --out .project/logs/terminal-bench/subset.json
```

Print a concise summary for a generated report:

```bash
node scripts/terminal-bench/report.mjs .project/logs/terminal-bench/local.json
```

Compare a baseline and candidate report with regression gates:

```bash
node scripts/terminal-bench/report.mjs --compare .project/logs/terminal-bench/baseline.json .project/logs/terminal-bench/candidate.json --min-throughput-ratio 0.75 --max-additional-loss-events 0
```

Run the real browser xterm renderer in headless Chromium. This is an explicit
non-fast benchmark and writes both xterm parser/write completion and a
two-animation-frame display observation; neither value claims GPU paint timing:

```bash
yarn benchmark:terminal:xterm-web --repeat 3 --out .project/logs/terminal-bench/xterm-web.json
```

Loaded xterm WebView and native comparisons must use the same canonical
workloads at least three times on the same device, application id, and build
evidence id. Record `timingBoundary=display-observed` separately from
`parser-write-complete`; compare iOS Ghostty against xterm WebView with the
broad no-regression floor `0.75`, and Android Termux against xterm WebView with
the material-improvement floor `1.25`. The report helper rejects missing
baselines, cross-device/build samples, and undersampled workloads; it never
generates loaded-device observations.

Cleanup fences are available from `packages/tests/src/testkit/terminal/cleanupFence.ts`; they intentionally scope checks to terminal-owned paths instead of a repo-wide `data: string` search.

Windows/ConPTY byte-stream support is represented by the runnable stress owner
`packages/tests/suites/stress/terminal/windowsConpty.test.ts`: Windows stays
legacy-only unless a real raw-Buffer output and checksum match are proven.

## TERM-7b loaded-device evidence

Recipe tests describe required native coverage; they are not device evidence. A completed iOS Ghostty or Android Termux run must write one JSON record under an ignored path such as:

```text
packages/tests/.project/logs/e2e/terminal-native/<platform>/<run-id>/evidence.json
```

Evidence schema v2 is intentionally incompatible with the former declarative v1 format. Create a fresh run bundle with the repo-owned helpers in `packages/tests/src/testkit/terminal/deviceEvidenceRunBundle.ts`; v1 records are rejected and must never be upgraded by editing their claims.

Capture the canonical source inventory from the exact frozen build root before building:

```bash
node scripts/terminal-bench/capture-source-state.mjs <frozen-source-root> <run-dir>/source-state.json <40-char-commit> <true|false>
```

Strict evidence is finalized by an independently governed Ed25519 capture authority. Schema-v2 capture policies bind each authority to exact renderer/build IDs and an inclusive validity window; build identity generation, run start/end, and capture signing all fail closed outside those bounds. The current internal QA private key is available only to the controlled local operator at `/home/leeroy.guest/.happier/term-qa-authority-20260828/private.pem`; this path identifies an external secret and the key content must never enter the repository, evidence, logs, or reports. Run:

```bash
node scripts/terminal-bench/sign-device-evidence.mjs \
  --draft <run-dir>/evidence.draft.json \
  --output <run-dir>/evidence.json \
  --attestation <run-dir>/capture-attestation.json \
  --authority <registered-authority-id> \
  --private-key <external-private-key.pem>
```

The finalizer verifies every retained artifact checksum before signing the canonical run inventory. The retained app ZIP/APK must separately contain its signed `happier-terminal-native-build-identity.json`; validation does not trust app, build, source, or dependency claims from evidence JSON alone.

Before finalization, generate the mandatory platform package report from the retained binary. Android uses the canonical SDK build tools to cryptographically verify the APK and bind its manifest, DEX/resources/native-library inventory, ABIs, signature schemes, and signer certificate digest:

```bash
node scripts/terminal-bench/inspect-native-app-package.mjs \
  --platform android --binary <run-dir>/app.apk --output <run-dir>/platform-package-inspection.json \
  --aapt2 "$ANDROID_HOME/build-tools/<version>/aapt2" \
  --apksigner "$ANDROID_HOME/build-tools/<version>/apksigner"
```

iOS accepts a retained simulator `.app` archive or a device/export IPA. Choose the exact build signing mode from `simulator-unsigned`, `simulator-adhoc`, `device-development`, `device-distribution`, or `app-store-export`; the inspector cross-checks the bounded archive parser against `plutil`, `lipo`, and, for signed modes, `codesign`:

```bash
node scripts/terminal-bench/inspect-native-app-package.mjs \
  --platform ios --binary <run-dir>/app.zip --output <run-dir>/platform-package-inspection.json \
  --ios-signing-mode simulator-unsigned
```

The package report is the details payload for the `platform-package-inspection` packaging gate and remains bound to the exact app binary SHA-256. Identity-only ZIPs, wrong platform identity paths or package metadata, malformed DEX/ELF/Mach-O payloads, unsigned APKs, signer-output omissions, and device IPAs without code-signing resources/provisioning are rejected.

Record the exact loaded app and binary identity, app-emitted run nonce and build-evidence id, source commit/dirty state plus a canonical hashed source inventory, device/runtime identity, native renderer and the dependency closure derived from `packages/terminal-native/native-renderers.json`, run timestamps, logical session and terminal ids, every workload/action/accessibility observation, and SHA-256-addressed artifact references. Each observation needs its own `observation-report` JSON binding the claim to the run/session/renderer/nonce/build id and interval; arbitrary text, stale reports, or cross-run artifacts are rejected.

For each run:

1. Install and launch the exact native-enabled app build on the target simulator/emulator or physical device.
2. Drive every workload returned by `getTerminalNativeDeviceRecipe(renderer)` through the shipped loaded-app bridge and retain screenshots/logs under the run directory.
3. Record accepted byte offsets and unique terminal/write/operation identities as one continuous workload-to-action cursor chain. For reject/retry, the first action starts at the final workload ACK, rejection does not advance it, and retry resumes at that exact offset.
4. Exercise hardware chords, real IME composition, selection/copy, crash-to-xterm fallback with the same logical session and terminal ids, background/resume, and orientation away and back with content retained. Crash continuity requires matching before/after content markers, not a boolean assertion alone.
5. Capture the platform accessibility tree, actual VoiceOver/TalkBack navigation, and invoked copy/select/open-link actions.
6. Produce the platform packaging attestation with every packet-owned technical gate: platform package inspection, repeatable build, exact dependency/checksum, license/NOTICE, size, ABI, crash capability, and the iOS Wuffs/app-link/store-export or Android Gradle/closure/forbidden-module checks.
7. Record external legal/product approval independently. Android strict release readiness requires an Ed25519-signed `release-approval` record from an authority registered in `packages/terminal-native/release-approval-authorities.json`, bound to the exact Termux revision and canonical closure. The checked-in authority list is empty until release governance adds a real key; local evidence tooling cannot manufacture this approval.
8. Hash every artifact and the loaded app binary, then validate the record:

```bash
node scripts/terminal-bench/validate-device-evidence.mjs packages/tests/.project/logs/e2e/terminal-native/ios/<run-id>/evidence.json
node scripts/terminal-bench/validate-device-evidence.mjs packages/tests/.project/logs/e2e/terminal-native/android/<run-id>/evidence.json
```

The wrapper resolves the evidence argument against the caller's working directory before it enters the `packages/tests` runtime. The repository-relative examples above therefore work when invoked from the repository root; absolute paths remain supported.

Exit code `0` means schema-v2 device acceptance, technical packaging, and required authenticated external approval are ready. Exit code `1` prints every missing or inconsistent acceptance item; exit code `2` means CLI usage, file, or JSON failure. Generated evidence and artifacts remain under `.project/logs/**`, which is repository-ignored; never commit a fabricated completed run.

For engineering-only device acceptance while an independently owned release approval remains pending, pass `--device-acceptance`. This mode returns `0` only when the loaded-device schema, artifacts, workloads, interactions, and accessibility evidence are complete; it does not change or hide `releaseApprovalReady`, and the default command remains the release gate.
