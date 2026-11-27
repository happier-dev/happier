# Release port ledger (0.2 → 0.3)

0.3 (`v0.3`) branched from 0.2 (`dev`). This ledger records what 0.3 did with each 0.2 `dev` commit that
touched the release and deploy pipeline (`.github`, `scripts/pipeline`, `scripts/release`, `docker`,
`Dockerfile`) after the last sync point. `scripts/pipeline/release/report-release-port-gaps.mjs` lists
newer 0.2 commits that have no row here; CI runs it on every `v0.3` push as a non-blocking report.

Dispositions: `ported <0.3 commit>` (or `ported` with a note for behaviour 0.3 already had),
`different <reason>` (0.3 redesigned the area), `n.a. <reason>`, and `missing <note>` (not ported yet).
Add a row for each new 0.2 commit the report lists.

<!-- release-port-sync: e49afc11e8d -->

| 0.2 commit | date | subject | disposition | note |
|---|---|---|---|---|
| 1856b347151 | 2026-04-06 | Add funding configuration for GitHub and custom links | n.a. | FUNDING.yml sponsor links; not release pipeline |
| 2252c6a179e | 2026-04-06 | fix(release): tolerate eas local cleanup noise | ported | present before 2026-11-27: same-path line evidence 65/67 surviving lines found in 0.3 |
| aa26a686875 | 2026-04-06 | fix(release): align stable and preview publish lanes | ported | present before 2026-11-27: same-path line evidence 104/109 surviving lines found in 0.3 |
| 05be16ebae5 | 2026-04-07 | fix(release): suffix rolling server runtime versions | ported | present before 2026-11-27: same-path line evidence 4/4 surviving lines found in 0.3 |
| 267f565cd50 | 2026-04-07 | fix(release): wire dev lane through release rings | ported | present before 2026-11-27: npm-release --channel dev/preview/production, release rings (public-release-rings.mjs), publish-tarball.mjs |
| 390938effd1 | 2026-04-07 | Revert "release: ship 0.2.1 CLI + mobile/desktop release fixes" | n.a. | revert of 0.2.1 release-fix PR (mostly UI/eas product code); superseded within 0.2 |
| 48aa5098e2f | 2026-04-07 | fix(release): restore package manifests and hstack deps | ported | present before 2026-11-27: npm/release-packages.mjs restores manifests; build-hstack-binaries.mjs bundleWorkspaceDeps |
| 5950a3f8669 | 2026-04-07 | fix(release): allow local ios dry-run submits | ported | present before 2026-11-27: native-build.mjs ios local dry-run guard (platform===ios && !dryRun) |
| 632495c12a2 | 2026-04-07 | feat(process): prefer PATHEXT .cmd shims | ported | present before 2026-11-27: same-path line evidence 32/32 surviving lines found in 0.3 |
| a5ea52fac14 | 2026-04-07 | release: ship 0.2.1 CLI | ported | present before 2026-11-27: same-path line evidence 42/52 surviving lines found in 0.3 |
| bad71f84f5d | 2026-04-07 | fix(release): restore intended 0.2.1 ship changes | ported | present before 2026-11-27: same-path line evidence 42/52 surviving lines found in 0.3 |
| 5a59be2ac7a | 2026-04-08 | feat(cli-common): support Windows-shaped paths | ported | present before 2026-11-27: same-path line evidence 26/26 surviving lines found in 0.3 |
| a7283afda79 | 2026-04-08 | Fix Windows installer native command fallback handling | ported | present before 2026-11-27: same-path line evidence 27/28 surviving lines found in 0.3 |
| 68275cf7cb0 | 2026-04-09 | feat(pipeline): add expo-testflight-distribute | ported | present before 2026-11-27: expo-testflight-distribute command in help-specs/expo.mjs + run.mjs runExpoTestflightDistribute |
| 9faac6b8ecc | 2026-04-09 | feat(cli): add service command and repair flow | ported | present before 2026-11-27: same-path line evidence 340/344 surviving lines found in 0.3 |
| 93cdaa543af | 2026-04-10 | fix(relay): harden installer and host lifecycle | ported | present before 2026-11-27: same-path line evidence 514/519 surviving lines found in 0.3 |
| 9ad297b27ab | 2026-04-10 | fix(release): automate external testflight distribution | ported | present before 2026-11-27: expo testflight-distribute/-config, run.mjs resolveTestflightDistributionConfig, EXTERNAL_GROUPS env in build-ui-mobile-local.yml, plutil ipa metadata |
| d275e88102c | 2026-04-10 | fix(runtime): finish daemon ownership and service rollout | ported | present before 2026-11-27: same-path line evidence 173/175 surviving lines found in 0.3 |
| 180845d4144 | 2026-04-11 | feat(cli): add step printer and progress helpers | ported | present before 2026-11-27: same-path line evidence 4/4 surviving lines found in 0.3 |
| e4f8f94e9bb | 2026-04-11 | feat(release): compute versioned component changes | ported | present before 2026-11-27: same-path line evidence 283/288 surviving lines found in 0.3 |
| 340b1f9491c | 2026-04-16 | feat(release): harden runtime promotion, relay hosting, and installer sync | ported | present before 2026-11-27: same-path line evidence 591/735 surviving lines found in 0.3 |
| 574e49db6f5 | 2026-04-16 | feat(release): prune node_modules when packaging | ported | present before 2026-11-27: same-path line evidence 105/105 surviving lines found in 0.3 |
| b344bc912f7 | 2026-04-16 | feat(relay): add --yes flag and payload sidecars | ported | present before 2026-11-27: same-path line evidence 19/19 surviving lines found in 0.3 |
| 0f4b09bce9e | 2026-04-17 | fix(ci): drop invalid shell from shared install action step | different | Yarn install action test n.a.; pnpm workflow_pnpm_install_action.contract.test.mjs |
| 1328be3316f | 2026-04-17 | fix(release): harden validation and publish stability | ported | present before 2026-11-27: same-path line evidence 377/422 surviving lines found in 0.3 |
| 16b87089493 | 2026-04-17 | test(release): cover local-build installer validation paths | ported | present before 2026-11-27: release_validate_installers_smoke_local_build + installers_local_release_assets tests present |
| 31345ebfbcd | 2026-04-17 | fix(ci): repair nightly verification and windows release builds | ported | present before 2026-11-27: same-path line evidence 2/2 surviving lines found in 0.3 |
| 3a7fc33e150 | 2026-04-17 | test(release): add GITHUB_PATH bootstrap test | ported | present before 2026-11-27: same-path line evidence 42/43 surviving lines found in 0.3 |
| 4b4eabf8703 | 2026-04-17 | fix(ci): stabilize release validation and daemon restart checks | ported | present before 2026-11-27: same-path line evidence 71/71 surviving lines found in 0.3 |
| 5fd4f866d61 | 2026-04-17 | fix(ci): run continuity validation through release verify | ported | present before 2026-11-27: tests.yml continuity jobs gated on inputs.run_*_continuity |
| 71ef853092f | 2026-04-17 | fix(ci): harden workflow dependency installs | different | Yarn install hardening replaced by install-pnpm-dependencies action (workflow_pnpm_install_action.contract.test.mjs) |
| 7c24a59f00f | 2026-04-17 | fix(ci): thin continuity jobs and retry installer assets | ported | present before 2026-11-27: same-path line evidence 36/39 surviving lines found in 0.3 |
| 804dc330377 | 2026-04-17 | test(ci): harden bootstrap and local-build fixtures | ported | present before 2026-11-27: same-path line evidence 9/9 surviving lines found in 0.3 |
| 919a533cff6 | 2026-04-17 | fix(ci): harden release validation and publish smoke gates | ported | present before 2026-11-27: same-path line evidence 238/241 surviving lines found in 0.3 |
| 94a39d09198 | 2026-04-17 | fix(cli): stabilize daemon and installer validation | ported | present before 2026-11-27: same-path line evidence 4/4 surviving lines found in 0.3 |
| 9a3f3244735 | 2026-04-17 | fix(ci): repair nightly startup and windows installer validation | ported | present before 2026-11-27: same-path line evidence 4/4 surviving lines found in 0.3 |
| aea10240438 | 2026-04-17 | fix(docker): use shared yarn retry helper in root image builds | different | Dockerfile uses pnpm; yarn-install-with-retry helper n.a. |
| c3762b71f73 | 2026-04-17 | fix(ci): tolerate missing rolling compare ranges | ported | present before 2026-11-27: same-path line evidence 74/74 surviving lines found in 0.3 |
| df0deeb1ba6 | 2026-04-17 | build(release): extract binary publishing and validation executors | ported | present before 2026-11-27: same-path line evidence 2557/2808 surviving lines found in 0.3 |
| ec6f7437021 | 2026-04-17 | test(release): add tests; expose dev option | ported | present before 2026-11-27: tests-dispatch.yml installers_channel options include dev; tests.yml INSTALLERS_CHANNEL derived per branch |
| fdd51a9202a | 2026-04-17 | build(release): support local-build installer smoke validation | ported | present before 2026-11-27: same-path line evidence 298/363 surviving lines found in 0.3 |
| 28924f31745 | 2026-04-18 | fix(daemon): add allowBootstrap to runtime resolution | ported | present before 2026-11-27: same-path line evidence 23/23 surviving lines found in 0.3 |
| 30d7d6ed772 | 2026-04-18 | fix(ci): harden ui sharing and session transport validation | ported | present before 2026-11-27: same-path line evidence 4/4 surviving lines found in 0.3 |
| 456bfefbffd | 2026-04-18 | fix(ci): raise ui and stack test timeout floors | ported | present before 2026-11-27: same-path line evidence 16/16 surviving lines found in 0.3 |
| 471146d4b1a | 2026-04-18 | fix(installers): honor HAPPIER_HOME_DIR on Windows | ported | present before 2026-11-27: same-path line evidence 13/13 surviving lines found in 0.3 |
| 48bcd855e9f | 2026-04-18 | fix(ci): raise ui and windows installer timeout floors | ported | present before 2026-11-27: same-path line evidence 8/8 surviving lines found in 0.3 |
| 5387080540d | 2026-04-18 | fix(cli): preserve active server during setup-relay | ported | present before 2026-11-27: same-path line evidence 35/35 surviving lines found in 0.3 |
| e50f05dc67f | 2026-04-18 | fix(installers): retry transient release downloads | ported | present before 2026-11-27: same-path line evidence 45/53 surviving lines found in 0.3 |
| f16a8883494 | 2026-04-18 | fix(installers): preserve active server for explicit setup-relay | ported | present before 2026-11-27: same-path line evidence 25/25 surviving lines found in 0.3 |
| 326b1088722 | 2026-04-19 | fix(installers): fail closed when doctor repair is unsupported | ported | present before 2026-11-27: install.sh read_background_service_preflight_json / doctor repair unsupported handling |
| 6552b23690b | 2026-04-19 | feat(installers): clarify automatic startup messages | ported | present before 2026-11-27: same-path line evidence 70/82 surviving lines found in 0.3 |
| 852ffc18cbf | 2026-04-19 | fix(codex): preserve default mode and fast controls | ported | present before 2026-11-27: same-path line evidence 1/1 surviving lines found in 0.3 |
| 93f9c48b8c9 | 2026-04-19 | fix(cli): avoid misleading daemon details when stopped | ported | present before 2026-11-27: same-path line evidence 34/35 surviving lines found in 0.3 |
| 9ac849f2870 | 2026-04-19 | feat(doctor): unify install/update convergence via doctor repair | ported | present before 2026-11-27: same-path line evidence 342/425 surviving lines found in 0.3 |
| cb7086327cf | 2026-04-19 | fix(installers): restore setup-relay defaults and avoid unbound arrays | ported | present before 2026-11-27: same-path line evidence 5/5 surviving lines found in 0.3 |
| d9e92fc7ba3 | 2026-04-19 | fix(installers): stream doctor repair summary and gate legacy output | ported | present before 2026-11-27: same-path line evidence 21/21 surviving lines found in 0.3 |
| eb48c1a5d49 | 2026-04-19 | fix(cli): refine background service status reporting | ported | present before 2026-11-27: same-path line evidence 83/100 surviving lines found in 0.3 |
| 07586be5e1e | 2026-04-21 | fix(ui): keep new-session visible and hide claude system messages | ported | present before 2026-11-27: install.sh installer_command_failure_looks_unsupported present |
| 19596f19ac2 | 2026-04-21 | feat(installer): improve repair report & PATH hint | ported | present before 2026-11-27: same-path line evidence 8/8 surviving lines found in 0.3 |
| 952690d06b1 | 2026-04-21 | fix(installers): prevent PS var interpolation | ported | present before 2026-11-27: install.ps1 uses ("{0}:" -f $Label); tests.yml INSTALLERS_CHANNEL expression reshaped |
| 4ee9219ac45 | 2026-04-22 | Update FUNDING.yml | n.a. | FUNDING.yml sponsor links; not release pipeline |
| b5275180991 | 2026-04-26 | fix(opencode-runtime): stabilize idle-turn resolution and installer repair preflight | ported | present before 2026-11-27: same-path line evidence 88/99 surviving lines found in 0.3 |
| ab606dc07fe | 2026-04-27 | Update README illustration | n.a. | README/image artwork only; no pipeline behaviour |
| ea43f1904d1 | 2026-04-27 | Delete .github/illustration.png | n.a. | README/image artwork only; no pipeline behaviour |
| c102d98c5dd | 2026-04-29 | fix(cli-service): harden daemon repair diagnostics | ported | present before 2026-11-27: same-path line evidence 73/73 surviving lines found in 0.3 |
| 6aa113ff60b | 2026-04-30 | refactor(scripts): centralize yarn/command spawning | different | Yarn spawning (execYarnCommand) replaced by pnpm owner scripts/workspaces/execPnpmCommand.mjs |
| e05f53b33d4 | 2026-04-30 | feat(cli-common): resolve tsc via package manager | different | 0.3 stress-tests.yml redesigned (single stress_config expression); tsc via runTypeScriptCli |
| 9dda7efce6b | 2026-05-05 | feat(stack): harden installer and mobile dev-client release tooling | missing | stack install + installers present; absent: expo_dev isIntentionalExpoTermination supervision and profile-scoped APK reuse in utils/mobile mobile_dev_client.mjs (hstack dev tooling) [LOW] |
| 0cdc50b5a3a | 2026-05-07 | fix(server): serve precompressed UI assets | ported | present before 2026-11-27: Dockerfile + lib/ui-web-bundle.mjs precompress via apps/stack/scripts/build/precompress_ui_web_assets.mjs |
| b887698ac6d | 2026-05-07 | test(release): align dev release contract fixtures | ported | present before 2026-11-27: Fixture alignment; installers_daemon_autostart/tauri make-latest-json tests present |
| 2254facf7e9 | 2026-05-09 | fix(release): harden installer and binary release smoke assets | ported | present before 2026-11-27: same-path line evidence 588/672 surviving lines found in 0.3 |
| 7832172721d | 2026-05-09 | fix(stack): isolate stack auth home and remote smoke setup | ported | present before 2026-11-27: same-path line evidence 949/952 surviving lines found in 0.3 |
| af8bfba39da | 2026-05-09 | build(release): pin desktop tauri defaults and source-mode daemon startup | ported | present before 2026-11-27: build-tauri.yml EXPO_PUBLIC_HAPPIER_BUILD_DEFAULT_PROFILE_JSON pins api.happier.dev |
| 6082add313e | 2026-05-10 | feat(ui-release-notes): add release-notes runtime, assets pipeline, and story deck UI | ported | present before 2026-11-27: same-path line evidence 366/377 surviving lines found in 0.3 |
| 948f6e0ad2a | 2026-05-10 | test(release): align installer and expo local-build contracts | ported | present before 2026-11-27: same-path line evidence 6/7 surviving lines found in 0.3 |
| 5900b776f19 | 2026-05-11 | ci(release): use GitHub App token for assets | ported | present before 2026-11-27: same-path line evidence 18/19 surviving lines found in 0.3 |
| aba595190e6 | 2026-05-11 | feat(pipeline): add Android EAS releaseStatus flag | ported | present before 2026-11-27: expo/submit.mjs normalizeAndroidReleaseStatus; help-specs/expo.mjs |
| ee1f7a1abee | 2026-05-11 | feat(release): skip GH upload for empty bundles | missing | publish-release-notes-assets.mjs has no isEmptyGeneratedBundle skip; verify empty bundle reachable under release-notes v2 [LOW] |
| fc0f2cc67a5 | 2026-05-11 | fix(release): deterministic empty release-notes | different | Release notes redesigned (release-notes v2, approved bundle expo_message); no deterministic-empty workflow step needed |
| bc21c6ec446 | 2026-05-12 | fix(release): unify rolling prerelease allocation | ported | present before 2026-11-27: same-path line evidence 512/536 surviving lines found in 0.3 |
| e9d0773d0a4 | 2026-05-13 | build(tauri): harden publish asset pipeline and update lockfile | ported | present before 2026-11-27: same-path line evidence 76/79 surviving lines found in 0.3 |
| 38abc096259 | 2026-05-14 | fix(release): harden dev nightly publishing | ported | present before 2026-11-27: install.ps1 winget minisign install + Resolve-MinisignExecutablePath |
| 44eb2e2e3aa | 2026-05-14 | fix(release): align dev release contracts with current versions | ported | present before 2026-11-27: install.ps1 incompatible minisign warning + winget fallback |
| 74ec3d77d81 | 2026-05-14 | fix(release): retry transient mac notarization timeouts | ported | present before 2026-11-27: same-path line evidence 82/82 surviving lines found in 0.3 |
| 8e5ba30dc44 | 2026-05-14 | fix(ci): align mobile dagger workflow version | ported | present before 2026-11-27: same-path line evidence 11/12 surviving lines found in 0.3 |
| 8ec8a2688e9 | 2026-05-14 | fix(release): avoid expo submit eas config races | ported | present before 2026-11-27: scripts/pipeline/expo/submit.mjs atomic tmp+rename eas config write |
| ac69b98fd5c | 2026-05-14 | fix(release): stabilize dev release validation | ported | present before 2026-11-27: scripts/release/installers/install.ps1 winget minisign exit-code handling |
| c886ce248ac | 2026-05-14 | fix(ci): free linux disk for tauri builds | ported | present before 2026-11-27: same-path line evidence 27/27 surviving lines found in 0.3 |
| 48f75d4eeba | 2026-05-15 | build(expo-pipeline): add canonical fingerprint flow and wire ota/native build p | ported | present before 2026-11-27: scripts/pipeline/expo/canonical-fingerprint.mjs + native-build/ota-update wiring |
| b538a7fbb3a | 2026-05-23 | test(release): add l59 clean-wave single-session contract coverage | ported | present before 2026-11-27: same-path line evidence 92/92 surviving lines found in 0.3 |
| d886e76bdad | 2026-05-23 | fix(release): harden windows installer lock hygiene and payload promotion | ported | present before 2026-11-27: same-path line evidence 746/752 surviving lines found in 0.3 |
| 26791a9e404 | 2026-05-29 | build(release-pipeline): harden workflow env handling and pipeline contract cove | ported | present before 2026-11-27: EXPO_UNSTABLE_WEB_MODAL in native-build/build-ui-web-bundle/tauri; parse-json-from-command-output.mjs; cursor provider CI n.a. (no cursor agent in 0.3) |
| e63b96713eb | 2026-05-29 | test(release): enforce transitive trusted-ref guard for inherited secrets | ported | present before 2026-11-27: scripts/release/workflow_secret_hardening.contract.test.mjs present |
| 20e33d7a3a6 | 2026-06-06 | fix(repo-tooling): avoid blocking hook stdin and correct Windows minisign bootstrap | n.a. | superseded within 0.2: x86_64 restored by 67a1e5b2bbd; 0.3 bootstrap-minisign.sh:117 uses x86_64 |
| c7ade116903 | 2026-06-06 | test(release): match Windows minisign archive naming in bootstrap contract | n.a. | superseded within 0.2 (minisign Windows layout reverted to x86_64 at HEAD); test-only |
| c9893be469b | 2026-06-06 | fix(release): allow large EAS fingerprint payloads during OTA updates | ported | present before 2026-11-27: same-path line evidence 53/54 surviving lines found in 0.3 |
| 0cdc71562a6 | 2026-06-08 | fix(ci-release): harden install env, nightly scheduling, and Expo OTA heap defau | ported | present before 2026-11-27: nightly-dev.yml cron 17 2; ota-update.mjs applyExpoNodeHeapEnv; Yarn install env n.a. (pnpm) |
| 3e61693b0af | 2026-06-16 | build(tooling): centralize workspace TypeScript resolution and stack server owne | different | TS resolution via runTypeScriptCli/resolveTypeScriptCliInvocation; stack dev server ownership (apps/stack) is dev tooling, not release pipeline |
| 227d763f18f | 2026-06-20 | fix(installers): harden windows payload promotion and runtime staging | ported | present before 2026-11-27: same-path line evidence 301/301 surviving lines found in 0.3 |
| 95cfec5dce4 | 2026-06-22 | build(native-runtime): share workspace tooling and sherpa checksum resolution | ported | present before 2026-11-27: same-path line evidence 128/131 surviving lines found in 0.3 |
| f9269d55b3f | 2026-06-22 | build(release): harden mobile install scope, runtime preflight locking, and pack | ported | present before 2026-11-27: HAPPIER_INSTALL_SCOPE set in build-ui-mobile-local.yml (updated scope list) |
| b73501aaa38 | 2026-06-25 | Add demos | n.a. | README/image artwork only; no pipeline behaviour |
| 55c40efef31 | 2026-07-02 | build(release): harden docker artifact resolution and installer promotion flows | ported | present before 2026-11-27: same-path line evidence 617/709 surviving lines found in 0.3 |
| 85e99e6101e | 2026-07-02 | build(release): align docker artifact publishing and self-host docs | ported | present before 2026-11-27: binary-release.mjs:651-654 rm stale .minisig; release-channel.yml:1477 build_dev_box excludes stack-only change |
| e1978ed5ba2 | 2026-07-02 | build(dev-box): consume signed CLI artifacts and centralize provider installs | ported | present before 2026-11-27: same-path line evidence 46/46 surviving lines found in 0.3 |
| 9bb07f9308f | 2026-07-10 | build(typescript): use the managed native compiler | different | 0.3 TypeScript owner: scripts/workspaces/runTypeScriptCli.mjs + resolveTypeScriptCliInvocation.mjs (tsrs/TS7), not typescriptCommand.mjs |
| 28580c661b8 | 2026-07-11 | feat(ghops): manage validated bot credentials in Keychain | ported | present before 2026-11-27: same-path line evidence 13/13 surviving lines found in 0.3 |
| 354702ce0af | 2026-07-21 | merge: integrate Grok agent support from upstream dev | n.a. | merge of Grok agent support; only .github demo PNGs in pipeline scope |
| 00d470a027b | 2026-07-25 | feat(release): split binary publication into audited phases | missing | Phases exist (publish/publish-immutable/promote-rolling) but no publishing/server-runtime-candidate.mjs hostile-candidate inspection or candidate-dir phase [MED] |
| 0370b09a428 | 2026-07-25 | fix(release): preserve local refs during planning | ported | present before 2026-11-27: lib/release-planning-remote-refs.mjs + scripts/release/release_planning_remote_refs.test.mjs |
| 23cf2786ae8 | 2026-07-25 | test(release): align contracts with hosted publishers | ported | present before 2026-11-27: Contract tests aligned; release_titles/tests_workflow.artifact_verify/workflow_secret_hardening tests present in 0.3 |
| 38d09f5dd87 | 2026-07-25 | feat(release): make rolling promotion byte-audited | ported | present before 2026-11-27: same-path line evidence 392/442 surviving lines found in 0.3 |
| 3ec500d7cd3 | 2026-07-25 | feat(release): bind server promotion to one authorized SHA | missing | SHA binding present (promote-server.yml resolve_source/apply_bump); absent: enforce-server-runtime-activity-rollout.mjs, resolve-server-promotion-inputs, prepare-server-release-bump, promote-server-deploy-ref, ACTIVITY_ROLLOUT vars. Owner to confirm 0.3 needs rollout gate [MED] |
| 4e52ff54d0a | 2026-07-25 | refactor(release): retire reusable actor guard | ported | present before 2026-11-27: same-path line evidence 16/16 surviving lines found in 0.3 |
| 60f915b40e4 | 2026-07-25 | fix(release): scope actor guard membership tokens | ported | present before 2026-11-27: same-path line evidence 11/11 surviving lines found in 0.3 |
| 822a6d10312 | 2026-07-25 | build(ui): make publicdev iOS builds reproducible | ported | present before 2026-11-27: scripts/release/ui_mobile_eas_publicdev_profile.contract.test.mjs present |
| 9e89fde17b0 | 2026-07-25 | feat(ui): bundle Mermaid runtime for isolated native rendering | ported | present before 2026-11-27: promote-ui.yml runs pnpm --dir apps/ui run verify:mermaid-webview-bundle |
| cdb8e04fb65 | 2026-07-25 | feat(release): add hosted immutable release recovery | ported | present before 2026-11-27: retry_version/resume_version recovery inputs on publish-ui-web/cli/hstack/runner/server workflows |
| defa9622c0e | 2026-07-25 | refactor(release): centralize CLI GitHub releases | ported | present before 2026-11-27: release-npm.yml has no mirror-cli-stable job (CLI GitHub releases centralized in publish-cli-binaries) |
| ed133f3c816 | 2026-07-25 | refactor(release): move privileged execution to hosted workflows | ported | present before 2026-11-27: same-path line evidence 136/157 surviving lines found in 0.3 |
| ef81aaf8fc1 | 2026-07-25 | feat(release): bind retries to immutable source identity | ported | present before 2026-11-27: github/resolve-authorized-release-source.mjs + lib/rolling-version-allocation.mjs (generalized npmPackages) |
| f317519847c | 2026-07-25 | test(compat): gate current clients against server v0.2.1 | ported | present before 2026-11-27: tests.yml "Run exact server-v0.2.1 compatibility gate" |
| f61efcde209 | 2026-07-25 | fix(release): constrain workflow app tokens | ported | present before 2026-11-27: same-path line evidence 15/15 surviving lines found in 0.3 |
| f9f61ff561f | 2026-07-25 | fix(release): constrain remaining workflow tokens | ported | present before 2026-11-27: same-path line evidence 26/26 surviving lines found in 0.3 |
| 25101a74fc2 | 2026-07-26 | test(release): lock build owner contracts | ported | present before 2026-11-27: cli_build_uses_npx_pkgroll, ui_tauri_sidecar_hermeticity, workspace_build_command_tool_resolution contract tests present in scripts/release |
| ff8559e0327 | 2026-07-26 | test(release): keep minisign rejection messages secret | ported | present before 2026-11-27: scripts/release/minisign_key_resolution.test.mjs present |
| a2226faad1c | 2026-07-27 | fix(ui): isolate Unistyles native state across reloads | ported | present before 2026-11-27: same-path line evidence 43/43 surviving lines found in 0.3 |
| 960a6dce4c9 | 2026-07-28 | feat(release): select the packaged server component | ported | present before 2026-11-27: same-path line evidence 6/6 surviving lines found in 0.3 |
| c7858f0ae27 | 2026-07-28 | fix(release): keep dry-run planning out of dotenv secrets | ported | present before 2026-11-27: scripts/pipeline/env/load-pipeline-env.mjs includeFiles/processEnv options |
| 3cd551ced8d | 2026-08-01 | fix(ui-build): run patches through Windows workspace junctions | ported | present before 2026-11-27: same-path line evidence 47/52 surviving lines found in 0.3 |
| 67bd6b5b8bf | 2026-08-01 | fix(server-release): keep trusted finalizer dependency-free | missing | No lib/minisign-signing.mjs, release-arguments.mjs, release-files.mjs; publish-server-runtime.yml finalize_publish runs pnpm install before signing (not dependency-free) [MED] |
| 71fbc00e0f9 | 2026-08-01 | fix(testflight): defer automatic concurrent review | ported | present before 2026-11-27: same-path line evidence 75/75 surviving lines found in 0.3 |
| 864a4e4895d | 2026-08-01 | fix(release): defer binary asset imports until publish execution | ported | present before 2026-11-27: publish-binary-release.mjs lazy-imports prepare-binary-assets.mjs |
| b802c2f8e41 | 2026-08-01 | fix(docker-release): install runtime before publish | ported | present before 2026-11-27: same-path line evidence 5/5 surviving lines found in 0.3 |
| d66ccce5fcf | 2026-08-01 | fix(ui-build): invoke Skia setup without package shim | ported | present before 2026-11-27: same-path line evidence 14/15 surviving lines found in 0.3 |
| ee019223eb8 | 2026-08-01 | fix(docker-release): load runtime without install | ported | present before 2026-11-27: same-path line evidence 3/3 surviving lines found in 0.3 |
| ee8e3a35346 | 2026-08-01 | fix(ui-build): keep filtered patches on target volume | different | apps/ui/tools/postinstall.mjs + postinstall/pnpmPatches.mjs replace Yarn patch handling |
| 9273d204c50 | 2026-08-03 | fix(release): attest compiled CLI versions before publishing | ported | present before 2026-11-27: verify-artifacts.mjs binary version mismatch check; product-specs patchPackageVersionOnRolling |
| ee63f5d4540 | 2026-08-03 | build(docker): slim relay-server image by pruning unused artifacts (#219) | missing | Dockerfile relay-artifacts prunes mysql-client/sharp but not non-target sqlite-client query engines (image size) [LOW] |
| ef73f2151bc | 2026-08-03 | docs(docker): clarify prebuilt database provider support | ported | present before 2026-11-27: same-path line evidence 1/1 surviving lines found in 0.3 |
| 1c727433bb1 | 2026-08-04 | fix(release): refresh App Store Connect tokens while polling | ported | present before 2026-11-27: same-path line evidence 56/56 surviving lines found in 0.3 |
| b7ccf652aab | 2026-08-04 | test(release): exercise rolling promotion with a verifiable CLI archive | ported | present before 2026-11-27: same-path line evidence 11/12 surviving lines found in 0.3 |
| 7ce95d06f2f | 2026-08-05 | fix(release): accept direct TestFlight group identifiers | ported | present before 2026-11-27: scripts/pipeline/expo/testflight-group-resolution.mjs byId resolution |
| cd6c8fedd96 | 2026-08-05 | fix(relay): stabilize auth token keys across runtimes | ported | present before 2026-11-27: same-path line evidence 32/35 surviving lines found in 0.3 |
| bb044a554a6 | 2026-08-07 | ci(security): harden reusable workflow controls | ported | present before 2026-11-27: same-path line evidence 287/334 surviving lines found in 0.3 |
| ee90129693a | 2026-08-07 | fix(installers): retry rolling release metadata gaps | ported | present before 2026-11-27: same-path line evidence 25/28 surviving lines found in 0.3 |
| 1ab8f1b2f55 | 2026-08-08 | fix(release-mobile): publish prepared OTA artifacts | ported | present before 2026-11-27: same-path line evidence 262/290 surviving lines found in 0.3 |
| 1dc0bcbd067 | 2026-08-08 | fix(release-tauri): separate candidate signing and notarization | ported | present before 2026-11-27: same-path line evidence 1936/2061 surviving lines found in 0.3 |
| 201a1ab1c7d | 2026-08-08 | fix(release): verify immutable candidates before promotion | ported | present before 2026-11-27: same-path line evidence 3084/3586 surviving lines found in 0.3 |
| 4f35bca71d6 | 2026-08-08 | fix(release): extract Node archives in process | ported | present before 2026-11-27: scripts/pipeline/release/node-archive.mjs extractNodeArchive via release-runtime extractArchivePayloadToDirectory (in-process); limits gap tracked in 560bd256f3f |
| cb78e2e3e78 | 2026-08-08 | fix(release-docker): verify runtime inputs outside image builds | ported | present before 2026-11-27: same-path line evidence 340/354 surviving lines found in 0.3 |
| 1a861860413 | 2026-08-09 | fix(release): align workflow prerequisites and trust contracts | ported | present before 2026-11-27: same-path line evidence 30/34 surviving lines found in 0.3 |
| 3cce79b030a | 2026-08-09 | test(release): publish valid npm provenance fixtures | ported | present before 2026-11-27: scripts/release/pipeline_npm_publish_provenance_override.contract.test.mjs present; env fixture test consolidated |
| 48e95c55783 | 2026-08-09 | fix(release): make npm publication retries integrity-safe | ported | present before 2026-11-27: same-path line evidence 220/225 surviving lines found in 0.3 |
| 6eabb977812 | 2026-08-09 | fix(release): restore nightly release notes | n.a. | 0.2.10 CHANGELOG entry plus version-specific test; 0.3 has nightly_dev.release_verify contract test |
| 7896c66c9fe | 2026-08-09 | fix(release): scope mobile notes publication token | ported | present before 2026-11-27: same-path line evidence 5/5 surviving lines found in 0.3 |
| 7b6281baf02 | 2026-08-09 | feat(release): publish and enforce the release contract | ported | present before 2026-11-27: scripts/pipeline/release/public-release-contract.mjs + run.mjs release-contract subcommand; pipeline_public_release_contract_cli test |
| 7dff0d50faa | 2026-08-09 | fix(release): require every selected registry push | ported | present before 2026-11-27: same-path line evidence 60/60 surviving lines found in 0.3 |
| 7e86a99a391 | 2026-08-09 | feat(release): project notes and publication evidence | ported | present before 2026-11-27: same-path line evidence 444/450 surviving lines found in 0.3 |
| 8ba79ebb550 | 2026-08-09 | refactor(release): centralize supported deployment targets | ported | present before 2026-11-27: component-registry.mjs releaseTargets consumed by help-specs/run.mjs |
| b46d574c6f4 | 2026-08-09 | fix(release): fence hosted workflow control | ported | present before 2026-11-27: release-channel.yml workflow_control_sha fence; scripts/release/release_orchestrator_trust_boundary.workflow.contract.test.mjs |
| b759a5dc43e | 2026-08-09 | fix(release): create deploy refs from explicit lookup state | ported | present before 2026-11-27: same-path line evidence 13/14 surviving lines found in 0.3 |
| c37fb0e4f6d | 2026-08-09 | fix(release): verify stable candidates against old relay | ported | present before 2026-11-27: tests.yml server-v0.2.1 compatibility gate + checkout_sha verify; release-verify.yml/summarize-release-status |
| dbb9d13d3eb | 2026-08-09 | feat(release): bind promotions to authorized candidates | ported | present before 2026-11-27: promote-branch.yml/promote-branch.mjs source_sha binding, release-channel.yml, release_local_hosted_authority test |
| f83605cc237 | 2026-08-09 | feat(release): sign immutable UI asset envelopes | ported | present before 2026-11-27: same-path line evidence 618/653 surviving lines found in 0.3 |
| 06cc3a54f9f | 2026-08-10 | fix(ci): retry unreachable yarn registry failures | different | Yarn registry retry tests n.a.; pnpm install owned by install-pnpm-dependencies action |
| 1e78bd08fd1 | 2026-08-10 | feat(release): validate exact candidates before promotion | ported | present before 2026-11-27: same-path line evidence 302/353 surviving lines found in 0.3 |
| 2902c0a7deb | 2026-08-10 | fix(release): pin relay predecessor before upgrade smoke | ported | present before 2026-11-27: same-path line evidence 12/13 surviving lines found in 0.3 |
| 30e51187f87 | 2026-08-10 | fix(release): tolerate transient rolling asset uploads | missing | promote-rolling-release.mjs lacks uploadReleaseAssetWithRetry (transient uploads.github.com connect failures, backoff) [MED] |
| 438d483d06e | 2026-08-10 | fix(cli-build): stamp immutable distributions with release versions | missing | No HAPPIER_CLI_BUILD_VERSION / releaseVersion stamping of immutable CLI dist (apps/cli/scripts/build.mjs, cli-common cliDistBuildManifest, buildCliBinaryArtifactPayload) [MED] |
| 49506f4a249 | 2026-08-10 | fix(release): derive Expo update messages from approved notes | ported | present before 2026-11-27: promote-ui.yml uses release_notes_expo_message output for OTA/update message; no expo_update_message input |
| 560bd256f3f | 2026-08-10 | fix(release-runtime): allow verified first-party payload scale | ported 0ad5bbab9fd | node-archive, relay archive cache, self-host install and companion CLI |
| 658b39bb450 | 2026-08-10 | fix(release): retain authored versioned release notes | ported | present before 2026-11-27: same-path line evidence 5/5 surviving lines found in 0.3 |
| 7dbaa0046c1 | 2026-08-10 | refactor(ci): centralize Tauri Linux dependencies | ported | present before 2026-11-27: .github/actions/install-tauri-linux-dependencies used by build-tauri.yml |
| 82608cda5de | 2026-08-10 | fix(release-notes): remove legacy rolling asset publishers | ported | present before 2026-11-27: no legacy rolling release-notes asset publisher in publish-ui-mobile-dev/publish-ui-web; promote-ui.yml owns it |
| 82a5c24f8fc | 2026-08-10 | fix(ci): reuse retrying Corepack bootstrap in tests | different | 0.3 uses pnpm: .github/actions/install-pnpm-dependencies + scripts/ci/setup-pnpm.mjs instead of Corepack Yarn bootstrap |
| 86fc954c149 | 2026-08-10 | fix(release): harden standalone macos notarization retries | ported 0ad5bbab9fd | codesign timestamp retry; MH_EXECUTE-only spctl and JIT |
| 870e7b96d1b | 2026-08-10 | refactor(release): centralize binary artifact ownership | different | Refactor enabling dependency-free finalizer (release-files.mjs, product-specs artifactTargets); 0.3 keeps binary-release.mjs owners; see 67bd6b5b8bf |
| 97ab3a6137b | 2026-08-10 | fix(ci): retry Corepack Yarn bootstrap | different | Yarn Corepack retry action n.a.; 0.3 pnpm via install-pnpm-dependencies + scripts/ci/setup-pnpm.mjs |
| cfdc7ecb478 | 2026-08-10 | fix(release): retry exhausted rolling uploads on a fresh runner | missing | No exit-75 / requires_fresh_runner_retry fresh-runner re-promote job in publish-server-runtime.yml or promote-rolling-release.mjs; port there [MED] |
| d7f5564d763 | 2026-08-10 | fix(release): extend Gatekeeper propagation retries | ported | present before 2026-11-27: same-path line evidence 14/14 surviving lines found in 0.3 |
| e4ca073eae0 | 2026-08-10 | test(release): supply approved notes IDs in dry-run contracts | ported | present before 2026-11-27: same-path line evidence 14/14 surviving lines found in 0.3 |
| e91f2beebd9 | 2026-08-10 | refactor(release): bind validation and publication to exact candidates | ported | present before 2026-11-27: Reshaped: release-npm.yml authorized_sha, release-verify.yml validation_profile, release-channel.yml, summarize-release-status.mjs, execute-local-candidates.mjs |
| ecd963ff7e5 | 2026-08-10 | fix(expo): publish prepared ota with its bound runtime | missing | ota-update.mjs validatePreparedUpdateMetadata still requires exact runtimeVersion match; no prepared-OTA runtime binding / local fingerprint hash at publish [MED] |
| eee2047f961 | 2026-08-10 | feat(release-notes): bind projections to approved project releases | ported | present before 2026-11-27: same-path line evidence 301/319 surviving lines found in 0.3 |
| f394ec55ec5 | 2026-08-10 | refactor(release): batch remote planning graph queries | ported | present before 2026-11-27: compute-versioned-component-changes.mjs createRemoteReachabilityIndex + lib/release-planning-remote-refs.mjs cat-file --batch-check |
| fb8f941bea9 | 2026-08-10 | fix(release): harden rolling asset promotion retries | missing | promote-rolling-release.mjs runMutationAndConfirm confirms once; no bounded GH_MUTATION_CONFIRM retry/backoff for eventual-consistency [MED] |
| 3f0a72a1667 | 2026-08-11 | fix(release): make immutable asset transfers resilient | ported | present before 2026-11-27: scripts/pipeline/github/lib/release-asset-transfer.mjs (transfer timeout env, ETIMEDOUT/502 retry) + promote-rolling-release.mjs runToFile |
| 4dfeae22a20 | 2026-08-11 | fix(release): harden cross-platform artifact handling | ported | present before 2026-11-27: same-path line evidence 69/76 surviving lines found in 0.3 |
| 59a95ec5f0e | 2026-08-11 | refactor(release): centralize immutable candidate verification | ported | present before 2026-11-27: .github/actions/verify-immutable-release-candidate + scripts/pipeline/release/verify-release-candidate-identity.mjs used by release-verify.yml |
| a7705a88ba1 | 2026-08-11 | feat(release): resume verified immutable candidates safely | ported | present before 2026-11-27: same-path line evidence 761/910 surviving lines found in 0.3 |
| 2aa5ba58863 | 2026-08-12 | fix(release): retain qualified migration admission guard | ported | present before 2026-11-27: 0.3 release.yml qualified_v4_activation_approval input and admission (supersedes the not-implemented guard) |
| 7438a5aedb2 | 2026-08-12 | feat(release): expose analysis and local candidate commands | ported | present before 2026-11-27: same-path line evidence 366/376 surviving lines found in 0.3 |
| 767a40940de | 2026-08-12 | feat(release): select validation from changed risk seams | ported | present before 2026-11-27: same-path line evidence 266/277 surviving lines found in 0.3 |
| 8dee70e415f | 2026-08-12 | test(release): follow canonical hosted control owners | ported | present before 2026-11-27: Contract tests follow canonical hosted owners; 0.3 scripts/release/release_verify.workflow.contract.test.mjs, workflow_secret_hardening.contract.test.mjs exist |
| ce3f344b134 | 2026-08-12 | fix(release): bind hosted admission to exact verified evidence | ported | present before 2026-11-27: same-path line evidence 397/458 surviving lines found in 0.3 |
| 07247d4f696 | 2026-08-14 | feat(issue-triage): separate evidence routing from diagnosis | ported | present before 2026-11-27: same-path line evidence 5/5 surviving lines found in 0.3 |
| 01d1be6986b | 2026-08-16 | feat(release): add issue stage reconciliation | ported | present before 2026-11-27: same-path line evidence 423/432 surviving lines found in 0.3 |
| 31dbe9b3e6e | 2026-08-16 | fix(release): use large Android production worker | missing | apps/ui/eas.json production profile lacks android resourceClass large [MED] |
| 36f1207403f | 2026-08-16 | fix(ui): use full-bleed PWA icon | ported | present before 2026-11-27: ui-web-bundle.mjs:66 requires only 512x512 any icon (maskable dropped) |
| 9d2a606adcb | 2026-08-16 | feat(ui): add installable web app manifest | ported | present before 2026-11-27: same-path line evidence 87/87 surviving lines found in 0.3 |
| dc84bd7e45c | 2026-08-16 | feat(pipeline): add issue handoff automation | ported | present before 2026-11-27: same-path line evidence 387/395 surviving lines found in 0.3 |
| e022735f70c | 2026-08-16 | fix(release): allow cloud mobile builds | missing | 0.3 build-ui-mobile-local.yml hardcodes --native-build-mode local (lines 457,658); no native_build_mode cloud\ [local input, name still local-runner] |
| 8406214b2c3 | 2026-08-17 | feat(release): add GitHub API retry/fallback | ported | present before 2026-11-27: same-path line evidence 111/115 surviving lines found in 0.3 |
| b44a13bc544 | 2026-08-17 | feat(website): new website | ported | present before 2026-11-27: same-path line evidence 63/65 surviving lines found in 0.3 |
| 9300d6ea666 | 2026-08-19 | fix(pipeline): validate TestFlight groups before native builds | ported | present before 2026-11-27: same-path line evidence 166/169 surviving lines found in 0.3 |
| 04b48d57cd9 | 2026-08-20 | test(cli): shard unit suite to bound memory | different | 0.3 tests.yml cli job timeout 25 with its own sharding; no 60-minute requirement |
| 137a5863060 | 2026-08-20 | fix(release): make reusable workflow graph schedulable | ported | present before 2026-11-27: 0.3 release.yml/release-channel.yml grant packages: write and caller permissions; reusable inputs declared |
| 67a1e5b2bbd | 2026-08-20 | fix(release): select Windows minisign from x86_64 archive layout | ported | present before 2026-11-27: same-path line evidence 5/5 surviving lines found in 0.3 |
| 70ad3f03bb0 | 2026-08-20 | fix(ci): restore valid test governance wiring | different | 0.3 governance wiring runs pnpm test:wiring:self in tests.yml (not yarn test:wiring) |
| 01daca7f52d | 2026-08-21 | feat(installer): hand fresh installs to guided setup | ported | present before 2026-11-27: same-path line evidence 618/635 surviving lines found in 0.3 |
| 1655149370a | 2026-08-21 | fix(release): verify the packaged light server stays alive | ported | present before 2026-11-27: same-path line evidence 46/47 surviving lines found in 0.3 |
| 3e77172f6e7 | 2026-08-21 | fix(release): include complete runtime build closures | different | 0.3 Dockerfile is pnpm-based (server-runtime/server-builder stages), yarn runtime closure COPY lines not applicable |
| 6b76118367d | 2026-08-21 | fix(ci): make reusable test job selection explicit | ported | present before 2026-11-27: 0.3 tests.yml select_jobs_explicitly and reusable run_* flags (tests_workflow.reusable_run_flags contract) |
| f64ecb38bec | 2026-08-21 | fix(release): make nightly publication idempotent and retry audits | ported | present before 2026-11-27: 0.3 nightly-dev.yml release_needed/verify_source_ci/nightly_noop; publish-release.mjs retry transfer + audit download retry test |
| 58129ec1216 | 2026-08-22 | fix(release): declare reusable candidate request outputs | ported | present before 2026-11-27: resolve-release-resume.yml declares cli_requested etc. workflow_call outputs |
| 718456b196c | 2026-08-22 | fix(release): unblock exact-SHA validation | n.a. | test-fixture tweaks for exact-SHA validation; installer --no-same-owner behaviour present in 0.3 install.sh |
| d682ebc4768 | 2026-08-22 | ci(docs): upload artifact & Cloudflare deploy | ported | present before 2026-11-27: same-path line evidence 53/53 surviving lines found in 0.3 |
| 25c054244c8 | 2026-08-23 | fix(ui): consume Unistyles shadow updates once | ported | present before 2026-11-27: same-path line evidence 13/13 surviving lines found in 0.3 |
| 28cac1a764b | 2026-08-23 | fix(ci): admit scheduled stress runs | different | 0.3 tests.yml stress job gated via ci_plan/select_jobs_explicitly (timeout 120) |
| 48185fbae5d | 2026-08-23 | merge(dev): integrate concurrent origin changes | n.a. | merge commit; behaviour covered by constituent commits classified individually |
| 55cac617503 | 2026-08-23 | fix(ci): isolate reusable test concurrency | ported | present before 2026-11-27: 0.3 tests.yml concurrency group tests-${{ github.workflow }}-${{ github.ref }}-<namespace> |
| 985f084b324 | 2026-08-23 | fix(ci): budget complete test suites | ported | present before 2026-11-27: same-path line evidence 9/9 surviving lines found in 0.3 |
| c6cba0f59f4 | 2026-08-23 | fix(ci): isolate scheduled stress selection | ported | present before 2026-11-27: same-path line evidence 6/6 surviving lines found in 0.3 |
| 714c0062665 | 2026-08-24 | fix(ci): batch validation failures and partition test lanes | ported | present before 2026-11-27: same-path line evidence 54/65 surviving lines found in 0.3 |
| a879359eb42 | 2026-08-24 | fix(ci): collect and correct validation failures | different | 0.3 tests.yml gate-* lanes and ciSummaryCollector replace per-lane server outcome collection |
| b759c235f02 | 2026-08-24 | fix(ci): expose and stabilize validation lanes | ported | present before 2026-11-27: same-path line evidence 50/62 surviving lines found in 0.3 |
| 1949bf091a0 | 2026-08-26 | fix(ci): complete collected nightly regressions | n.a. | test-contract tweak only (one line, no surviving behaviour); 0.3 tests.yml timeouts set per lane |
| 2fbdc5bb620 | 2026-08-26 | feat(server): package migration support with every binary | ported | present before 2026-11-27: scripts/release/server_postinstall_runner.contract.test.mjs exists in 0.3 |
| 6c2aa7ff4bf | 2026-08-26 | fix(release): align final dispatch contracts | ported | present before 2026-11-27: 0.3 release.yml has no bump dispatch input (final dispatch advertises no version mutation) |
| 7380444c074 | 2026-08-26 | feat(release): support reasoned validation refinements | ported | present before 2026-11-27: release.yml/release-verify.yml include_validation_suites, waive_validation_suites, override_reason; resolve-validation-plan.mjs include/waive |
| a4bffce9a12 | 2026-08-26 | Merge branch 'dev' of https://github.com/happier-dev/happier into dev | n.a. | merge commit; behaviour covered by constituent commits classified individually |
| b401a857915 | 2026-08-26 | fix(ci): preserve and accelerate full collectors | ported | present before 2026-11-27: same-path line evidence 122/125 surviving lines found in 0.3 |
| d136ad2315d | 2026-08-26 | fix(docker): run packaged migrations before server startup | ported | present before 2026-11-27: 0.3 Dockerfile installs apps/server/scripts/run-server.sh as CMD; release-assets-e2e run.sh lacks postgres migration-count check (LOW) |
| ff8b553af07 | 2026-08-26 | fix(ci): stabilize collected release regressions | n.a. | single-line ui_e2e_specs contract-test tweak; test-only |
| a5faa7a9381 | 2026-08-28 | chore(release): raise server runtime candidate aggregate limit to 2 GiB | n.a. | 0.3 has no scripts/pipeline/release/publishing/server-runtime-candidate.mjs aggregate size admission, so no limit to raise |
| 1283e1cc660 | 2026-08-29 | fix(release): update 0.2.11 contract fixtures | n.a. | 0.2.11 version fixture bump in test; version-specific |
| 14696d71d93 | 2026-08-29 | fix(release): bound exact CI lookup by source SHA | ported | present before 2026-11-27: verify-existing-ci.mjs:42 head_sha in workflow-runs endpoint |
| 2469d083a05 | 2026-08-29 | fix(release): wait for exact source CI | missing | verify-existing-ci.mjs has head_sha but no wait on in-progress exact-SHA CI (gh run watch); nightly-dev 180m timeout present. Owner: scripts/pipeline/release/verify-existing-ci.mjs [MED] |
| 28749dbf18c | 2026-08-29 | fix(release): compare component versions by key | different | 0.3 release-notes projection checks compare a single {ui} component via JSON.stringify (build-tauri/promote-ui); key-order issue cannot arise |
| 749fb867d9e | 2026-08-29 | fix(release): update 0.2.11 contract fixtures | n.a. | 0.2.11 version fixture bump in test; version-specific |
| 79b38c56e6a | 2026-08-29 | fix(ci): bound database matrix and accelerate manual lanes | ported | present before 2026-11-27: same-path line evidence 38/42 surviving lines found in 0.3 |
| b79cd8ec488 | 2026-08-29 | fix(release): align change analysis with hmaint | different | 0.3 analyze-release-change requires --channel (no legacy v1 envelope fallback when omitted) |
| cce689463cf | 2026-08-29 | fix(ci): retry minisign bootstrap downloads | ported | present before 2026-11-27: same-path line evidence 11/11 surviving lines found in 0.3 |
| e096d7d2ed4 | 2026-08-29 | fix(release): accept conductor SDK approval field | ported | present before 2026-11-27: same-path line evidence 3/3 surviving lines found in 0.3 |
| f64472fe41f | 2026-08-29 | revert(release): preserve 0.2 conductor semantics | n.a. | revert of earlier conductor channel change; net doc-comment only |
| 3c532b35262 | 2026-08-30 | feat(release): carry the release channel through release change analysis | ported | present before 2026-11-27: 0.3 analyze-release-change.mjs requires --channel and carries it into public API comparisons |
| 49f06343bbc | 2026-08-30 | ci: add all-lane result summary | ported | present before 2026-11-27: same-path line evidence 6/6 surviving lines found in 0.3 |
| 697b86d29ac | 2026-08-30 | chore: merge origin/dev before push | n.a. | merge commit; behaviour covered by constituent commits classified individually |
| 9c3698deebb | 2026-08-30 | ci: harden exact CI handoff and lane evidence | ported | present before 2026-11-27: 0.3 ciSummaryCollector treats any non-success required lane result as failure; release.yml/nightly ci_run_id evidence |
| 9cc87b99d60 | 2026-08-30 | ci(release): accept explicit completed CI attestations | ported | present before 2026-11-27: 0.3 verify-existing-ci --run-id and ci_run_id inputs in release.yml/nightly-dev.yml |
| 9fdc103d246 | 2026-08-30 | feat(ci): publish a lane summary and allow verified canonical-CI reuse | ported | present before 2026-11-27: same-path line evidence 11/12 surviving lines found in 0.3 |
| c1a9437ff92 | 2026-08-30 | ci: guard all-lane summary coverage | different | 0.3 ciSummaryCollector.test.mjs and tests_workflow.metadata_child/triage_journeys contracts replace tests_workflow.aggregate test |
| d488db6ce88 | 2026-08-30 | fix(release): restore explicit CI run lookup | ported | present before 2026-11-27: same-path line evidence 2/2 surviving lines found in 0.3 |
| e9618699638 | 2026-08-30 | feat(release): audit and smoke-test Linux desktop artifacts in CI | ported | present before 2026-11-27: 0.3 tauri/audit-linux-desktop-artifacts.mjs + linux-desktop-artifact-policy.mjs, smoke-linux-appimage(-wayland), install-linuxdeploy action pinned 1-alpha-20251107-1, LINUXDEPLOY_EXCLUDED_LIBRARIES |
| f08ede95021 | 2026-08-30 | fix(release): remove duplicate ci run input | ported | present before 2026-11-27: release.yml declares ci_run_id once (line 15) |
| f71b4ebd63a | 2026-08-30 | ci: collect all lane outcomes and support explicit CI runs | ported | present before 2026-11-27: same-path line evidence 4/4 surviving lines found in 0.3 |
| fedc3b6f255 | 2026-08-30 | fix(release): wait for Linux desktop startup readiness | ported | present before 2026-11-27: same-path line evidence 60/60 surviving lines found in 0.3 |
| 02fcef2a910 | 2026-08-31 | refactor(ci): complete deep certification and narrow package fanout | different | 0.3 tests-dispatch profile set full/fast/custom; package fanout owned by ci_plan + scripts/ci/classify-source-ci-paths.mjs |
| 084cbcbce11 | 2026-08-31 | fix(release): require complete source CI evidence | different | 0.3 completeness via ci_summary/ciSummaryCollector + verify-existing-ci; job timeouts part tracked under f8a89bd0430 |
| 096390bccf1 | 2026-08-31 | fix(ci): collect shared package failures | different | 0.3 shared-packages-unit lane owned by tests.yml + tests_workflow.shared_packages_owner contract |
| 12d469953ca | 2026-08-31 | fix(ci): fail closed on unclassified source | different | 0.3 scripts/ci/classify-source-ci-paths.mjs + ci_plan own source classification |
| 21a704822ef | 2026-08-31 | fix(release): serialize deploy ref promotion | missing | 0.3 promote-deploy-branch.mjs does gh api PATCH force=true; no deploy-ref-cas / force-with-lease + verify; promote-*.yml concurrency keyed by github.ref not deploy ref [MED] |
| 252c93f5ce1 | 2026-08-31 | ci: select affected source checks | missing | 0.3 component-registry.mjs has no workspaceGraph/bootstrap component, so root manifest/pnpm-lock changes do not mark ui/cli/stack/server changed (CI selection itself present via ci_plan) [MED] |
| 584054c3617 | 2026-08-31 | refactor(repo): relocate repository skills under .agents | ported | present before 2026-11-27: same-path line evidence 1/1 surviving lines found in 0.3 |
| 58c3354dfe7 | 2026-08-31 | fix(ci): require admission lanes in summary | different | 0.3 ciSummaryCollector.jobsForSelectedInputs always requires trusted_ref_guard and selected lanes |
| 73dce95470c | 2026-08-31 | refactor(ci): consolidate release setup owners | different | 0.3 uses install-pnpm-dependencies action and .node-version setup instead of enable-corepack-yarn/install-yarn-dependencies |
| 74e07e3ac88 | 2026-08-31 | fix(release): bound long-running workflow jobs | missing | 0.3 build-ui-mobile-local/promote-server/promote-website/build-tauri jobs lack timeout-minutes [MED] |
| 8a8b82428dd | 2026-08-31 | fix(release): bind OTA notes to validation output | ported | present before 2026-11-27: promote-ui.yml OTA publish steps read UPDATE_MESSAGE from needs.validate_candidate.outputs.release_notes_expo_message |
| 8c995c45409 | 2026-08-31 | fix(ci): make custom checks optional outside custom profile | different | 0.3 tests-dispatch custom_checks only meaningful under custom profile; redesigned profiles |
| 979751322b4 | 2026-08-31 | test(release): enforce immutable tag recheck ordering | missing | 0.3 verify-immutable-release-candidate action has no release asset snapshot / tag identity recheck ordering; verify-release-candidate-identity.test lacks it [MED] |
| 9fa249dc6df | 2026-08-31 | fix(release): recheck immutable candidate tag | missing | 0.3 action.yml downloads release by tag with retries but never rechecks candidate tag identity after download (no verify_candidate_tag_identity) [MED] |
| a0b85f5fdd6 | 2026-08-31 | fix(release): grant JIT entitlement to Bun binaries | ported | present before 2026-11-27: same-path line evidence 69/81 surviving lines found in 0.3 |
| b588c407495 | 2026-08-31 | fix(ci): grant reusable workflow permissions | ported | present before 2026-11-27: same-path line evidence 40/46 surviving lines found in 0.3 |
| b8c366ee8ec | 2026-08-31 | ci: add opt-in Blacksmith 8-vCPU pool | missing | 0.3 runner_pool offers only github and blacksmith-linux-4vcpu (tests.yml:3574, tests-dispatch.yml:22); no 8vcpu option [LOW] |
| d23efd10886 | 2026-08-31 | fix(release): reuse exact CI across promotions | missing | 0.3 verify-existing-ci.mjs requires run head_branch === sourceBranch; no promotion-chain (dev->preview->main) exact-SHA CI reuse [MED] |
| e8bc6b1bef1 | 2026-08-31 | refactor(release): shorten verified ship path | ported | present before 2026-11-27: 0.3 release.yml/nightly-dev.yml ci_run_id input, verify-existing-ci --run-id, resolve-release-resume *_requested outputs, project-release-status |
| ea43e6774a1 | 2026-08-31 | fix(release): bind immutable candidate assets | ported b26556ca8e8 | promoter and candidate action bind to the tag signed envelope; by-ID download with asset-set recheck |
| f39a12a1112 | 2026-08-31 | fix(release): grant JIT entitlement to Bun binaries | ported | present before 2026-11-27: same-path line evidence 69/81 surviving lines found in 0.3 |
| 0c526acb334 | 2026-09-01 | fix(ci): bound deploy workflow jobs | missing | deploy.yml and deploy-on-deploy-branch.yml jobs have no timeout-minutes [MED] |
| 1bd6439f063 | 2026-09-01 | fix(deploy): authenticate deploy ref promotion | different | 0.3 promote-deploy-branch.mjs promotes via gh api PATCH with GH_TOKEN; no Git smart-HTTP auth header needed |
| 1dec8f23029 | 2026-09-01 | fix(ci): make release certification hermetic | different | 0.3 daemon/self-host lanes redesigned: tests_workflow.self_host_daemon + daemon_e2e_lane contract tests, tests.yml self-host-daemon-e2e |
| 228ad498025 | 2026-09-01 | fix(release): execute preview version extractors | different | 0.3 release-npm.yml uses npm/resolve-release-metadata.mjs instead of inline node -e extractors |
| 2c2d78b34c6 | 2026-09-01 | fix(ci): collect inner workflow failures | different | 0.3 tests.yml ci_summary uses scripts/release/ciSummaryCollector.mjs (collectCiSummary over needs) |
| 37d57763230 | 2026-09-01 | fix(ci): protect persistent self-hosted runner | n.a. | 0.3 has no self-hosted WSREPL Lima lane or persistent self-hosted runner jobs (grep wsrepl/self-hosted empty in workflows) |
| 5a01dfe9294 | 2026-09-01 | fix(release): sign generated binary manifests | missing | 0.3 publishing/prepare-binary-assets.mjs finalize has no manifestsDir flattening of generated manifests into signed checksums [MED] |
| 5ebbe83e1d5 | 2026-09-01 | fix(release): admit trusted deploy branch refs | ported 06bc01d95ab | hosted-images bundle and deploy-ref admission |
| 69a9751524e | 2026-09-01 | fix(release): use valid codesign entitlement requirement | ported | present before 2026-11-27: same-path line evidence 3/3 surviving lines found in 0.3 |
| 723bd699daa | 2026-09-01 | fix(release): validate reusable workflow inputs | ported | present before 2026-11-27: same-path line evidence 7/7 surviving lines found in 0.3 |
| 8ca549098b5 | 2026-09-01 | fix(release): align conductor capability contract | ported | present before 2026-11-27: pipeline_release_wrapped_release_scripts_cli test uses --secrets-source keychain for hermetic sync-installers |
| 969d5e0c21b | 2026-09-01 | fix(release): preserve mobile publication input types | ported | present before 2026-11-27: promote-ui.yml passes publish_apk_release as quoted "false"/"true" string literals |
| 98ea8fb7673 | 2026-09-01 | fix(release): preserve resumed UI no-op intent | ported | present before 2026-11-27: 0.3 resolve-release-resume.mjs no longer throws on no-op UI intent (no 'no publication action' check) |
| a4f04d503b3 | 2026-09-01 | fix(deploy): bind docs artifacts to candidate | ported | present before 2026-11-27: promote-docs.yml has resolve_source candidate_sha; docs-out artifact keyed env+github.sha, uploaded and downloaded in same run |
| ad5cbcdf96b | 2026-09-01 | fix(release): align legacy analysis and source waivers | ported | present before 2026-11-27: release.yml waive_ci, admit-release.mjs sourceChecksWaived covers CI+MySQL+platform gates; analyze-release-change takes --channel |
| ad5ede37d39 | 2026-09-01 | fix(release): accept completed branch promotion on resume | missing | 0.3 promote-branch.mjs fails if source no longer equals authorized SHA, no early accept when target already equals authorized SHA [MED] |
| c218a307daf | 2026-09-01 | fix(ci): admit trusted pull request merge refs | missing | 0.3 tests.yml trusted_ref_guard only resolves runner pool; no PR merge-ref/event admission; actor gating via release_actor_guard [LOW] |
| c30fbe62372 | 2026-09-01 | refactor(deploy): share Cloudflare credentials | ported | present before 2026-11-27: promote-docs.yml/promote-website.yml deploy_cloudflare uses environment cloudflare-deploy |
| c9bbcb7312b | 2026-09-01 | fix(ci): bound manual dispatch admission jobs | missing | tests-dispatch.yml 'resolve' job has no timeout-minutes in 0.3 [MED] |
| cd2611a85d3 | 2026-09-01 | fix(release): verify flattened candidate manifests | missing | 0.3 artifact-verify-target.mjs has no manifestsInArtifactsRoot; generated channel manifests are not part of the sealed candidate (see 5a01dfe) [MED] |
| dfa2603658b | 2026-09-01 | fix(release): narrow trusted deploy refs | ported 06bc01d95ab | hosted-images bundle and deploy-ref admission |
| edd66aab844 | 2026-09-01 | test(release): enforce canonical promotion authorization | ported | present before 2026-11-27: scripts/release/release_authority.workflow.contract.test.mjs exists in 0.3 with canonical promotion authorization checks |
| f8a89bd0430 | 2026-09-01 | fix(ci): bound every workflow runner job | missing | 0.3 workflows: ~80 timeout-minutes vs 199 in 0.2; most non-reusable jobs (publish-*, cli-smoke, release-verify, issue-triage, roadmap, providers-contracts, publish-ui-mobile-dev) unbounded [MED] |
| f9b73b2258b | 2026-09-01 | fix(ci): gate extended certification admission | different | 0.3 tests-dispatch has profiles full/fast/custom; extended DB is separate extended-db-tests.yml (scheduled); no extended_db job to gate |
| fb2066e57ac | 2026-09-01 | fix(release): grant transitive verifier permissions | ported | present before 2026-11-27: same-path line evidence 37/38 surviving lines found in 0.3 |
| fb441cf6683 | 2026-09-01 | fix(release): bind rolling promotion source identity | ported | present before 2026-11-27: publish-* workflows take authorized_sha; resume verified via verify-release-candidate-identity.mjs; nightly passes authorized_sha (retry-tag recheck not confirmed) |
| fc44004ad79 | 2026-09-01 | fix(deploy): bootstrap Cloudflare preview workers | missing | 0.3 promote-docs/website inline wrangler: preview uses 'versions upload' only; no bootstrap when Worker does not exist; no scripts/pipeline/cloudflare/publish-worker.sh [MED] |
| 0632073870b | 2026-09-02 | fix(release): complete UI publication lifecycle | ported | present before 2026-11-27: promote-ui full expo_action, rolling asset plan aliases, release status deploy_ui all in 0.3; only dispatch validation of ui_expo_action/desktop_mode lacks (LOW) |
| 19a642a1d88 | 2026-09-02 | fix(release): reuse npm candidate versions on resume | ported | present before 2026-11-27: release-npm.yml has cli_version/stack_version/server_version candidate inputs ("Already-admitted ... candidate version to reuse") |
| 2ee8117013a | 2026-09-02 | fix(deploy): authenticate server Git transport | ported | present before 2026-11-27: promote-server.yml pushes bump with http.extraheader basic x-access-token auth |
| 5deb6dda5cf | 2026-09-02 | fix(release): run npm recovery from trusted control | ported | present before 2026-11-27: release-npm.yml runs trusted-control scripts with --repo-root "$GITHUB_WORKSPACE" on candidate checkout |
| 6be4d6aa1d1 | 2026-09-02 | fix(release): publish mobile assets from trusted control | ported | present before 2026-11-27: same-path line evidence 172/206 surviving lines found in 0.3 |
| 6d3370db582 | 2026-09-02 | feat(release): expose audited main reset mode | ported | present before 2026-11-27: same-path line evidence 32/40 surviving lines found in 0.3 |
| 6f348c75832 | 2026-09-02 | fix(release): reuse verified rolling projections | ported | present before 2026-11-27: 0.3 resolve-release-resume.mjs/resolve-release-resume.yml carry *_rolling_complete outputs into release-channel.yml |
| 801218c3531 | 2026-09-02 | fix(release): retain completed resume surfaces | ported | present before 2026-11-27: resolve-release-resume.yml exports deploy_*_complete/docker_complete/npm_complete; set-preview-versions.mjs allowExistingExactVersion |
| 8937ce8dd0b | 2026-09-02 | fix(release): avoid duplicate UI source tests | ported | present before 2026-11-27: release-channel.yml deploy_ui/docs reusable calls pass run_tests: false |
| 8cf3c404d69 | 2026-09-02 | fix(release): preserve observable promotion evidence | missing | release-channel.yml:1560 sets verify_deploy_server true even if HAPPIER_SERVER_API_*_VERSION_URL unset; release-verify.yml does test -n and fails (0.2 records 'unobserved') [MED] |
| 9b30af128ba | 2026-09-02 | fix(release): admit exact stable Docker resumes | ported | present before 2026-11-27: publish-docker.yml accepts exact resumed SHA (0.3 docker publish flow); no source_ref=main rejection found |
| a25dc4782e0 | 2026-09-02 | refactor(release): keep source contracts out of finalizers | ported | present before 2026-11-27: publish-cli-binaries.yml / publish-ui-web.yml finalizers use --run-contracts false |
| b39ff26130f | 2026-09-02 | fix(release): install trusted OTA publisher runtime | different | promote-ui.yml installs trusted promotion deps via install-pnpm-dependencies action (pnpm, not yarn/corepack) |
| c3b3bcd4ca1 | 2026-09-02 | fix(release): raise Android Gradle heap | missing | apps/ui/eas.json: only publicdev-apk has HAPPIER_ANDROID_GRADLE_JVMARGS; base/production-preview(-apk) lack it (app.config.js override exists) [MED] |
| c6b87070da3 | 2026-09-02 | fix(release): bootstrap APK retry verifier | ported | present before 2026-11-27: same-path line evidence 2/2 surviving lines found in 0.3 |
| cf54a55361e | 2026-09-02 | fix(release): clean abandoned staging drafts | ported | present before 2026-11-27: same-path line evidence 37/40 surviving lines found in 0.3 |
| ded2bf53769 | 2026-09-02 | fix(release): tolerate npm dist-tag propagation lag | ported | present before 2026-11-27: same-path line evidence 32/32 surviving lines found in 0.3 |
| e078596702b | 2026-09-02 | fix(release): admit mounted Docker fixture repo | ported | present before 2026-11-27: release-assets-e2e/bin/stack-entrypoint.sh adds safe.directory for mounted repo; npm_e2e_smoke test asserts it |
| ee3d30a4bbd | 2026-09-02 | fix(release): handle large tracked path sets | missing | compute-versioned-component-changes.mjs runGit uses spawnSync without maxBuffer (default 1 MiB); 0.3 tracked path list is ~4.5 MB [MED] |
| f00578e80ad | 2026-09-02 | fix(release): bind UI promotion candidate SHA | ported | present before 2026-11-27: promote-ui.yml checks out exact candidate from resolve_source.outputs.candidate_sha ("Checkout exact candidate as inert data") |
| f9f55ccce77 | 2026-09-02 | fix(release): admit verified stable resumes | missing | resolve-bump-plan.mjs refuses production cli/stack/server when dev==main with no --resume-*-version exemption (lines 214-248) [MED] |
| fd6f9eba52d | 2026-09-02 | test(release): isolate bump-plan git fixture | n.a. | test fixture isolation only; 0.3 has pipeline_release_bump_plan_script.contract.test.mjs with its own fixtures |
| ff88ecc72f3 | 2026-09-02 | fix(release): isolate mobile publication concurrency | ported | present before 2026-11-27: build-ui-mobile-local.yml concurrency group already keyed by source_ref/env/platform/profile/action, cancel-in-progress false |
| 16bc2d3af5d | 2026-09-03 | fix(ci): route shared Corepack changes through all lanes | different | Corepack/yarn replaced by pnpm (scripts/ci/setup-pnpm.mjs); path filters redesigned |
| 33ad81820bc | 2026-09-03 | Add files via upload | n.a. | README/image artwork only; no pipeline behaviour |
| 36fbfe74a03 | 2026-09-03 | Rename promo_big.jpg to hero.jpg | n.a. | README/image artwork only; no pipeline behaviour |
| 395dd0d4e29 | 2026-09-03 | Add hero.png | n.a. | README/image artwork only; no pipeline behaviour |
| 4074dd0773d | 2026-09-03 | Delete .github/hero.jpg | n.a. | README/image artwork only; no pipeline behaviour |
| 4ab960c5c85 | 2026-09-03 | fix(release): normalize Android retry profiles | ported | present before 2026-11-27: prepare-static-submit-workspace.mjs normalizes profile via normalizeMobileReleaseProfile |
| 693f620cf59 | 2026-09-03 | fix(release): reconcile TestFlight group attachment route | ported | present before 2026-11-27: same-path line evidence 24/24 surviving lines found in 0.3 |
| 88c0f065036 | 2026-09-03 | fix(release): await Android submission recovery | ported | present before 2026-11-27: build-ui-mobile-local.yml retry_android_store_submit uses --wait true |
| 8984999d2ff | 2026-09-03 | fix(release): retry transient native publication setup | ported | present before 2026-11-27: same-path line evidence 98/106 surviving lines found in 0.3 |
| ae50d8cc305 | 2026-09-03 | fix(release): isolate Android submit recovery | ported | present before 2026-11-27: prepare-static-submit-workspace.mjs + build-ui-mobile-local.yml isolated submit workspace |
| b0d61b90c8c | 2026-09-03 | test(release): follow relocated skill entrypoints | n.a. | Test-only path update for relocated skill entrypoints (0.2 skill layout) |
| b0e245d9ee0 | 2026-09-03 | Add hero | n.a. | README/image artwork only; no pipeline behaviour |
| c191453d2ff | 2026-09-03 | fix(release): grant mobile recovery artifact reads | ported | present before 2026-11-27: same-path line evidence 2/2 surviving lines found in 0.3 |
| c3bcee844b6 | 2026-09-03 | fix(release): bind npm publish to finalized candidates | ported | present before 2026-11-27: release-npm.yml cli/stack/server_version inputs; publish-tarball.mjs dist-tag retry; promote-rolling-release.mjs stale staging-draft cleanup |
| c462a8c2c8a | 2026-09-03 | fix(release): resume TestFlight distribution | ported | present before 2026-11-27: build-ui-mobile-local.yml has retry_testflight_distribution job and contract test; plus dispatch-testflight-reconciliation.mjs |
| d42afe0a2d8 | 2026-09-03 | chore(repo): merge origin/dev into dev | n.a. | Merge commit with no own pipeline change |
| e85d4b1d4cc | 2026-09-03 | fix(release): resume Android store submission | ported | present before 2026-11-27: build-ui-mobile-local.yml retry_android_store_submit, retry_store_run_id/source_sha, candidate-identity.json |
| eaa36b6a703 | 2026-09-03 | fix(release): report mobile submit failures | ported | present before 2026-11-27: submit.mjs exits 1 when any submission failed; artifact upload runs always() |
| fae81c0bf3f | 2026-09-03 | fix(ci): harden release contract execution | ported | present before 2026-11-27: testflight-distribute.mjs ignores build-json in dry-run; trusted_ref_guard runner selection in tests.yml |
| ffb10330279 | 2026-09-03 | fix(release): publish stable download aliases | ported | present before 2026-11-27: same-path line evidence 6/6 surviving lines found in 0.3 |
| 813faffa0e2 | 2026-09-06 | feat(setup): add guided terminal presentation | ported | present before 2026-11-27: same-path line evidence 243/266 surviving lines found in 0.3 |
| 072ed041770 | 2026-09-07 | feat(release): publish preview and stable together | ported | present before 2026-11-27: 0.3 release.yml supports environment preview-and-production with combined validation/promotion |
| 0fef786bd03 | 2026-09-07 | test(release): cover truthful installer presentation | ported | present before 2026-11-27: same-path line evidence 64/73 surviving lines found in 0.3 |
| d06e287b42e | 2026-09-07 | chore(brand): refresh the repository hero artwork | n.a. | README/image artwork only; no pipeline behaviour |
| 25eace5ee7a | 2026-09-08 | test(ci): stabilize release validation harnesses | n.a. | Test-harness stabilization (runVitestShards, ui-e2e spec helpers, pack-only contract test); not pipeline behaviour |
| f377c245fe6 | 2026-09-08 | fix(ci): stabilize complete validation lanes | different | 0.3 ui-e2e uses 18 shards and gate-unit parts; 0.2 shard counts are 0.2 tuning |
| 0b33c435233 | 2026-09-09 | fix(release): run npm recovery from trusted control | ported | present before 2026-11-27: same-path line evidence 8/8 surviving lines found in 0.3 |
| 1063e8fdd78 | 2026-09-09 | fix(release): isolate combined channel artifacts | ported | present before 2026-11-27: same-path line evidence 18/19 surviving lines found in 0.3 |
| 6db015df894 | 2026-09-09 | fix(ci): stabilize platform validation boundaries | ported | present before 2026-11-27: same-path line evidence 4/4 surviving lines found in 0.3 |
| 93a3b96ee74 | 2026-09-09 | fix(release): resume published npm candidates | ported | present before 2026-11-27: same-path line evidence 19/19 surviving lines found in 0.3 |
| 9a8e2b6bc66 | 2026-09-09 | fix(tests): admit mounted Git directory in Docker smoke | ported | present before 2026-11-27: release-assets-e2e/bin/stack-entrypoint.sh admits mounted .git safe.directory |
| aa0395fe6a3 | 2026-09-09 | fix(ci): authorize maintainer diagnostic dispatches | ported | present before 2026-11-27: same-path line evidence 1/1 surviving lines found in 0.3 |
| b4a38d932a7 | 2026-09-09 | fix(installer): select compatible Windows minisign | ported | present before 2026-11-27: same-path line evidence 7/8 surviving lines found in 0.3 |
| c323b22af94 | 2026-09-09 | fix(ci): validate checkout installers in manual runs | ported | present before 2026-11-27: tests-dispatch.yml:164-165 installers_source local-build, installers_ref . |
| 05fbc3cacad | 2026-09-10 | fix(release): retry immutable candidate reads | ported | present before 2026-11-27: verify-immutable-release-candidate/action.yml:74-92 4-attempt retry with backoff |
| 19300335221 | 2026-09-10 | fix(release): reuse immutable mobile APKs | ported | present before 2026-11-27: same-path line evidence 20/21 surviving lines found in 0.3 |
| 31c4d6dd725 | 2026-09-10 | fix(release): reuse recoverable delivery outputs | ported | present before 2026-11-27: same-path line evidence 6/6 surviving lines found in 0.3 |
| 3a605d7d8da | 2026-09-10 | fix(release): publish stable rolling payload names | ported | present before 2026-11-27: same-path line evidence 10/11 surviving lines found in 0.3 |
| 4a52430b73b | 2026-09-10 | ci(release): consolidate validation and recovery | ported | present before 2026-11-27: same-path line evidence 618/664 surviving lines found in 0.3 |
| e46716e2472 | 2026-09-10 | fix(release): retry rolling asset audits | ported | present before 2026-11-27: promote-rolling-release.mjs asset read retries (HAPPIER_PIPELINE_GH_ASSET_READ_ATTEMPTS) |
| 19078250b10 | 2026-09-11 | ci: retry transient Sapling downloads | ported | present before 2026-11-27: install_sapling_ubuntu22.sh curl --retry 4 etc.; contract test exists |
| 416dcc302ea | 2026-09-11 | ci: collect package and build failures | different | 0.3 gate-prepare/gate-compiler/gate-unit/gate-build-artifacts + ci_summary collector |
| 98812f8ae4c | 2026-09-11 | fix(installer): avoid GNU awk regex warnings | ported | present before 2026-11-27: same-path line evidence 26/26 surviving lines found in 0.3 |
| a9b360a3e55 | 2026-09-11 | fix(installer): resolve rolling release aliases | ported | present before 2026-11-27: install.sh and install.ps1 resolve rolling aliases via checksums asset, versioned tag when --version |
| b31312d8ef5 | 2026-09-11 | fix(release): retain versioned rolling assets | ported | present before 2026-11-27: rolling-release-asset-plan.mjs retains immutable assets plus aliases (differs from 0.2 HEAD only in comments) |
| cef25ecb2fb | 2026-09-11 | test(cli): route daemon stress through local server | ported | present before 2026-11-27: tests.yml runs daemon.spawnStop.stress.slow with HAPPIER_CLI_DAEMON_SPAWN_STOP_STRESS_INTEGRATION |
| d531a3f71ed | 2026-09-11 | fix(release): normalize deferred TestFlight profile | ported | present before 2026-11-27: same-path line evidence 1/1 surviving lines found in 0.3 |
| e115d691b44 | 2026-09-11 | refactor(release): simplify promotion and validation workflows | different | 0.3 reshaped release workflows (release.yml combined preview+production, release-channel, release-npm as workflow_call); 0.2 commit was a contraction later re-expanded |
| faf7e03471a | 2026-09-11 | fix(stack): make Expo and remote supervision load-safe | n.a. | Superseded within 0.2 (run.mjs flip-flop; HEAD restored HAPPIER_PIPELINE_REPO_ROOT/testflight-distribution-mode, 0.3 matches HEAD); rest is apps/stack |
| a8588e169fb | 2026-09-13 | chore: reconcile dev histories | ported | present before 2026-11-27: same-path line evidence 1/1 surviving lines found in 0.3 |
| b20a53b8a6e | 2026-09-13 | merge(dev): reconcile configured ACP resume ownership | n.a. | merge commit; behaviour covered by constituent commits classified individually |
| e6a20052941 | 2026-09-13 | feat(installer): hand fresh interactive installs to guided setup | ported | present before 2026-11-27: same-path line evidence 134/137 surviving lines found in 0.3 |
| 1fe76ce4f4d | 2026-09-16 | fix(ci): restore complete nightly validation | missing | nightly-dev.yml prepare_release_candidate builds dev HEAD; 0.2 schedules select the newest certified dev SHA (ci_available/candidate_sha, ancestor check, blocked_ci decision); port into nightly-dev.yml [MED] |
| 28ad78fb2cf | 2026-09-16 | fix(ci): stabilize complete validation lanes | missing | build-smoke job lacks VITE_POSTHOG_KEY/NEXT_PUBLIC_POSTHOG_KEY empty env; analytics keys are not exposed to PR CI anyway [LOW] |
| c5b928705ca | 2026-09-16 | Add files via upload | n.a. | README/image artwork only; no pipeline behaviour |
| be5542d0958 | 2026-09-17 | fix(codex): preserve Unix WebSocket transport in Bun binaries | ported | present before 2026-11-27: 0.3 pins Bun 1.4.4 via apps/stack/scripts/provision/.bun-version (>= 1.4.2) |
| 3b66fe42925 | 2026-09-18 | Merge origin/dev into dev | n.a. | merge commit; behaviour covered by constituent commits classified individually |
| 59102bf8ab5 | 2026-09-18 | chore(repo): remove unused Discord artwork | n.a. | README/image artwork only; no pipeline behaviour |
| 568090f969c | 2026-09-19 | fix(release): verify rolling release metadata | ported | present before 2026-11-27: same-path line evidence 42/51 surviving lines found in 0.3 |
| a91d585081d | 2026-09-19 | Merge pull request #401 from karolzlot/codex-bun-unix-websocket | ported | present before 2026-11-27: bun bumped: apps/stack/scripts/provision/.bun-version 1.4.4 (Codex unix-websocket transport test not applicable: UnixWebSocket absent in 0.3) |
| 5ba6fdbe0f8 | 2026-09-21 | docs: refresh the project overview and install links | ported | present before 2026-11-27: same-path line evidence 227/231 surviving lines found in 0.3 |
| ba762079128 | 2026-09-21 | docs: make the desktop app the primary setup path | n.a. | README/readme art (download-desktop svg) |
| bf934b41893 | 2026-09-21 | docs: expand remote setup and continuity guidance | n.a. | README/readme art (supported-agents svg) |
| 21e8d0bbf7e | 2026-09-22 | fix(desktop): reopen actool stdin at the Tauri tool boundary | ported | present before 2026-11-27: same-path line evidence 129/137 surviving lines found in 0.3 |
| 34f8293603f | 2026-09-22 | test(release): isolate published-version discovery from network state | ported | present before 2026-11-27: same-path line evidence 21/25 surviving lines found in 0.3 |
| 4494cc5e737 | 2026-09-22 | fix(release): isolate Tauri file-key signer environment | ported | present before 2026-11-27: same-path line evidence 113/120 surviving lines found in 0.3 |
| 48c6b41be0f | 2026-09-22 | fix(release): resume preserved desktop build candidates | ported | present before 2026-11-27: same-path line evidence 287/293 surviving lines found in 0.3 |
| 4e56d53cbe2 | 2026-09-22 | fix(ci): collect independent failures and balance shard work | ported | present before 2026-11-27: scripts/pipeline/checks/run-checks.mjs uses runCommandSuite per check; tests-dispatch.yml has cli_update_to_source and resolve-checks-plan |
| 69613e1a89e | 2026-09-22 | fix(release): preserve desktop publication across skipped resume jobs | ported | present before 2026-11-27: same-path line evidence 20/20 surviving lines found in 0.3 |
| 73a98b873c3 | 2026-09-22 | fix(release): defer TestFlight distribution to exact-build recovery | ported | present before 2026-11-27: same-path line evidence 350/374 surviving lines found in 0.3 |
| 862e8dc9091 | 2026-09-22 | fix(ci): authenticate CLI release validation | ported | present before 2026-11-27: same-path line evidence 17/17 surviving lines found in 0.3 |
| f4f32db935b | 2026-09-22 | fix(release): retry interrupted asset audit downloads | ported | present before 2026-11-27: same-path line evidence 109/132 surviving lines found in 0.3 |
| 4882166151c | 2026-09-23 | feat(release): publish target-projected CLI runtimes | ported | present before 2026-11-27: publish-cli-binaries.yml signs/verifies happier, happier-memory-runtime, happier-voice-runtime, happier-difftastic; product-specs.mjs and cli-common componentArtifacts present |
| 4bc3768f9ec | 2026-09-23 | fix(desktop): ship the real app icon and the styled DMG window | ported | present before 2026-11-27: same-path line evidence 3/3 surviving lines found in 0.3 |
| d3d0c84a02b | 2026-09-23 | fix(release): audit immutable assets before publication | ported | present before 2026-11-27: same-path line evidence 82/96 surviving lines found in 0.3 |
| 439125d1758 | 2026-09-24 | fix(cli): harden native runtime artifact projection | ported | present before 2026-11-27: same-path line evidence 22/22 surviving lines found in 0.3 |
| 0643de8eb4c | 2026-09-25 | feat(release): publish Homebrew packages | ported 654c3455112 | tap job no-op until HOMEBREW_TAP_REPO_NAME is set; renderer reads checksums by exact name (0.3 releases also carry component checksums) |
| 3266406e991 | 2026-09-25 | feat(setup): manage first-party setup and updates | missing | Desktop setup/update gate (desktop-setup, -artifacts, -driver harness + tests/build-tauri/release-verify wiring) absent; hsetup product code lives in apps/bootstrap (present) [MED] |
| 6525fe57ffc | 2026-09-25 | fix(ci): stabilize release contracts and native model preflight | ported | present before 2026-11-27: publish-server-runtime.yml promote_existing installs deps (pnpm); release-runtime test fixtures not needed for behaviour |
| e0976cd0cad | 2026-09-25 | fix(release): gate desktop publication on candidate setup validation | missing | desktop-setup release gate (scripts/release/release-assets-e2e/desktop-setup*.mjs, build-tauri desktop_setup job, registry suite) absent in 0.3; build-tauri has no candidate_cli_version gating desktop publication [MED] |
| edd775dc5c6 | 2026-09-25 | fix(release): validate desktop setup from the built bundle | missing | desktop-setup release gate (scripts/release/release-assets-e2e/desktop-setup*.mjs, build-tauri desktop_setup job, registry suite) absent in 0.3 [MED] |
| f2378118306 | 2026-09-25 | test(release): align integrated validation profile contract | n.a. | single-line test fixture alignment; test-only |
| 5e5c40193fe | 2026-09-26 | fix(release): use canonical Corepack in rolling recovery | different | Corepack/yarn replaced by pnpm (install-pnpm-dependencies, scripts/ci/setup-pnpm.mjs) |
| aa33101c644 | 2026-09-26 | fix(release): publish dev APK with fresh App token | missing | 0.3 publish-ui-mobile-dev.yml publishes dev APK inside build steps with job github.token; 0.2 builds with --publish-apk-release false then mints fresh App token (apk_token) and publishes; port into publish-ui-mobile-dev.yml [MED] |
| b6805d6592e | 2026-09-26 | fix(release): prepare dependencies in rolling promotions | ported | present before 2026-11-27: publish-{cli,hstack,server,runner,ui-web}-*.yml promote_existing jobs install-pnpm-dependencies; build-tauri promote_stable_feed script has no workspace imports |
| cfe91453713 | 2026-09-26 | fix(release): prepare trusted artifact verifier dependencies | ported a108f9a9342 | pnpm install --ignore-scripts + release-runtime build in .release-control |
| bfdfd78b5bd | 2026-09-28 | fix(desktop): lay out the DMG window and keep the Dock icon's notch transparent | ported | present before 2026-11-27: same-path line evidence 226/226 surviving lines found in 0.3 |
| 4841e672250 | 2026-09-29 | test(release): expose remote SSH startup diagnostics | missing | release-assets-e2e/run.sh lacks remote-server1 ssh diagnostics on startup failure [LOW] |
| 56f026265e2 | 2026-09-29 | test(release): expose systemd startup failure in Docker smoke | missing | Dockerfile.remote-host-systemd lacks SYSTEMD_LOG_TARGET/LEVEL env (smoke diagnostics) [LOW] |
| 6b1840916e0 | 2026-09-29 | fix(release): trust mounted git source in Docker smoke | ported | present before 2026-11-27: release-assets-e2e/bin/stack-entrypoint.sh adds safe.directory for $HSTACK_HAPPIER_REPO/.git |
| 72b61956171 | 2026-09-29 | fix(release): resume npm and APK publication from verified candidates | ported | present before 2026-11-27: build-ui-mobile-local.yml installs release-runtime verifier deps; set-preview-versions.mjs has allowExistingExactVersion |
| 7cdc78709d9 | 2026-09-29 | test(release): cover preview npm catch-up after binary publication | ported | present before 2026-11-27: same-path line evidence 2/2 surviving lines found in 0.3 |
| de493887ba7 | 2026-09-29 | fix(release): await npm tag propagation after trusted publish | ported | present before 2026-11-27: same-path line evidence 39/39 surviving lines found in 0.3 |
| e04a742988c | 2026-09-29 | fix(release): boot systemd smoke hosts with private cgroups | ported | present before 2026-11-27: release-assets-e2e Dockerfile.remote-host-systemd has no cgroup VOLUME; compose.remote.yml privileged without host cgroup mount |
| e477ba0dce6 | 2026-09-29 | fix(release): retain upgrade validation on resume | ported | present before 2026-11-27: same-path line evidence 5/5 surviving lines found in 0.3 |
| 39c81fc62bf | 2026-09-30 | fix(release): bootstrap relay validation outside slim image | ported | present before 2026-11-27: same-path line evidence 17/17 surviving lines found in 0.3 |
| 3db13d6a5e5 | 2026-09-30 | fix(release): scope immutable relay validation to upgrade | ported | present before 2026-11-27: same-path line evidence 8/8 surviving lines found in 0.3 |
| 7a4c6da269b | 2026-09-30 | fix(release): isolate npm recovery contract credentials | ported | present before 2026-11-27: release-npm.yml:416 unset NODE_AUTH_TOKEN NPM_TOKEN in release contract tests step |
| 7d9952636e8 | 2026-09-30 | fix(release): run artifact validation from trusted control | ported | present before 2026-11-27: same-path line evidence 11/11 surviving lines found in 0.3 |
| 88d45f33a5e | 2026-09-30 | fix(release): keep registry auth out of npm candidate setup | ported | present before 2026-11-27: 0.3 release-npm.yml candidate setup has no registry-url; only publish setups do |
| 923d6a211a8 | 2026-09-30 | fix(release): isolate channel artifacts and repair publication controls | ported | present before 2026-11-27: Env-scoped tauri-candidate/updates/desktop-assets and profile-scoped ui-mobile artifact names, permission-workflows in promote workflows, lazy firstPartyRuntime import; retry download is by name (no inspectReleaseResumeArtifact step) |
| f784e6b7caa | 2026-09-30 | fix(release): remove ambient npm credentials from contract tests | ported | present before 2026-11-27: same-path line evidence 4/4 surviving lines found in 0.3 |
| 208c07a7680 | 2026-10-01 | fix(release): reconcile accepted npm publication without republishing | ported | present before 2026-11-27: same-path line evidence 93/106 surviving lines found in 0.3 |
| d2e97f110b1 | 2026-10-01 | fix(release): resume finalized desktop and completed mobile flows | ported | present before 2026-11-27: build-tauri.yml reuse_finalized/resume_desktop_finalized_artifacts; resolve-release-resume.mjs finalizedArtifacts; bundle-candidate.mjs resume-finalized flag (desktop-setup part: see fce10a3ee63) |
| b0b8cdee787 | 2026-10-02 | Merge remote-tracking branch 'origin/dev' into dev | n.a. | merge commit; behaviour covered by constituent commits classified individually |
| fc1c07304a8 | 2026-10-02 | feat(ui): modernize desktop setup and native shell controls | ported | present before 2026-11-27: same-path line evidence 44/44 surviving lines found in 0.3 |
| 45bd83c934f | 2026-10-03 | feat(cli): lit Braille planet for setup, auth and installers; one shared step printer (#457) | ported | present before 2026-11-27: same-path line evidence 261/288 surviving lines found in 0.3 |
| 94e6116c42f | 2026-10-03 | fix(ci): select desktop setup browser checks for runtime changes | ported | present before 2026-11-27: 0.3 tests.yml ui-e2e paths filter includes apps/bootstrap/** and packages/cli-common/** |
| 98004038950 | 2026-10-03 | merge: sync origin/dev batch merges into local dev | n.a. | merge commit; behaviour covered by constituent commits classified individually |
| 045ca7158b0 | 2026-10-04 | test(ci): retain trust guard without forbidding build prerequisites | n.a. | Test-only assertion on 0.2 build-cli job needs; 0.3 has no such job |
| 1334baef738 | 2026-10-04 | test(ci): verify restored executable behavior under host umask | different | install-pnpm-dependencies prepared-artifact path replaces download-ci-cli-build action |
| 2dde3170ec9 | 2026-10-04 | test(ci): remove superseded constant concurrency assertion | n.a. | test-only deletion/pruning of copied inventories; 0.3 keeps its own consolidated contract tests |
| 2de40399a1c | 2026-10-04 | ci: cache installed Yarn dependencies with fresh workspace setup | different | install-pnpm-dependencies caches pnpm store, frozen install always runs |
| 3848c40a91c | 2026-10-04 | fix(ci): normalize Windows shared-build extraction destination | different | install-pnpm-dependencies prepared-artifact path replaces download-ci-cli-build action |
| 4b80c443c54 | 2026-10-04 | ci: cancel superseded pull request test runs | ported | present before 2026-11-27: tests.yml concurrency cancel-in-progress for pull_request |
| 4cc7f4d64eb | 2026-10-04 | ci(dispatch): expose existing local installer build source | ported | present before 2026-11-27: tests-dispatch.yml has installers_source (local-build) input forwarded to tests.yml |
| 528dcd64e0d | 2026-10-04 | ci(build): reuse one CLI build across test consumers | different | 0.3 gate-build-artifacts redesign; installers-smoke-local-build.mjs builds assets per consumer (no HAPPIER_RELEASE_ASSETS_DIR reuse of a shared build); speed only |
| 5c5caf9174f | 2026-10-04 | test(installer): exercise Windows promotion runtime closure | ported | present before 2026-11-27: same-path line evidence 46/46 surviving lines found in 0.3 |
| 5f5ff2dff48 | 2026-10-04 | fix(ci): propagate nightly classifier read permission | ported | present before 2026-11-27: nightly-dev.yml and tests-dispatch.yml carry actions: read/write for the classifier |
| 61d74ad2b70 | 2026-10-04 | ci: keep v0.3 pull requests out of the dev test workflow | n.a. | 0.2-only: keeps v0.3 PRs out of 0.2 tests workflow; 0.3 tests.yml includes v0.3 |
| 64d172219b9 | 2026-10-04 | test(ci): remove redundant workflow inventories | n.a. | test-only deletion/pruning of copied inventories; 0.3 keeps its own consolidated contract tests |
| 64fa740083b | 2026-10-04 | ci: emit stable fail-closed CLI and UI unit results | different | 0.3 gate-unit/ui/cli aggregate jobs plus ci_summary fail-closed collector |
| 68cf5ba981e | 2026-10-04 | fix(ci): let binary preparation own the versioned CLI build | different | 0.3 gate-build-artifacts owns the CLI build |
| 743c8ceb989 | 2026-10-04 | test(ci): reconcile build dependency and environment fixture fixes | ported | present before 2026-11-27: tests_workflow.released_server_v021 contract test exists in 0.3 |
| 917bb9858a4 | 2026-10-04 | test(release): prune workflow transcription and path inventories | n.a. | test-only deletion/pruning of copied inventories; 0.3 keeps its own consolidated contract tests |
| 93c9cc84ae2 | 2026-10-04 | test(ci): isolate setup fixtures from prepared build mode | ported | present before 2026-11-27: tests_workflow.released_server_v021 contract test exists in 0.3 |
| 9419cfd67c9 | 2026-10-04 | fix(ci): install cross-target binary prerequisites in the producer | different | 0.3 gate-build-artifacts builds CLI/binaries itself (pnpm); no shared build-cli producer job |
| 9b2dddeda1d | 2026-10-04 | fix(installer): quote Windows promotion script paths | ported | present before 2026-11-27: same-path line evidence 1/1 surviving lines found in 0.3 |
| a061461dda9 | 2026-10-04 | test(installer): normalize native checkout line endings | ported | present before 2026-11-27: same-path line evidence 11/13 surviving lines found in 0.3 |
| a9b035f878a | 2026-10-04 | test(installer): cover native promotion temp-path quoting | ported | present before 2026-11-27: same-path line evidence 1/1 surviving lines found in 0.3 |
| ac6fab2c74e | 2026-10-04 | test(installer): verify detached promotion without synthetic sidecars | ported | present before 2026-11-27: same-path line evidence 7/7 surviving lines found in 0.3 |
| c540e4c6bd5 | 2026-10-04 | test(ci): prune copied vocabulary and matrix spellings | n.a. | test-only deletion/pruning of copied inventories; 0.3 keeps its own consolidated contract tests |
| cabfa392aaa | 2026-10-04 | fix(ci): restore shared archives with portable local paths | different | install-pnpm-dependencies prepared-artifact path replaces download-ci-cli-build action |
| cdc2b9a2e21 | 2026-10-04 | ci(e2e): gate pushes on smoke journeys and run full UI nightly | different | 0.3 tests.yml runs full 18-shard ui-e2e on push; no smoke/nightly split |
| d909b4d6744 | 2026-10-04 | fix(ci): use the canonical Windows binary target | different | 0.3 gate-build-artifacts owns binary target selection |
| da424ee4a85 | 2026-10-04 | ci(release): reuse source CI release-contract certification | different | 0.3 release-npm.yml still runs "Run release contract tests"; 0.2 dropped it to reuse source CI (optimization only) |
| e3b1825ac2f | 2026-10-04 | ci: report policy self-tests without blocking typecheck | different | 0.3 gate-compiler/typecheck reporting redesigned |
| f2b00b1dfda | 2026-10-04 | ci(ui): run eight shards with three configured forks | different | 0.3 gate-unit partitions UI vitest via HAPPIER_UI_VITEST_PART(S) |
| fc88c71b1b5 | 2026-10-04 | fix(ci): refresh every workspace setup owner on cache hits | different | install-pnpm-dependencies runs frozen install on cache hits |
| 208d333bc90 | 2026-10-05 | fix(ci): collect CLI source failures when the shared build fails | different | 0.3 gate-unit + ci_summary via scripts/release/ciSummaryCollector.mjs collect independent lane failures |
| 24b251863ed | 2026-10-05 | test(ci): remove obsolete CLI workflow transcription assertions | n.a. | Test-only removal of obsolete 0.2 CLI workflow assertions; 0.3 tests.yml reshaped |
| 2b869baf529 | 2026-10-05 | ci: use canonical UI shard sizing within existing deadline | ported | present before 2026-11-27: HAPPIER_UI_VITEST_SHARDS constant absent from 0.3 tests.yml (canonical sizing) |
| 07747ad222d | 2026-10-06 | fix(ci): bound dependency cache key globs to workspace manifests | different | yarn cache-key glob; 0.3 pnpm store key hashes lockfile/workspace/package.json/patches (install-pnpm-dependencies/action.yml:52) |
| 1816bc7fcdc | 2026-10-06 | test(install): compare canonical Windows TEMP paths | ported | present before 2026-11-27: same-path line evidence 2/2 surviving lines found in 0.3 |
| 7f6d542fcc8 | 2026-10-06 | fix(tauri): admit read-only service inventory in Linux smoke | different | 0.3 linux-appimage-ipc-probe.mjs owns its own allowlist for 0.3 app startup reads (server list) |
| 935b36f742a | 2026-10-06 | fix(installer): bootstrap universal minisign on macOS | ported | present before 2026-11-27: same-path line evidence 69/70 surviving lines found in 0.3 |
| a6417c8c8ec | 2026-10-06 | fix(install): preserve Windows cleanup results and inventory arrays | ported | present before 2026-11-27: same-path line evidence 103/103 surviving lines found in 0.3 |
| b83201324c6 | 2026-10-06 | fix(installer): use the minisign build for this Windows architecture | ported | present before 2026-11-27: same-path line evidence 76/79 surviving lines found in 0.3 |
| c247a988651 | 2026-10-06 | fix(desktop): build and validate hsetup for the bundle target | ported | present before 2026-11-27: same-path line evidence 100/103 surviving lines found in 0.3 |
| e2221966d54 | 2026-10-06 | fix(ci): keep scoped install lists out of raw cache keys | different | .github/actions/install-pnpm-dependencies replaces install-yarn-dependencies; pnpm store cache keyed on lockfile hashes |
| f51c34c0fe6 | 2026-10-06 | fix(ci): select installer smoke for native Windows contract edits | different | 0.3 tests.yml ci_plan/gate-prepare redesign runs installers smoke on v0.3 without per-file path filters |
| 2f7ba69c386 | 2026-10-07 | test(install): expose native Windows promotion failure results | ported | present before 2026-11-27: same-path line evidence 1/1 surviving lines found in 0.3 |
| dd6e4bfd846 | 2026-10-07 | fix(install): preserve redirected exit codes on Windows PowerShell | ported | present before 2026-11-27: same-path line evidence 18/18 surviving lines found in 0.3 |
| 4c10d450710 | 2026-10-08 | perf(release): accelerate scoped exact-source releases | missing | Same-run preparation_only/use_prepared (promote-ui, build-tauri, publish-ui-mobile-dev) and verify-existing-ci notes-only reuse absent; release speed-up only [LOW] |
| 8defebe84d7 | 2026-10-08 | feat(release): pin new releases to a validated source candidate | ported 05b027c682c | candidate admitted once in release-channel preflight via the resolver; promote-branch ancestor admission and --preserve-target-descendant for sync_dev; issue snapshot already covered by 0.3 candidate-ancestry snapshot |
| f647b174d8d | 2026-10-08 | fix(ci): stabilize ACP cancellation and Sapling setup | ported | present before 2026-11-27: same-path line evidence 39/39 surviving lines found in 0.3 |
| 0b542cb77b2 | 2026-10-09 | fix(release): expose App Store review readiness error codes | ported | present before 2026-11-27: scripts/pipeline/expo/asc-api.mjs reports associatedErrors codes and JSON pointers |
| 2269041b6aa | 2026-10-09 | fix(release): correct desktop setup observations and expose Play failure stage | missing | Play per-operation stage/apiStatus (request(operation,...)) absent in 0.3 google-play-publish.mjs/submit.mjs; desktop-setup harness absent [MED] |
| 3bd76fb8d00 | 2026-10-09 | test(release): align submission contract with trusted control | ported | present before 2026-11-27: same-path line evidence 2/2 surviving lines found in 0.3 |
| 3fb2d687eb8 | 2026-10-09 | fix(release): drain archive extraction before staging cleanup | ported | present before 2026-11-27: packages/release-runtime/src/archiveExtraction.ts awaits unpack finish before staging cleanup; test in tests/archiveExtraction.test.mjs |
| 5c2d35eec09 | 2026-10-09 | chore(merge): integrate release follow-up with current dev | ported | present before 2026-11-27: release-assets-e2e/bin/remote-setup-result.mjs used by remote-daemon smokes in 0.3 |
| 69183e2a0e4 | 2026-10-09 | feat(release): publish production mobile store versions | ported | present before 2026-11-27: same-path line evidence 1301/1310 surviving lines found in 0.3 |
| 6e5b66f7165 | 2026-10-09 | fix(release): correct completed store rollouts and localized review notes | ported | present before 2026-11-27: same-path line evidence 158/161 surviving lines found in 0.3 |
| 8508762b9f3 | 2026-10-09 | fix(release): recover desktop artifacts from release origins | ported | present before 2026-11-27: same-path line evidence 14/15 surviving lines found in 0.3 |
| 878f9814249 | 2026-10-09 | fix(release): surface structured remote setup failures in smoke gates | ported | present before 2026-11-27: same-path line evidence 53/53 surviving lines found in 0.3 |
| 8a5911cd810 | 2026-10-09 | fix(android): enforce 16 KB native page alignment | ported | present before 2026-11-27: same-path line evidence 203/206 surviving lines found in 0.3 |
| 9b872184f12 | 2026-10-09 | fix(release): persist the desktop upgrade baseline relay | missing | desktop-setup release gate (scripts/release/release-assets-e2e/desktop-setup*.mjs, build-tauri desktop_setup job, registry suite) absent in 0.3 [MED] |
| b1d7148712e | 2026-10-09 | test(release): assert admitted desktop recovery origins | ported | present before 2026-11-27: scripts/release/build_tauri_workflow.production_signing_gate.test.mjs exists; build-tauri resolve_resume binds origin runs |
| b6eaa4803e1 | 2026-10-09 | Merge remote-tracking branch 'origin/dev' into HEAD | n.a. | merge commit; behaviour covered by constituent commits classified individually |
| c3a0f3b1f04 | 2026-10-09 | fix(release): preserve TestFlight build normalization | ported | present before 2026-11-27: same-path line evidence 21/21 surviving lines found in 0.3 |
| d26bbb28e02 | 2026-10-09 | chore(merge): integrate current dev with store publisher fixes | ported | present before 2026-11-27: build-tauri.yml:44,52,170 resume_workflow/resume_operation_id/expected_workflow in 0.3 |
| db2e94b66f8 | 2026-10-09 | fix(ci): complete scoped release workflow admission and fixtures | ported | present before 2026-11-27: actions: read permissions present on 0.3 reusable callers (nightly-dev, providers-contracts, release*, tests-dispatch...); reusable_workflow_permissions contract test exists |
| ddfa5f455d8 | 2026-10-09 | fix(release): safely report Google Play publication reasons | missing | 0.3 google-play-publish.mjs lacks API_STATUSES, secret redaction and apiMessage/apiReasons; store-publish.mjs and submit.mjs do not forward them [MED] |
| 13fa695a441 | 2026-10-10 | fix(release): retain native completion across control revisions | ported | present before 2026-11-27: scripts/pipeline/release/resolve-release-resume.mjs already has candidate-bound completion (no sourceSha==workflowSha requirement) |
| 4e286187ae5 | 2026-10-10 | chore(android): integrate shared publication fixtures | ported | present before 2026-11-27: scripts/pipeline/expo/fixtures/expo-submit.mjs and submit_android_publication.test.mjs exist in 0.3 |
| 55cde0e4b64 | 2026-10-10 | chore(ci): integrate current dev before CI validation | ported | present before 2026-11-27: scripts/pipeline/expo/verify-android-page-size.mjs and read-android-aab-metadata.mjs in 0.3 |
| b3d8b55c54b | 2026-10-10 | fix(release): reconcile cumulative verified issue availability | ported | present before 2026-11-27: same-path line evidence 87/95 surviving lines found in 0.3 |
| f2cb51e4e74 | 2026-10-10 | fix(android): preserve independent prerelease submissions | ported | present before 2026-11-27: same-path line evidence 25/25 surviving lines found in 0.3 |
| fad3105110f | 2026-10-10 | test(expo): share verified Android submission fixtures | ported | present before 2026-11-27: same-path line evidence 86/88 surviving lines found in 0.3 |
| 18979266fad | 2026-10-11 | fix(desktop): share Bun signing entitlements with hsetup | ported | present before 2026-11-27: same-path line evidence 20/24 surviving lines found in 0.3 |
| 0d1b6112be9 | 2026-10-13 | fix(installer): handle null OSArchitecture on Windows PowerShell 5.1 | ported | present before 2026-11-27: same-path line evidence 6/6 surviving lines found in 0.3 |
| 2eeff957cf7 | 2026-10-13 | ci(windows): run scheduled task contracts for service changes | ported | present before 2026-11-27: 0.3 tests.yml step Verify Windows scheduled task contracts (line 2499); duplicate of 29d19b0f3a2 |
| 3852ad5ce88 | 2026-10-13 | chore(ci): preserve captured action permission reductions | n.a. | superseded within 0.2: actions: read restored at 0.2 HEAD in those workflows; 0.3 retains it |
| 54360aa42c5 | 2026-10-13 | fix: restore upstream changes lost by stale dev merge | missing | Duplicate of e88276670b0 restore; 0.3 lacks same-run native preparation [MED] |
| 698ec3d4bce | 2026-10-13 | fix(installer): align terminal and daemon data homes | ported | present before 2026-11-27: same-path line evidence 60/62 surviving lines found in 0.3 |
| 7e281f6350e | 2026-10-13 | test(release): preserve captured desktop setup harness changes | missing | desktop-setup release gate (scripts/release/release-assets-e2e/desktop-setup*.mjs, compose.desktop-setup.yml, build-tauri.yml suite) absent in 0.3 [MED] |
| 7e8089f45b3 | 2026-10-13 | chore(ci): preserve captured Sapling metadata refresh | ported | present before 2026-11-27: scripts/ci/install_sapling_ubuntu22.sh has no apt-get update; 0.3 keeps install_sapling contract test (0.2 delta was test deletion) |
| 8d2060b1591 | 2026-10-13 | chore: integrate Windows installer fixes with current dev | ported | present before 2026-11-27: install.sh:7,1429,2764 STATE_HOME_DIR; install.ps1:3087 persists HAPPIER_HOME_DIR user env |
| a5d9130f68b | 2026-10-13 | fix(tauri): retain shared Bun JIT signing entitlements | ported | present before 2026-11-27: same-path line evidence 20/24 surviving lines found in 0.3 |
| afa56468de2 | 2026-10-13 | chore(tauri): preserve captured entitlement test delta | n.a. | test-only (bun-entitlements.test.mjs deletion/restore); 0.3 still has the test |
| b07ee21c040 | 2026-10-13 | refactor(release): preserve captured followup control contraction | n.a. | Net contraction later re-expanded in 0.2 (preparation_only, pinned promote-branch back at 0.2 HEAD); judged via the individual commits |
| b48320b0039 | 2026-10-13 | test(release): retain archive drain cleanup coverage | ported | present before 2026-11-27: packages/release-runtime/tests/archiveExtraction.test.mjs has the drain-before-staging-cleanup test; node-archive.mjs delegates to release-runtime |
| c1c6bd422a3 | 2026-10-13 | test(installer): isolate default-home fixture environment | ported | present before 2026-11-27: same-path line evidence 2/2 surviving lines found in 0.3 |
| d7c9d33e814 | 2026-10-13 | chore: integrate validated installer fixture correction | ported | present before 2026-11-27: installers_path_update_guidance test fixture only; 0.3 installers carry STATE_HOME_DIR fix |
| dae5ec74baf | 2026-10-13 | test(release): preserve captured archive cleanup coverage removal | n.a. | node-archive.test.mjs coverage trim only; no production change |
| fce10a3ee63 | 2026-10-13 | test(release): retain exact installed desktop setup observation | missing | desktop-setup release gate (scripts/release/release-assets-e2e/desktop-setup*.mjs, build-tauri desktop_setup job, registry suite) absent in 0.3 [MED] |
| 048d1e567ce | 2026-10-14 | refactor(release): preserve captured followup control contraction | n.a. | Contraction commit reverted by e88276670b0 (superseded within 0.2) |
| 29d19b0f3a2 | 2026-10-14 | ci(windows): run scheduled task contracts for service changes | ported | present before 2026-11-27: 0.3 tests.yml step Verify Windows scheduled task contracts (line 2499) |
| 40febea36f0 | 2026-10-14 | test(release): retain archive drain cleanup coverage | different | 0.3 node-archive.mjs uses extractArchivePayloadToDirectory (release-runtime owner); no node-archive.test.mjs |
| 41ffcd13994 | 2026-10-14 | chore(tauri): preserve captured entitlement test delta | n.a. | test-only (bun-entitlements.test.mjs deletion/restore); 0.3 still has the test |
| 7f9c8b7f5b8 | 2026-10-14 | chore(installer): integrate current dev before Windows validation | ported | present before 2026-11-27: tests.yml:2502 runs windows.test.ts once in Windows installers job; 0.3 replaced paths-filter with select_jobs_explicitly |
| 8034b0221c8 | 2026-10-14 | test(installer): isolate minisign command discovery in bootstrap fixtures | ported | present before 2026-11-27: same-path line evidence 2/2 surviving lines found in 0.3 |
| 8bffbc764c6 | 2026-10-14 | chore(ci): preserve captured action permission reductions | n.a. | superseded within 0.2: actions: read restored at 0.2 HEAD in those workflows; 0.3 retains it |
| 8f4617657a2 | 2026-10-14 | chore: integrate validated installer fixture correction | ported | present before 2026-11-27: installers_path_update_guidance test fixture only; 0.3 installers carry STATE_HOME_DIR fix |
| 927d445848e | 2026-10-14 | test(release): retain exact installed desktop setup observation | missing | No desktop-setup suite in 0.3 [MED] |
| 9b7603144dd | 2026-10-14 | test(installer): exercise Windows minisign architecture fallback | ported | present before 2026-11-27: same-path line evidence 62/64 surviving lines found in 0.3 |
| b65aa304ce8 | 2026-10-14 | fix(tauri): retain shared Bun JIT signing entitlements | ported | present before 2026-11-27: same-path line evidence 20/24 surviving lines found in 0.3 |
| b774e39042c | 2026-10-14 | test(installer): canonicalize Windows bootstrap fixture temp paths | ported | present before 2026-11-27: same-path line evidence 3/3 surviving lines found in 0.3 |
| c2f5af70609 | 2026-10-14 | test(release): preserve captured desktop setup harness changes | missing | desktop-setup release gate (scripts/release/release-assets-e2e/desktop-setup*.mjs, compose.desktop-setup.yml, build-tauri.yml suite) absent in 0.3 [MED] |
| e319c12ee2d | 2026-10-14 | chore(ci): preserve captured Sapling metadata refresh | ported | present before 2026-11-27: scripts/ci/install_sapling_ubuntu22.sh has no apt-get update; 0.3 keeps install_sapling contract test (0.2 delta was test deletion) |
| e88276670b0 | 2026-10-14 | fix: restore upstream changes lost by stale dev merge | missing | Bulk restore. 0.3 lacks same-run native preparation (preparation_only/use_prepared in build-tauri/build-ui-mobile-local, native_preparation contract); store-publish/ASC/Play/AAB files present in 0.3 [MED] |
| fe6f201b428 | 2026-10-14 | chore: integrate Windows installer fixes with current dev | ported | present before 2026-11-27: install.sh:7,1429,2764 STATE_HOME_DIR; install.ps1:3087 persists HAPPIER_HOME_DIR user env |
| fe73586a53d | 2026-10-14 | test(release): preserve captured archive cleanup coverage removal | n.a. | node-archive.test.mjs coverage trim only; no production change |
| 0f39da362c0 | 2026-10-17 | perf(ui): upgrade Unistyles and retire superseded patches | different | 0.3 uses pnpm patchedDependencies; no patch-package postinstall runner contract in UI |
| 41a9e173d74 | 2026-10-17 | fix(ci): avoid duplicate Windows contracts in PR merge | missing | 0.3 tests.yml Windows job runs only installers_security.test.mjs; payload-promotion contract not run on Windows [LOW] |
| 474baab4d93 | 2026-10-17 | fix(desktop): isolate channel executable and icon names | ported | present before 2026-11-27: same-path line evidence 96/96 surviving lines found in 0.3 |
| 718bf17cf0d | 2026-10-18 | Merge pull request #560 from danljungstrom/fix/model-pack-download-robust | n.a. | merge commit; behaviour covered by constituent commits classified individually |
| db017b638dc | 2026-10-18 | fix(deps): isolate patched Sharp runtimes and server dependencies | different | 0.3 pnpm Dockerfile/workspace closure replaces yarn dependency stage and Sharp isolation |
| 077db90d049 | 2026-10-19 | perf(desktop): bundle newer WebKit on the Ubuntu 22.04 ABI | ported | present before 2026-11-27: same-path line evidence 207/209 surviving lines found in 0.3 |
| 1ad2f24eaa2 | 2026-10-19 | fix(ci): install linuxdeploy in Tauri consumed cache entry | ported | present before 2026-11-27: 0.3 .github/actions/install-linuxdeploy installs linuxdeploy-07333c6-x86_64.AppImage cache basename |
| 89868c98f0c | 2026-10-19 | fix(server): reduce vulnerable runtime dependencies | different | 0.3 pnpm Dockerfile already prunes to production node_modules and handles sharp/musl (lines 470, 531) |
| 84fcf25a3bc | 2026-10-21 | fix(installer): retry GitHub requests without a rejected token | ported | present before 2026-11-27: same-path line evidence 50/52 surviving lines found in 0.3 |
| 081a536d337 | 2026-10-22 | fix(installer): keep the GitHub token across transient Windows failures | ported | present before 2026-11-27: same-path line evidence 20/20 surviving lines found in 0.3 |
| 0c9b434fc03 | 2026-10-22 | fix(installer): preserve authenticated retries and partial response integrity | ported | present before 2026-11-27: same-path line evidence 110/111 surviving lines found in 0.3 |
| 98dab9837ab | 2026-10-22 | fix(release): give the release-assets approver its own Account signing seed | n.a. | 0.3 CLI approve does not verify legacy secret vs Account signing seed; random secret still fine (revisit with 5c9262b8875) |
| fdcf232fca7 | 2026-10-22 | test(installer): verify the atomic swap installs a real binary | ported | present before 2026-11-27: same-path line evidence 12/12 surviving lines found in 0.3 |
| 23f82270336 | 2026-10-23 | fix(ci): pass optional store arguments safely on macOS mobile builds | missing | 0.3 build-ui-mobile-local.yml still expands "${store_args[@]}" (macOS bash 3.2 unbound array under set -u) [HIGH] |
| 413054f17c8 | 2026-10-23 | fix(release): characterize the 0.2.17 desktop setup contract for upgrade validat | missing | No desktop-setup suite in 0.3 (driver/test absent) [MED] |
| 5c9262b8875 | 2026-10-23 | fix(release): publish the release-assets approver Account content key | n.a. | 0.3 terminalAuthApproval.ts does not verify legacy secret vs Account signing key; approver content-key publish not needed (revisit if verification added) |
| 63829e3cd6a | 2026-10-23 | fix(ui): keep the Kokoro vendor folder in EAS native build copies | n.a. | 0.3 native sources do not import public/vendor/kokoro resolver (use protocol kokoro modelPacks); .easignore differs |
| 8c373854b88 | 2026-10-23 | chore(release): merge the Kokoro EAS copy fix into dev | n.a. | Kokoro public/vendor EAS negation; 0.3 removed browser Kokoro runtime and has no native consumer of public/vendor/kokoro |
| 9ea14e97c12 | 2026-10-23 | fix(ui): include the shared Kokoro voice resolver in EAS native builds | n.a. | 0.3 native Kokoro sources do not import public/vendor/kokoro resolver; EAS bundle-input contract absent |
| b33e6037822 | 2026-10-23 | fix(ci): request libunwind-dev for bundled-WebKit Linux desktop builds | ported 0ad5bbab9fd |  |
| f3ce78a2bf1 | 2026-10-23 | fix(release): run reuse-cli remote daemon setup on the primary CLI profile | missing | 0.3 remote-daemon-authenticated-cli-smoke.sh line 272 still passes --server-url/--webapp-url (unverified whether 0.3 setup resolves URL-derived server id) [LOW] |
| 4e5716e2a11 | 2026-10-25 | fix(windows): address launcher review findings on install, discovery and CI | different | 0.3 compiles/tests Windows launcher inline in each Windows job (tests.yml 2477, 3017, 3894); no ci path-filter list |
| 77e850ac78a | 2026-10-25 | ci(windows): build the service launcher for CI Windows payloads | different | 0.3 builds launcher inline in tests.yml Windows jobs and release-npm.yml build_windows_service_launcher |
| ac986f9f34b | 2026-10-25 | fix(windows): launch background services without a console | ported | present before 2026-11-27: 0.3 release-packages.mjs launcher PE assertion (~749); publish-cli-binaries.yml 630; release-npm.yml 285 |
| b3fb3d2aaf7 | 2026-10-25 | ci: drop restored workspace bundle copies from the dependency cache | different | 0.3 install-pnpm-dependencies action (pnpm store cache) replaces yarn workspace-bundle cache |
| dd95ba2fc29 | 2026-10-25 | ci: run all workflows and CI images on Node 24 from one .node-version pin | ported | present before 2026-11-27: same-path line evidence 238/248 surviving lines found in 0.3 |
| e3af8280538 | 2026-10-25 | ci(windows): read the service launcher jobs' Node from .node-version | ported | present before 2026-11-27: same-path line evidence 3/3 surviving lines found in 0.3 |
| 05d83edeb57 | 2026-10-26 | docs(readme): use File mode editor screenshot for files item | n.a. | README/image artwork only; no pipeline behaviour |
| 07b932dee5b | 2026-10-26 | test(windows): retain launcher assets in self-host validation | ported | present before 2026-11-27: same-path line evidence 15/17 surviving lines found in 0.3 |
| 2173e6ef96e | 2026-10-26 | docs(readme): add screenshots for sessions, session list, inbox, diff review and queue | n.a. | README/image artwork only; no pipeline behaviour |
| 2a2db28812c | 2026-10-26 | fix(build): bump Bun to 1.4.4 for CVE-2026-111497 (Brotli RCE) | ported | present before 2026-11-27: 0.3 apps/stack/scripts/provision/.bun-version = 1.4.4; workflows use bun-version-file |
| 3813b797df0 | 2026-10-26 | fix(ci): admit build-cli consumers when the optional launcher is skipped | different | 0.3 tests.yml consumers (binary-smoke, cli-daemon-e2e, e2e-core) do not depend on build-cli; no skip-tolerant ancestor chain |
| 46ab7c315e3 | 2026-10-26 | docs(readme): blur emails in account pools screenshot instead of covering them | n.a. | README/image artwork only; no pipeline behaviour |
| 481cd42689c | 2026-10-26 | fix(windows): launch background service tasks without console windows (#708) | ported | present before 2026-11-27: packages/cli-common/src/service/windowsLauncher.ts, scripts/pipeline/release/build-windows-service-launcher.mjs, wired in publish-cli/hstack-binaries, release-npm, tests.yml |
| 6c8f2e525bd | 2026-10-26 | docs(readme): add agent switch, git, subagents and files screenshots | n.a. | README/image artwork only; no pipeline behaviour |
| a2291e0feaf | 2026-10-26 | docs(readme): use subagents working/finished list screenshot | n.a. | README/image artwork only; no pipeline behaviour |
| b19c6bd9b0d | 2026-10-26 | docs(readme): compact git screenshot with collapsed README diff | n.a. | README/image artwork only; no pipeline behaviour |
| b73ffde482d | 2026-10-26 | fix(windows): preserve fully qualified service home paths | ported | present before 2026-11-27: same-path line evidence 1/1 surviving lines found in 0.3 |
| c3cbd46b213 | 2026-10-26 | docs(readme): add account pools screenshot and Track your accounts usage section | n.a. | README/image artwork only; no pipeline behaviour |
| f2d7afaebe3 | 2026-10-26 | docs(readme): lighter blur on emails in account pools screenshot | n.a. | README/image artwork only; no pipeline behaviour |
| f79ae409076 | 2026-10-26 | docs(readme): show voice provider logos instead of a voice screenshot | n.a. | README voice provider logo art, no pipeline behaviour |
| fb133106229 | 2026-10-26 | fix(ci): isolate Windows launcher artifacts by publisher | different | 0.3 publish-cli-binaries.yml compiles launcher in-job (line 630); hstack already uses hstack-windows-service-launcher artifact name |
| 4fa5bf7de3f | 2026-10-27 | test(e2e): report Home network transfer per phase | missing | 0.3 packages/tests lacks networkTransfer testkit and session.networkTransfer spec [LOW] |
| 5b677a29128 | 2026-10-28 | ci: share one dependency cache per installed tree | different | 0.3 .github/actions/install-pnpm-dependencies (pnpm store cache) replaces yarn bundle cache |
| 6a04ca11233 | 2026-10-28 | ci(network): track transfer on dev and compare with the last green run | missing | 0.3 has no network-transfer job/report (packages/tests uiE2e networkTransfer* absent) [LOW] |
| ff9a75fe6da | 2026-10-29 | fix(github): unify issue and PR handoff stewardship | ported | present before 2026-11-27: same-path line evidence 123/130 surviving lines found in 0.3 |
| 3a511488a04 | 2026-10-31 | fix(desktop): preserve prerelease versions in Windows updates | ported | present before 2026-11-27: same-path line evidence 56/57 surviving lines found in 0.3 |
| 9f2272f0861 | 2026-10-31 | fix(windows): suppress consoles for background process launches | n.a. | 0.3 apps/stack/scripts/release.mjs has no git status spawn; windowsHide already widespread in apps/stack/scripts |
| 4fcc2863f99 | 2026-11-01 | ci: pin the schtasks self-host job to the windows-2022 image | ported | present before 2026-11-27: same-path line evidence 1/1 surviving lines found in 0.3 |
| 33db97c4e34 | 2026-11-02 | fix(ci): pass release notes to mobile build scripts through env | missing | env-bound RELEASE_MESSAGE present, but 0.3 publish-release-notes-assets.mjs gh release create lacks --latest=false; tests.yml concurrency not keyed by event_name [HIGH] |
| 39a7383e012 | 2026-11-02 | fix(ci): build Windows self-host harness workspace prerequisites | ported | present before 2026-11-27: same-path line evidence 5/6 surviving lines found in 0.3 |
| 4084b39d162 | 2026-11-02 | ci(release): pass release notes as --release-message=<value> | ported | present before 2026-11-27: 0.3 workflows use --release-message="$RELEASE_MESSAGE" form |
| 67123c84ca1 | 2026-11-02 | fix(cli): stage compatible target-native PTY addons | missing | 0.3 publish-cli-binaries.yml has no native Linux ARM64 PTY addon job; captured_runtime_dependencies.mjs has no per-ABI PTY handling (unverified) [MED] |
| 81d52378f11 | 2026-11-02 | ci(release): publish selected products before advancing channels | ported | present before 2026-11-27: 0.3 release-channel.yml and release-source-validation.yml exist (publish then promote, promote_github_latest); reshaped with runner binaries |
| 85c5dbc5523 | 2026-11-02 | fix(release): use a successful Windows PTY smoke command | ported | present before 2026-11-27: scripts/pipeline/release/base-cli-runtime-smoke.mjs:71 uses echo pty-ok on Windows |
| b53b793c20b | 2026-11-02 | ci: pin the local Android build to the ubuntu-24.04 image | ported | present before 2026-11-27: same-path line evidence 1/1 surviving lines found in 0.3 |
| 044138bebc3 | 2026-11-03 | fix(release): build the server-embedded web UI for the release channel | ported | present before 2026-11-27: same-path line evidence 27/27 surviving lines found in 0.3 |
| 1f7d30660da | 2026-11-03 | fix(release): reduce expanded workflow graph with channel matrix | missing | 0.3 release.yml still has release_single/release_preview/release_production jobs; no channel matrix or terminal-status stage selection [MED] |
| 282a8fc3f99 | 2026-11-03 | fix(release): preserve candidate bases and isolate validation runs | ported | present before 2026-11-27: same-path line evidence 399/478 surviving lines found in 0.3 |
| 3cc38542dc5 | 2026-11-03 | fix(release): let the job timeout bound deploy-ref Git network calls | missing | scripts/pipeline/github/deploy-ref-cas.mjs absent in 0.3 (protected deploy-ref bundle; confirm parent lane covers) [HIGH] |
| 5fa046cb20d | 2026-11-03 | fix(release): treat channel bases at the same commit as one validation base | missing | 0.3 compute-changed-components.mjs lines 50-52 still fail on non-unique bases [HIGH] |
| 9d40ad7c59b | 2026-11-03 | Merge pull request #845 from mvitaly/fix/dev-box-libatomic1 | ported | present before 2026-11-27: docker/dev-box/Dockerfile:41 installs libatomic1 |
| a8c74ddd310 | 2026-11-03 | fix(release): accept multiple validation bases when computing changed components | ported | present before 2026-11-27: 0.3 compute-changed-components.mjs supports --bases union |
| ae07137cb1e | 2026-11-03 | test(release): assert G3 Docker admission binds the admitted source branch | ported | present before 2026-11-27: 0.3 publish-docker.yml Verify admitted publication source (247-261, resolve-authorized-release-source --allow-source-ancestor) |
| b2fcdd9b738 | 2026-11-03 | fix(release): free runner disk before UI candidate validation | missing | 0.3 promote-ui.yml validate_candidate has no Free runner disk step [HIGH] |
| b9fe3b0a148 | 2026-11-03 | fix(dev-box): install libatomic1 so the managed Node runtime can start | ported | present before 2026-11-27: same-path line evidence 1/1 surviving lines found in 0.3 |
| e037bdf7b64 | 2026-11-03 | fix(release): exit runtime smoke after verified PTY completion | ported | present before 2026-11-27: 0.3 base-cli-runtime-smoke.mjs exits via process.exit after verified PTY completion (lines 98-100) |
| f41b56873b2 | 2026-11-03 | fix(release): bind publishers to admitted promotion source | ported | present before 2026-11-27: same-path line evidence 117/124 surviving lines found in 0.3 |
| 0578c18e2cd | 2026-11-04 | fix(release): characterize the 0.2.19 and 0.2.21 desktop setup contracts | missing | No desktop-setup suite in 0.3 (driver/test absent) [MED] |
| 2aeb139d391 | 2026-11-04 | fix(ci): grant handoff reconciler pull request label writes | ported | present before 2026-11-27: 0.3 issue-needs-handoff.yml permissions include pull-requests: write |
| d06c9f6bb06 | 2026-11-05 | ci(ios): reclaim unused SDKs before compiling iOS on xcode-27 | ported | present before 2026-11-27: same-path line evidence 96/96 surviving lines found in 0.3 |
| e560e49289e | 2026-11-05 | ci(ios): build iOS binaries with Xcode 27.1 | ported | present before 2026-11-27: same-path line evidence 17/17 surviving lines found in 0.3 |
| 53b1627af9e | 2026-11-07 | fix(ui): include modern releases in What's New | ported | present before 2026-11-27: same-path line evidence 27/27 surviving lines found in 0.3 |
| d09d5ef8249 | 2026-11-07 | fix(release): keep waiting on a notarization when one status poll times out | ported 0ad5bbab9fd | notarytool wait on the created submission |
| 1553ddf1a0b | 2026-11-08 | fix(ci): download Sapling through the release-asset API | missing | 0.3 scripts/ci/install_sapling_ubuntu22.sh still uses github.com releases/download URL; workflows set no GITHUB_TOKEN env [MED] |
| 519c05dc132 | 2026-11-08 | fix(release): retry codesign when Apple returns no timestamp | ported 0ad5bbab9fd | retry on missing timestamp |
| 6a4bb96a783 | 2026-11-08 | test(installers): load Sync-InstallerPath in the Windows home-alignment test | ported | present before 2026-11-27: 0.3 installers_windows_home_dir.test.mjs already extracts Sync-InstallerPath |
| 7b37d65ca75 | 2026-11-08 | fix(release): accept the Desktop status read that names its bundle id | n.a. | 0.3 desktop bootstrap status read passes no --desktop-bundle-id; 0.3 probe reads plain daemon status. Revisit if desktop names bundle id |
| a730ff7d943 | 2026-11-08 | feat(desktop): remove only what the desktop app created when it is uninstalled | ported | present before 2026-11-27: same-path line evidence 492/528 surviving lines found in 0.3 |
| d370a14c49f | 2026-11-08 | fix(release): let codesign retries see Apple's timestamp error | ported 0ad5bbab9fd | stderr kept on thrown error |
| f9b5c56bc2f | 2026-11-08 | Update GitHub funding username | missing | 0.3 .github/FUNDING.yml has github: [leeroybrun]; 0.2 dev has happier-dev [LOW] |
| 08bdd148691 | 2026-11-11 | feat(release): publish nightly dev CLI builds to npm under the dev tag | ported | present before 2026-11-27: 0.3 nightly-dev.yml publish_npm (npm_tag dev); self.ts resolveSelfNpmDistTag publicdev->dev |
| 7b0f74960b1 | 2026-11-12 | fix(release): let the approved-release materializer read large repositories | ported | present before 2026-11-27: same-path line evidence 13/13 surviving lines found in 0.3 |
| 3d1e2098859 | 2026-11-14 | test(cli-common): run process identity contracts on Windows | ported | present before 2026-11-27: 0.3 tests.yml job process-identity-windows (line 1912) |
| 87aaa83f6b8 | 2026-11-16 | test(release): align webhook deploy coverage with hosted images | ported 06bc01d95ab | hosted-images bundle and deploy-ref admission |
| 972cdc0e597 | 2026-11-16 | feat(deploy): deploy hosted API, worker and UI from published images | ported 06bc01d95ab | hosted-images bundle and deploy-ref admission |
| d3b1be4dc48 | 2026-11-16 | fix(docker): bind hosted server artifacts through their release tag commit | ported 06bc01d95ab | hosted-images bundle and deploy-ref admission |
| f41f602fb01 | 2026-11-16 | fix(installer): unpack bundled minisign with the two-argument zip API | ported 0ad5bbab9fd | scripts/release/installers/install.ps1; website copies at next installer sync |
| 131c3ad5a37 | 2026-11-17 | fix(release): retry transient GitHub API failures when binding a resume | missing | 0.3 resolve-release-resume.yml reads artifacts/jobs with single gh api --paginate, no retry [MED] |
| 1e41ec51a92 | 2026-11-17 | fix(ci): forward read-only GitHub token to Docker release validation | missing | 0.3 release-assets-e2e/run.sh and tests.yml release-assets-docker lack HAPPIER_GITHUB_TOKEN forwarding [MED] |
| 3f056fbb666 | 2026-11-17 | fix(tests): await idle CLI update restart admission and retain delivery logs | missing | 0.3 tests.yml cli-update-continuity artifact paths lack daemon-home/logs/*.log [LOW] |
| 460cd2803ee | 2026-11-17 | ci(tests): dispatch the full v0.3 journey suites nightly | ported | present before 2026-11-27: same-path line evidence 3/3 surviving lines found in 0.3 |
| 4ac21ea2247 | 2026-11-17 | fix(ci): run the v0.3 nightly dispatch outside reusable tests.yml | different | 0.3 tests.yml has own schedule (cron 43 1) and comments defer full nightly to dev's dispatcher; no nightly-v0-3-journeys.yml in 0.3 |
| 793cee37a0a | 2026-11-17 | fix(ci): use bundled Windows PTY prebuilds | missing | 0.15.0 changes the package layout (Node-API pty.node, musl prebuild dirs, no prebuild-loader) that 0.3 CLI binary projection prunes (finalizeRuntimeArtifactPayload, stageCliTargetRuntimeDependencies, verify-artifacts); needs projection update + per-platform binary validation with the bump |
| a3119d49bda | 2026-11-17 | fix(release): resume published candidates after verification failures | missing | 0.3 resolve-release-resume.mjs has no legacyPublishedCandidate/publishedReleases recovery; project-release-status.mjs identity verified-only [MED] |
| aae1f06de5e | 2026-11-17 | fix(release): give the resume resolver its read-only GitHub token | missing | 0.3 resolve-release-resume.yml resolve step env has no GH_TOKEN [MED] |
| c92b35f086e | 2026-11-17 | fix(release): deploy hosted images through protected deploy refs | ported 06bc01d95ab | hosted-images bundle and deploy-ref admission |
| db4c9544cbe | 2026-11-17 | fix(release): reject unknown validation suites during planning | missing | 0.3 run.mjs release step still parseCsvList of include/waive suites, no validateReleaseValidationRefinements call (later plan validation exists) [LOW] |
| f1976f1bde5 | 2026-11-17 | fix(release): page resume job evidence in 50-job pages | missing | 0.3 resolve-release-resume.yml still uses jobs?filter=latest&per_page=100 [MED] |
| 696492fc2f9 | 2026-11-18 | ci(v0.3): post a sticky perf comment on v0.3 PRs and run full unit suites nightl | missing | No perf-comment-v0-3.yml in 0.3 workflows; nightly part: 0.3 tests.yml has own schedule (line 11) [MED] |
| 3ddb219c575 | 2026-11-25 | test(release): accept forwarded env flags before the cli2 smoke run | n.a. | Test regex only relaxes for env flags added by 1e41ec51a92 (missing in 0.3); port together |
| 45e08761bbf | 2026-11-25 | fix(release): accept an asset its timed-out upload already stored | missing | 0.3 publish-release.mjs / lib/release-asset-transfer.mjs lack isAlreadyUploadedReleaseAssetError [MED] |
| 50c16e76494 | 2026-11-25 | fix(release): skip the unavailable CUDA runtime in release asset smoke images | ported 1de1d005425 | pnpm-workspace allowBuilds onnxruntime-node=false is the one owner for CI, Docker, EAS, dagger and local installs (pnpm 12 passes no .npmrc keys to lifecycle scripts, so 0.2 .npmrc owner does not carry) |
| 708c79e3e8c | 2026-11-25 | fix(docker): skip the unavailable ONNX Runtime CUDA download in dependency stage | ported 1de1d005425 | pnpm-workspace allowBuilds onnxruntime-node=false is the one owner for CI, Docker, EAS, dagger and local installs (pnpm 12 passes no .npmrc keys to lifecycle scripts, so 0.2 .npmrc owner does not carry) |
| 7beb0b1c8df | 2026-11-25 | fix(release): bundle What's New when materializing release notes | missing | 0.3 changelog-sections.mjs lacks buildChangelogBundle/CHANGELOG_BUNDLE_PATH; materialize-approved-release.mjs writes only CHANGELOG.md [MED] |
| 99b01d95a75 | 2026-11-25 | fix(release): accept waived MySQL and platform source gates | ported | present before 2026-11-27: release-source-validation.yml lines 378-382 require MySQL/platform results only without waive_ci |
| 05a0c46b0f1 | 2026-11-26 | fix(release): build candidate images with workflow-control Dockerfiles | ported 06bc01d95ab | hosted-images bundle and deploy-ref admission |
| 2457638b959 | 2026-11-26 | fix(deploy): wait for the dispatched deploy run to become readable | ported 06bc01d95ab | hosted-images bundle and deploy-ref admission |
| 4c98b4f095c | 2026-11-26 | fix(release): characterize the ui-desktop-v0.2.22 setup contract for the upgrade | missing | Same desktop-setup suite absent in 0.3 (driver/test files not present) [MED] |
| 67ffab8a7f3 | 2026-11-26 | fix(release): inherit the desktop run number only with reusable desktop bytes | missing | 0.3 resolve-release-resume.mjs resolveDesktopArtifacts still returns runNumber unconditionally [MED] |
| c749febfcd7 | 2026-11-26 | fix(ci): skip the ONNX Runtime CUDA download in EAS local Android builds | ported 1de1d005425 | pnpm-workspace allowBuilds onnxruntime-node=false is the one owner for CI, Docker, EAS, dagger and local installs (pnpm 12 passes no .npmrc keys to lifecycle scripts, so 0.2 .npmrc owner does not carry) |
| 152ea20b5c1 | 2026-11-27 | fix(webapp): read analytics and Sentry settings at container start | ported 06bc01d95ab | UI half in fba3e3bd610 |
| 217e96ccea9 | 2026-11-27 | fix(release): deploy the server on resume when an earlier attempt promoted its runtime | ported | present before 2026-11-27: release-channel.yml:1119 deploy_server accepts server_rolling_complete on resume; deploys via promote-server.yml |
| 254fb29d6e2 | 2026-11-27 | ci(release): add weekly non-publishing dev build checks | ported | present before 2026-11-27: same-path line evidence 8/8 surviving lines found in 0.3 |
| 315f7ec0d40 | 2026-11-27 | fix(release): infer unchanged desktop predecessor setup contracts | missing | No desktop-setup validation suite in 0.3 (release-assets-e2e/desktop-setup*.mjs, executors/desktop-setup.mjs, build-tauri gate) [MED] |
| a4ffc12adbe | 2026-11-27 | fix(cli): make the local embeddings runtime optional so Linux x64 npm installs succeed | ported 1de1d005425 | CLI @huggingface/transformers in optionalDependencies |
| b4ce2375549 | 2026-11-27 | ci: make the repository .npmrc the one owner of the ONNX Runtime CUDA skip | ported 1de1d005425 | pnpm-workspace allowBuilds onnxruntime-node=false is the one owner for CI, Docker, EAS, dagger and local installs (pnpm 12 passes no .npmrc keys to lifecycle scripts, so 0.2 .npmrc owner does not carry) |
| b5d35f3ed52 | 2026-11-27 | fix(deploy): decide a hosted deploy from its run record, not gh run watch exit | ported 06bc01d95ab | hosted-images bundle and deploy-ref admission |
| bfa2e6923ef | 2026-11-27 | ci(release): grant the dry-run Docker build the permissions its reusable workflow declares | missing | release-build-dry-run.yml (weekly non-publishing build) and publish-docker build_only path absent in 0.3; permissions grant moot until workflow ported [MED] |
