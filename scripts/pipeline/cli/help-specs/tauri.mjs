// @ts-check

import { formatPublicReleaseChannelChoices } from '../../release/lib/public-release-rings.mjs';

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
const TAURI_RELEASE_ENVIRONMENTS = formatPublicReleaseChannelChoices({
  stableAlias: 'production',
  preferredOrder: ['dev', 'preview', 'stable'],
});

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
      `node scripts/pipeline/run.mjs tauri-prepare-assets --environment <${TAURI_RELEASE_ENVIRONMENTS}> --repo <owner/repo> --ui-version <semver> [--artifacts-dir <dir>] [--publish-dir <dir>]`,
    options: [
      `--environment <${TAURI_RELEASE_ENVIRONMENTS}>  Required.`,
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
    examples: ['node scripts/pipeline/run.mjs tauri-prepare-assets --environment dev --repo happier-dev/happier --ui-version 0.1.0'],
  },

  'tauri-build-updater-artifacts': {
    summary: 'Build Tauri updater artifacts (desktop binaries + signatures).',
    usage:
      `node scripts/pipeline/run.mjs tauri-build-updater-artifacts --environment <${TAURI_RELEASE_ENVIRONMENTS}> [--build-version <semver>] [--tauri-target <target>] [--ui-dir <dir>]`,
    options: [
      `--environment <${TAURI_RELEASE_ENVIRONMENTS}>  Required.`,
      '--build-version <semver>          Optional.',
      '--tauri-target <target>           Optional; build a single target.',
      '--ui-dir <dir>                    (default: apps/ui).',
      '--no-bundle                      Build candidate binaries without bundles.',
      '--bundle-only                    Bundle already-built candidate binaries.',
      '--dry-run',
      '--secrets-source <auto|env|keychain>',
      '--keychain-service <name>          (default: happier/pipeline).',
      '--keychain-account <name>',
    ],
    bullets: ['Requires TAURI_SIGNING_PRIVATE_KEY (and Apple signing/notarization secrets for macOS).'],
    examples: ['node scripts/pipeline/run.mjs tauri-build-updater-artifacts --environment dev --build-version 0.1.0-dev.123 --ui-dir apps/ui'],
  },

  'tauri-bundle-candidate': {
    summary: 'Pack or materialize a strictly bound Tauri candidate-binary envelope.',
    usage:
      'node scripts/pipeline/run.mjs tauri-bundle-candidate --mode <pack|materialize> --platform-key <key> [binding and path options]',
    options: [
      '--mode <pack|materialize>         Required.',
      '--platform-key <key>              Required.',
      '--source-sha <sha>                Required for pack.',
      '--expected-source-sha <sha>       Required for materialize.',
      '--environment <name>              Required for pack.',
      '--expected-environment <name>     Required for materialize.',
      '--ui-version <semver>             Required for pack.',
      '--expected-ui-version <semver>    Required for materialize.',
      '--build-version <semver>          Required for pack.',
      '--expected-build-version <semver> Required for materialize.',
      '--tauri-target <target>           Optional.',
      '--ui-dir <dir>                    (default: apps/ui).',
      '--out-dir <dir>                   Required for pack.',
      '--candidate-dir <dir>             Required for materialize.',
    ],
    bullets: ['Carries only the fixed candidate binary layout across the trusted finalization boundary.'],
    examples: [
      'node scripts/pipeline/run.mjs tauri-bundle-candidate --mode pack --platform-key linux-x86_64 --source-sha 0123456789012345678901234567890123456789 --environment dev --ui-version 0.1.0 --build-version 0.1.0-dev.1 --out-dir dist/tauri/candidate',
    ],
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

  'tauri-sign-updater-artifacts': {
    summary: 'Replace updater signature files using the configured Tauri private key.',
    usage: 'node scripts/pipeline/run.mjs tauri-sign-updater-artifacts [--ui-dir <dir>] [--tauri-target <target>]',
    options: [
      '--ui-dir <dir>                    (default: apps/ui).',
      '--tauri-target <target>           Optional.',
    ],
    bullets: ['Requires TAURI_SIGNING_PRIVATE_KEY and rewrites signatures for existing updater bundles.'],
    examples: ['node scripts/pipeline/run.mjs tauri-sign-updater-artifacts --ui-dir apps/ui'],
  },

  'tauri-collect-updater-artifacts': {
    summary: 'Collect/normalize updater artifacts into a directory for publishing.',
    usage:
      `node scripts/pipeline/run.mjs tauri-collect-updater-artifacts --environment <${TAURI_RELEASE_ENVIRONMENTS}> --platform-key <key> --ui-version <semver> [--tauri-target <target>] [--ui-dir <dir>]`,
    options: [
      `--environment <${TAURI_RELEASE_ENVIRONMENTS}>  Required.`,
      '--platform-key <key>              Required; e.g. darwin-arm64.',
      '--ui-version <semver>             Required.',
      '--tauri-target <target>           Optional.',
      '--ui-dir <dir>                    (default: apps/ui).',
      '--dry-run',
    ],
    bullets: ['Used for assembling multi-platform updater releases.'],
    examples: [
      'node scripts/pipeline/run.mjs tauri-collect-updater-artifacts --environment dev --platform-key darwin-arm64 --ui-version 0.1.0',
    ],
  },
};
