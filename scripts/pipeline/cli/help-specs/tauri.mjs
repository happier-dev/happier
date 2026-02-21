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
export const COMMAND_HELP_TAURI = {
  'tauri-validate-updater-pubkey': {
    summary: 'Validate that the Tauri updater public key matches the configured signing key.',
    usage: 'node scripts/pipeline/run.mjs tauri-validate-updater-pubkey --config-path <path> [--dry-run]',
    options: ['--config-path <path>            Required.', '--dry-run'],
    bullets: ['Run this when rotating signing keys or updating the updater config.'],
    examples: [
      'node scripts/pipeline/run.mjs tauri-validate-updater-pubkey --config-path apps/ui/src-tauri/tauri.conf.json',
    ],
  },

  'tauri-prepare-assets': {
    summary: 'Prepare Tauri publish assets (merge UI web + updater artifacts into publish dir).',
    usage:
      'node scripts/pipeline/run.mjs tauri-prepare-assets --environment <preview|production> --repo <owner/repo> --ui-version <semver> [--artifacts-dir <dir>] [--publish-dir <dir>]',
    options: [
      '--environment <preview|production>  Required.',
      '--repo <owner/repo>               Required.',
      '--ui-version <semver>             Required.',
      '--artifacts-dir <dir>             (default: dist/tauri/updates).',
      '--publish-dir <dir>               (default: dist/tauri/publish).',
      '--dry-run',
      '--secrets-source <auto|env|keychain>',
      '--keychain-service <name>          (default: happier/pipeline).',
      '--keychain-account <name>',
    ],
    bullets: ['Used by desktop release workflows before publishing updater releases.'],
    examples: ['node scripts/pipeline/run.mjs tauri-prepare-assets --environment preview --repo happier-dev/happier --ui-version 0.1.0'],
  },

  'tauri-build-updater-artifacts': {
    summary: 'Build Tauri updater artifacts (desktop binaries + signatures).',
    usage:
      'node scripts/pipeline/run.mjs tauri-build-updater-artifacts --environment <preview|production> [--build-version <semver>] [--tauri-target <target>] [--ui-dir <dir>]',
    options: [
      '--environment <preview|production>  Required.',
      '--build-version <semver>          Optional.',
      '--tauri-target <target>           Optional; build a single target.',
      '--ui-dir <dir>                    (default: apps/ui).',
      '--dry-run',
      '--secrets-source <auto|env|keychain>',
      '--keychain-service <name>          (default: happier/pipeline).',
      '--keychain-account <name>',
    ],
    bullets: ['Requires TAURI_SIGNING_PRIVATE_KEY (and Apple signing/notarization secrets for macOS).'],
    examples: ['node scripts/pipeline/run.mjs tauri-build-updater-artifacts --environment production --ui-dir apps/ui'],
  },

  'tauri-notarize-macos-artifacts': {
    summary: 'Notarize macOS Tauri artifacts (post-build step).',
    usage: 'node scripts/pipeline/run.mjs tauri-notarize-macos-artifacts [--ui-dir <dir>] [--tauri-target <target>] [--dry-run]',
    options: [
      '--ui-dir <dir>                    (default: apps/ui).',
      '--tauri-target <target>           Optional.',
      '--dry-run',
      '--secrets-source <auto|env|keychain>',
      '--keychain-service <name>          (default: happier/pipeline).',
      '--keychain-account <name>',
    ],
    bullets: ['Requires Apple notarization credentials (API key + team/issuer).'],
    examples: ['node scripts/pipeline/run.mjs tauri-notarize-macos-artifacts --ui-dir apps/ui'],
  },

  'tauri-collect-updater-artifacts': {
    summary: 'Collect/normalize updater artifacts into a directory for publishing.',
    usage:
      'node scripts/pipeline/run.mjs tauri-collect-updater-artifacts --environment <preview|production> --platform-key <key> --ui-version <semver> [--tauri-target <target>] [--ui-dir <dir>]',
    options: [
      '--environment <preview|production>  Required.',
      '--platform-key <key>              Required; e.g. darwin-arm64.',
      '--ui-version <semver>             Required.',
      '--tauri-target <target>           Optional.',
      '--ui-dir <dir>                    (default: apps/ui).',
      '--dry-run',
    ],
    bullets: ['Used for assembling multi-platform updater releases.'],
    examples: [
      'node scripts/pipeline/run.mjs tauri-collect-updater-artifacts --environment preview --platform-key darwin-arm64 --ui-version 0.1.0',
    ],
  },
};

