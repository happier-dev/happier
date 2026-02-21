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
export const COMMAND_HELP_PUBLISH = {
  'publish-cli-binaries': {
    summary: 'Build + publish CLI binaries to GitHub Releases (rolling + version tags).',
    usage:
      'node scripts/pipeline/run.mjs publish-cli-binaries --channel <preview|stable> [--release-message <text>] [--dry-run]',
    options: [
      '--channel <preview|stable>        Required.',
      '--allow-stable <bool>            true|false (default: false).',
      '--release-message <text>         Optional.',
      '--run-contracts <auto|true|false> (default: auto).',
      '--check-installers <bool>        true|false (default: true).',
      '--allow-dirty <bool>             true|false (default: false).',
      '--dry-run',
      '--secrets-source <auto|env|keychain>',
      '--keychain-service <name>         (default: happier/pipeline).',
      '--keychain-account <name>',
    ],
    bullets: [
      'Requires MINISIGN_SECRET_KEY (+ MINISIGN_PASSPHRASE if encrypted).',
      'Publishes a rolling tag (cli-preview/cli-stable) and a versioned tag (cli-vX.Y.Z...).',
    ],
    examples: ['node scripts/pipeline/run.mjs publish-cli-binaries --channel preview --release-message "CLI preview"'],
  },

  'publish-hstack-binaries': {
    summary: 'Build + publish hstack binaries to GitHub Releases (rolling + version tags).',
    usage:
      'node scripts/pipeline/run.mjs publish-hstack-binaries --channel <preview|stable> [--release-message <text>] [--dry-run]',
    options: [
      '--channel <preview|stable>        Required.',
      '--allow-stable <bool>            true|false (default: false).',
      '--release-message <text>         Optional.',
      '--run-contracts <auto|true|false> (default: auto).',
      '--check-installers <bool>        true|false (default: true).',
      '--allow-dirty <bool>             true|false (default: false).',
      '--dry-run',
      '--secrets-source <auto|env|keychain>',
      '--keychain-service <name>         (default: happier/pipeline).',
      '--keychain-account <name>',
    ],
    bullets: ['Requires MINISIGN_SECRET_KEY (+ MINISIGN_PASSPHRASE if encrypted).'],
    examples: ['node scripts/pipeline/run.mjs publish-hstack-binaries --channel preview --release-message "Stack preview"'],
  },

  'publish-server-runtime': {
    summary: 'Build + publish relay-server (server runner) runtime binaries to GitHub Releases.',
    usage:
      'node scripts/pipeline/run.mjs publish-server-runtime --channel <preview|stable> [--release-message <text>] [--dry-run]',
    options: [
      '--channel <preview|stable>        Required.',
      '--allow-stable <bool>            true|false (default: false).',
      '--release-message <text>         Optional.',
      '--run-contracts <auto|true|false> (default: auto).',
      '--check-installers <bool>        true|false (default: true).',
      '--allow-dirty <bool>             true|false (default: false).',
      '--dry-run',
      '--secrets-source <auto|env|keychain>',
      '--keychain-service <name>         (default: happier/pipeline).',
      '--keychain-account <name>',
    ],
    bullets: ['Requires MINISIGN_SECRET_KEY (+ MINISIGN_PASSPHRASE if encrypted).'],
    examples: ['node scripts/pipeline/run.mjs publish-server-runtime --channel preview --release-message "Relay server preview"'],
  },

  'publish-ui-web': {
    summary: 'Build + publish the UI web bundle as GitHub release assets.',
    usage:
      'node scripts/pipeline/run.mjs publish-ui-web --channel <preview|stable> [--release-message <text>] [--dry-run]',
    options: [
      '--channel <preview|stable>        Required.',
      '--allow-stable <bool>            true|false (default: false).',
      '--release-message <text>         Optional.',
      '--run-contracts <auto|true|false> (default: auto).',
      '--check-installers <bool>        true|false (default: true).',
      '--allow-dirty <bool>             true|false (default: false).',
      '--dry-run',
      '--secrets-source <auto|env|keychain>',
      '--keychain-service <name>         (default: happier/pipeline).',
      '--keychain-account <name>',
    ],
    bullets: ['Publishes a rolling tag and a versioned tag for the UI web bundle assets.'],
    examples: ['node scripts/pipeline/run.mjs publish-ui-web --channel preview --release-message "UI web preview"'],
  },
};

