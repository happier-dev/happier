// @ts-check

import {
  MOBILE_RELEASE_ENVIRONMENT_CHOICES,
  MOBILE_STORE_SUBMIT_ENVIRONMENT_CHOICES,
} from '../../expo/mobile-release-environments.mjs';

/**
 * @typedef {{
 *   summary: string;
 *   usage: string;
 *   options?: string[];
 *   bullets: string[];
 *   examples: string[];
 * }} CommandHelpSpec
 */

/** @type {Record<string, CommandHelpSpec>} */
export const COMMAND_HELP_EXPO = {
  'ui-mobile-release': {
    summary: 'Expo mobile release entrypoint (OTA, native build, submit).',
    usage:
      `node scripts/pipeline/run.mjs ui-mobile-release --environment <${MOBILE_RELEASE_ENVIRONMENT_CHOICES}> --action <ota|native|native_submit> --platform <ios|android|all> [--profile <easProfile>]`,
    options: [
      `--environment <${MOBILE_RELEASE_ENVIRONMENT_CHOICES}>  Required.`,
      '--action <ota|native|native_submit> Required.',
      '--platform <ios|android|all>        Required.',
      '--profile <name>                   Required for native/native_submit; must match the selected lane (internaldev*, internalpreview*, dev*, preview*, production*).',
      '--publish-apk-release <auto|true|false> (default: auto).',
      '--android-release-status <status> Android EAS submit releaseStatus: profile|completed|draft|halted|inProgress (default: draft).',
      '--native-build-mode <cloud|local>  (default: cloud).',
      '--native-local-runtime <host|dagger> (default: host).',
      '--build-json <path>                (default: /tmp/eas_build.json).',
      '--out-dir <dir>                    (default: dist/ui-mobile).',
      '--interactive <auto|true|false>    (default: auto).',
      '--eas-cli-version <ver>            Optional; pins EAS CLI.',
      '--dump-view <bool>                 Optional; debug EAS build view.',
      "--fingerprint-mode <always|if-changed> (default: always). Skips cloud native builds when the EAS fingerprint matches the latest finished build for that profile/platform.",
      '--preflight-only                  For native_submit, validate the configured external TestFlight groups without building or submitting.',
      '--release-message <text>           Optional; passed to APK release publish.',
      '--ui-version-bump <patch|minor|major> Optional; bump apps/ui marketing version before builds.',
      '--ui-version <x.y.z>               Optional; set apps/ui marketing version before builds.',
      '--allow-dirty <true|false>         (default: false). Only affects version bump flags.',
      '--dry-run',
      '--secrets-source <auto|env|keychain>',
      '--keychain-service <name>           (default: happier/pipeline).',
      '--keychain-account <name>',
    ],
    bullets: [
      'This command composes expo-ota / expo-native-build / expo-submit for convenience.',
      'native_submit is intentionally limited to dev, preview, and production because only those lanes have store submit profiles.',
      'Android native_submit defaults to releaseStatus=draft so Play Store review can validate the upload before release rollout is approved.',
      'When APP_STORE_CONNECT_<ENV>_EXTERNAL_GROUPS is configured for the selected environment, native_submit also runs the App Store Connect external TestFlight distribution step from inside the shared pipeline.',
      'TestFlight group selections are verified against the selected app before a release build starts; prefer a stable exact group name over a replaceable App Store Connect resource id.',
      'Expo OTA and submit default to interactive on a local TTY and non-interactive in CI or when output is piped.',
      'Cloud native builds use two unified paths: interactive local TTY runs schedule normally and then resolve the build via EAS list/view; CI/non-interactive runs keep the direct JSON path.',
      "For local iOS builds, use --native-build-mode local and keep --native-local-runtime host (requires Xcode).",
      'For local Android builds, you may use --native-local-runtime dagger for containerized reproducibility.',
    ],
    examples: [
      'node scripts/pipeline/run.mjs ui-mobile-release --environment internaldev --action ota --platform all',
      'node scripts/pipeline/run.mjs ui-mobile-release --environment internalpreview --action native --platform android --profile internalpreview-apk --native-build-mode local --native-local-runtime dagger',
      'node scripts/pipeline/run.mjs ui-mobile-release --environment dev --action native_submit --platform all --profile dev',
      'node scripts/pipeline/run.mjs ui-mobile-release --environment preview --action ota --platform all',
      'node scripts/pipeline/run.mjs ui-mobile-release --environment production --action native --platform ios --profile production --native-build-mode local --native-local-runtime host',
    ],
  },

  'expo-ota': {
    summary: 'Publish an Expo OTA update for the given environment.',
    usage: `node scripts/pipeline/run.mjs expo-ota --environment <${MOBILE_RELEASE_ENVIRONMENT_CHOICES}> [--message <text>] [--dry-run]`,
    options: [
      `--environment <${MOBILE_RELEASE_ENVIRONMENT_CHOICES}>  Required.`,
      '--message <text>                   Optional.',
      '--interactive <auto|true|false>    (default: auto).',
      '--eas-cli-version <ver>            Optional; pins EAS CLI.',
      '--dry-run',
      '--secrets-source <auto|env|keychain>',
      '--keychain-service <name>           (default: happier/pipeline).',
      '--keychain-account <name>',
    ],
    bullets: [
      'Requires Expo auth (EXPO_TOKEN or EAS local login).',
      'Local TTY runs can prompt through EAS login/setup; CI and piped runs stay non-interactive.',
      'internaldev, internalpreview, dev, and preview publish directly to same-name Expo update channels; production keeps using the production OTA workflow.',
    ],
    examples: [
      'node scripts/pipeline/run.mjs expo-ota --environment internaldev --message "Internal dev OTA"',
      'node scripts/pipeline/run.mjs expo-ota --environment internalpreview --message "Internal preview OTA"',
      'node scripts/pipeline/run.mjs expo-ota --environment dev --message "Public dev OTA"',
      'node scripts/pipeline/run.mjs expo-ota --environment preview --message "Preview OTA"',
    ],
  },

  'expo-native-build': {
    summary: 'Build a native Expo app (EAS Build) and write build metadata to a JSON file.',
    usage:
      'node scripts/pipeline/run.mjs expo-native-build --platform <ios|android> --profile <profile> --out <buildJsonPath> [--build-mode cloud|local] [--artifact-out <path>]',
    options: [
      '--platform <ios|android>          Required.',
      '--profile <name>                 Required; EAS build profile.',
      '--out <path>                     Required; build JSON output path.',
      '--build-mode <cloud|local>       Optional; overrides profile runner.',
      '--local-runtime <host|dagger>    Optional; only applies to local builds.',
      '--artifact-out <path>            Optional; writes IPA/AAB/APK to this path for local builds.',
      '--interactive <auto|true|false>  (default: auto). Local TTY cloud builds resolve metadata via EAS list/view; dagger stays non-interactive.',
      '--eas-cli-version <ver>          Optional; pins EAS CLI.',
      '--dump-view <bool>               true|false (default: true).',
      "--fingerprint-mode <always|if-changed> (default: always). If-changed is CI-oriented (requires non-interactive + EXPO_TOKEN).",
      "--wait <true|false>              Optional; overrides native-build's wait behavior (default: true).",
      '--dry-run',
      '--secrets-source <auto|env|keychain>',
      '--keychain-service <name>         (default: happier/pipeline).',
      '--keychain-account <name>',
    ],
    bullets: [
      'Use ui-mobile-release if you want a higher-level flow (build + submit).',
      'Cloud builds are interactive on local TTY runs, then the pipeline resolves the created build via EAS list/view and writes the same build JSON output contract.',
      'CI/non-interactive cloud builds keep the direct --json path for stronger determinism.',
    ],
    examples: [
      'node scripts/pipeline/run.mjs expo-native-build --platform ios --profile production --out /tmp/eas_build.ios.json --build-mode local --local-runtime host --artifact-out dist/ui-mobile/happier-production-ios.ipa',
    ],
  },

  'expo-download-apk': {
    summary: 'Download the Android APK from a previous EAS Build JSON output.',
    usage:
      `node scripts/pipeline/run.mjs expo-download-apk --environment <${MOBILE_RELEASE_ENVIRONMENT_CHOICES}> [--build-json <path>] [--out-dir <dir>]`,
    options: [
      `--environment <${MOBILE_RELEASE_ENVIRONMENT_CHOICES}>  Required.`,
      '--build-json <path>               (default: /tmp/eas_build.json).',
      '--out-dir <dir>                   (default: dist/ui-mobile).',
      '--eas-cli-version <ver>           Optional; pins EAS CLI.',
      '--dry-run',
      '--secrets-source <auto|env|keychain>',
      '--keychain-service <name>          (default: happier/pipeline).',
      '--keychain-account <name>',
    ],
    bullets: ['Only relevant for *-apk EAS profiles.'],
    examples: ['node scripts/pipeline/run.mjs expo-download-apk --environment dev --build-json /tmp/eas_build.json'],
  },

  'expo-mobile-meta': {
    summary: 'Compute/emit mobile release metadata (used by workflows).',
    usage:
      `node scripts/pipeline/run.mjs expo-mobile-meta --environment <${MOBILE_RELEASE_ENVIRONMENT_CHOICES}> [--download-ok true|false] [--out-json <path>]`,
    options: [
      `--environment <${MOBILE_RELEASE_ENVIRONMENT_CHOICES}>  Required.`,
      '--download-ok <bool>              true|false (default: false).',
      '--app-version <semver>            Optional override.',
      '--out-json <path>                 Optional; write JSON metadata to a file.',
      '--dry-run',
      '--secrets-source <auto|env|keychain>',
      '--keychain-service <name>          (default: happier/pipeline).',
      '--keychain-account <name>',
    ],
    bullets: ['Mostly used internally by release automation.'],
    examples: ['node scripts/pipeline/run.mjs expo-mobile-meta --environment dev --out-json dist/ui-mobile/meta.json'],
  },

  'expo-submit': {
    summary: 'Submit a native build to TestFlight / Play Store (EAS Submit).',
    usage:
      `node scripts/pipeline/run.mjs expo-submit --environment <${MOBILE_STORE_SUBMIT_ENVIRONMENT_CHOICES}> --platform <ios|android|all> [--profile <submitProfile>] [--path <artifactPath>]`,
    options: [
      `--environment <${MOBILE_STORE_SUBMIT_ENVIRONMENT_CHOICES}>  Required.`,
      '--platform <ios|android|all>       Required.',
      '--profile <name>                  Optional; EAS submit profile.',
      '--path <path>                     Optional; submit a local artifact (IPA/AAB/APK).',
      '--interactive <auto|true|false>   (default: auto).',
      '--eas-cli-version <ver>           Optional; pins EAS CLI.',
      '--android-release-status <status> Android EAS submit releaseStatus: profile|completed|draft|halted|inProgress (default: draft).',
      '--dry-run',
      '--secrets-source <auto|env|keychain>',
      '--keychain-service <name>          (default: happier/pipeline).',
      '--keychain-account <name>',
    ],
    bullets: [
      'Use --path to submit a locally-built artifact.',
      'Android submit defaults to releaseStatus=draft; pass profile to leave eas.json unchanged.',
      'Submit defaults to interactive on a local TTY and non-interactive in CI or when output is piped.',
    ],
    examples: [
      'node scripts/pipeline/run.mjs expo-submit --environment dev --platform all --profile dev',
      'node scripts/pipeline/run.mjs expo-submit --environment production --platform ios --profile production --path dist/ui-mobile/happier-production-ios-v0.1.0.ipa',
    ],
  },

  'expo-testflight-distribute': {
    summary: 'Distribute an iOS TestFlight build to external groups via the App Store Connect API.',
    usage:
      `node scripts/pipeline/run.mjs expo-testflight-distribute --environment <${MOBILE_STORE_SUBMIT_ENVIRONMENT_CHOICES}> --external-groups <name-or-id[,name-or-id...]> [--build-number <n>] [--app-version <x.y.z>]`,
    options: [
      `--environment <${MOBILE_STORE_SUBMIT_ENVIRONMENT_CHOICES}>  Required.`,
      '--external-groups <csv>          Required; comma-separated external TestFlight group names or ids.',
      '--profile <name>                 Optional; EAS submit profile (defaults from environment).',
      '--build-json <path>              Optional; resolve the iOS EAS build id from a build JSON artifact.',
      '--eas-build-id <id>              Optional; resolve build metadata from a specific EAS build.',
      '--build-number <n>               Optional when build-json / eas-build-id is provided.',
      '--app-version <x.y.z>            Optional; narrows the App Store Connect build match.',
      '--submit-beta-review <auto|true|false> (default: auto).',
      '--wait-processing <true|false>   (default: true).',
      '--processing-timeout-seconds <n> (default: 3600).',
      '--eas-cli-version <ver>          Optional; pins EAS CLI when resolving EAS build metadata.',
      '--dry-run',
      '--secrets-source <auto|env|keychain>',
      '--keychain-service <name>         (default: happier/pipeline).',
      '--keychain-account <name>',
    ],
    bullets: [
      'Uses the App Store Connect API directly; requires APPLE_API_PRIVATE_KEY plus ascAppId/ascApiKeyId/ascApiKeyIssuerId in apps/ui/eas.json.',
      'This is the missing post-submit step for external TestFlight distribution: wait for processing, attach to external groups, and submit Beta App Review when needed.',
      'Provide --build-number directly for fully Apple-side operation, or pass --build-json / --eas-build-id to resolve the build from EAS metadata first.',
    ],
    examples: [
      'node scripts/pipeline/run.mjs expo-testflight-distribute --environment dev --build-number 123 --app-version 1.2.3 --external-groups "Public Beta"',
      'node scripts/pipeline/run.mjs expo-testflight-distribute --environment dev --build-json /tmp/eas_build.ios.json --external-groups "Public Beta" --eas-cli-version 18.0.1',
    ],
  },

  'expo-publish-apk-release': {
    summary: 'Publish an Android APK asset as a GitHub Release (used for dev/preview distribution).',
    usage:
      `node scripts/pipeline/run.mjs expo-publish-apk-release --environment <${MOBILE_RELEASE_ENVIRONMENT_CHOICES}> (--apk-path <path> | --retry-version <version>) --target-sha <sha> [--release-message <text>]`,
    options: [
      `--environment <${MOBILE_RELEASE_ENVIRONMENT_CHOICES}>  Required.`,
      '--apk-path <path>                 Required unless --retry-version is supplied.',
      '--retry-version <version>         Reproject an existing immutable production APK release.',
      '--target-sha <sha>                Required.',
      '--release-message <text>          Optional.',
      '--dry-run',
      '--secrets-source <auto|env|keychain>',
      '--keychain-service <name>          (default: happier/pipeline).',
      '--keychain-account <name>',
    ],
    bullets: ['Used by ui-mobile-release when building APK profiles.'],
    examples: [
      'node scripts/pipeline/run.mjs expo-publish-apk-release --environment dev --apk-path dist/ui-mobile/happier-dev-android.apk --target-sha $(git rev-parse HEAD)',
      'node scripts/pipeline/run.mjs expo-publish-apk-release --environment preview --apk-path dist/ui-mobile/happier-preview-android.apk --target-sha $(git rev-parse HEAD)',
    ],
  },
};
