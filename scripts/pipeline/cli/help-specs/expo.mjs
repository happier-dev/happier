// @ts-check

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
      'node scripts/pipeline/run.mjs ui-mobile-release --environment <preview|production> --action <ota|native|native_submit> --platform <ios|android|all> [--profile <easProfile>]',
    options: [
      '--environment <preview|production>  Required.',
      '--action <ota|native|native_submit> Required.',
      '--platform <ios|android|all>        Required.',
      '--profile <name>                   Required for native/native_submit; must start with preview* or production*.',
      '--publish-apk-release <auto|true|false> (default: auto).',
      '--native-build-mode <cloud|local>  (default: cloud).',
      '--native-local-runtime <host|dagger> (default: host).',
      '--build-json <path>                (default: /tmp/eas_build.json).',
      '--out-dir <dir>                    (default: dist/ui-mobile).',
      '--eas-cli-version <ver>            Optional; pins EAS CLI.',
      '--dump-view <bool>                 Optional; debug EAS build view.',
      '--release-message <text>           Optional; passed to APK release publish.',
      '--dry-run',
      '--secrets-source <auto|env|keychain>',
      '--keychain-service <name>           (default: happier/pipeline).',
      '--keychain-account <name>',
    ],
    bullets: [
      'This command composes expo-ota / expo-native-build / expo-submit for convenience.',
      "For local iOS builds, use --native-build-mode local and keep --native-local-runtime host (requires Xcode).",
      'For local Android builds, you may use --native-local-runtime dagger for containerized reproducibility.',
    ],
    examples: [
      'node scripts/pipeline/run.mjs ui-mobile-release --environment preview --action ota --platform all',
      'node scripts/pipeline/run.mjs ui-mobile-release --environment production --action native --platform ios --profile production --native-build-mode local --native-local-runtime host',
    ],
  },

  'expo-ota': {
    summary: 'Publish an Expo OTA update for the given environment.',
    usage: 'node scripts/pipeline/run.mjs expo-ota --environment <preview|production> [--message <text>] [--dry-run]',
    options: [
      '--environment <preview|production>  Required.',
      '--message <text>                   Optional.',
      '--eas-cli-version <ver>            Optional; pins EAS CLI.',
      '--dry-run',
      '--secrets-source <auto|env|keychain>',
      '--keychain-service <name>           (default: happier/pipeline).',
      '--keychain-account <name>',
    ],
    bullets: ['Requires Expo auth (EXPO_TOKEN or EAS local login).'],
    examples: ['node scripts/pipeline/run.mjs expo-ota --environment preview --message "Preview OTA"'],
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
      '--eas-cli-version <ver>          Optional; pins EAS CLI.',
      '--dump-view <bool>               true|false (default: true).',
      '--dry-run',
      '--secrets-source <auto|env|keychain>',
      '--keychain-service <name>         (default: happier/pipeline).',
      '--keychain-account <name>',
    ],
    bullets: ['Use ui-mobile-release if you want a higher-level flow (build + submit).'],
    examples: [
      'node scripts/pipeline/run.mjs expo-native-build --platform ios --profile production --out /tmp/eas_build.ios.json --build-mode local --local-runtime host --artifact-out dist/ui-mobile/happier-production-ios.ipa',
    ],
  },

  'expo-download-apk': {
    summary: 'Download the Android APK from a previous EAS Build JSON output.',
    usage:
      'node scripts/pipeline/run.mjs expo-download-apk --environment <preview|production> [--build-json <path>] [--out-dir <dir>]',
    options: [
      '--environment <preview|production>  Required.',
      '--build-json <path>               (default: /tmp/eas_build.json).',
      '--out-dir <dir>                   (default: dist/ui-mobile).',
      '--eas-cli-version <ver>           Optional; pins EAS CLI.',
      '--dry-run',
      '--secrets-source <auto|env|keychain>',
      '--keychain-service <name>          (default: happier/pipeline).',
      '--keychain-account <name>',
    ],
    bullets: ['Only relevant for *-apk EAS profiles.'],
    examples: ['node scripts/pipeline/run.mjs expo-download-apk --environment preview --build-json /tmp/eas_build.json'],
  },

  'expo-mobile-meta': {
    summary: 'Compute/emit mobile release metadata (used by workflows).',
    usage:
      'node scripts/pipeline/run.mjs expo-mobile-meta --environment <preview|production> [--download-ok true|false] [--out-json <path>]',
    options: [
      '--environment <preview|production>  Required.',
      '--download-ok <bool>              true|false (default: false).',
      '--app-version <semver>            Optional override.',
      '--out-json <path>                 Optional; write JSON metadata to a file.',
      '--dry-run',
      '--secrets-source <auto|env|keychain>',
      '--keychain-service <name>          (default: happier/pipeline).',
      '--keychain-account <name>',
    ],
    bullets: ['Mostly used internally by release automation.'],
    examples: ['node scripts/pipeline/run.mjs expo-mobile-meta --environment production --out-json dist/ui-mobile/meta.json'],
  },

  'expo-submit': {
    summary: 'Submit a native build to TestFlight / Play Store (EAS Submit).',
    usage:
      'node scripts/pipeline/run.mjs expo-submit --environment <preview|production> --platform <ios|android|all> [--profile <submitProfile>] [--path <artifactPath>]',
    options: [
      '--environment <preview|production>  Required.',
      '--platform <ios|android|all>       Required.',
      '--profile <name>                  Optional; EAS submit profile.',
      '--path <path>                     Optional; submit a local artifact (IPA/AAB/APK).',
      '--eas-cli-version <ver>           Optional; pins EAS CLI.',
      '--dry-run',
      '--secrets-source <auto|env|keychain>',
      '--keychain-service <name>          (default: happier/pipeline).',
      '--keychain-account <name>',
    ],
    bullets: ['Use --path to submit a locally-built artifact.'],
    examples: [
      'node scripts/pipeline/run.mjs expo-submit --environment production --platform ios --profile production --path dist/ui-mobile/happier-production-ios-v0.1.0.ipa',
    ],
  },

  'expo-publish-apk-release': {
    summary: 'Publish an Android APK asset as a GitHub Release (used for preview distribution).',
    usage:
      'node scripts/pipeline/run.mjs expo-publish-apk-release --environment <preview|production> --apk-path <path> --target-sha <sha> [--release-message <text>]',
    options: [
      '--environment <preview|production>  Required.',
      '--apk-path <path>                 Required.',
      '--target-sha <sha>                Required.',
      '--release-message <text>          Optional.',
      '--dry-run',
      '--secrets-source <auto|env|keychain>',
      '--keychain-service <name>          (default: happier/pipeline).',
      '--keychain-account <name>',
    ],
    bullets: ['Used by ui-mobile-release when building APK profiles.'],
    examples: [
      'node scripts/pipeline/run.mjs expo-publish-apk-release --environment preview --apk-path dist/ui-mobile/happier-preview-android.apk --target-sha $(git rev-parse HEAD)',
    ],
  },
};

