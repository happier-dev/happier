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
export const COMMAND_HELP_NPM = {
  'npm-release': {
    summary: 'Pack and publish npm packages (CLI / stack / relay-server).',
    usage:
      'node scripts/pipeline/run.mjs npm-release --channel <preview|production> --publish-cli <true|false> --publish-stack <true|false> --publish-server <true|false> [--mode pack|pack+publish]',
    options: [
      '--channel <preview|production>    Required.',
      '--publish-cli <bool>              Publish apps/cli (default: false).',
      '--publish-stack <bool>            Publish apps/stack (default: false).',
      '--publish-server <bool>           Publish packages/relay-server (default: false).',
      '--server-runner-dir <dir>         (default: packages/relay-server).',
      '--run-tests <auto|true|false>     (default: auto).',
      '--mode <pack|pack+publish>        (default: pack+publish).',
      '--allow-dirty <bool>              true|false (default: false).',
      '--dry-run',
      '--secrets-source <auto|env|keychain>',
      '--keychain-service <name>         (default: happier/pipeline).',
      '--keychain-account <name>',
    ],
    bullets: [
      'Preview publishes temporary versions (no commit) using a preview suffix (X.Y.Z-preview.<run>.<attempt>).',
      'Local auth: uses NPM_TOKEN if set, otherwise falls back to your local npm login state.',
    ],
    examples: [
      'node scripts/pipeline/run.mjs npm-release --channel preview --publish-cli true --publish-stack true --mode pack+publish',
      'node scripts/pipeline/run.mjs npm-release --channel preview --publish-server true --mode pack+publish',
    ],
  },

  'npm-publish': {
    summary: 'Publish a pre-built .tgz tarball to npm (lower-level helper).',
    usage:
      'node scripts/pipeline/run.mjs npm-publish --channel <preview|production> (--tarball <path>|--tarball-dir <dir>) [--tag <distTag>] [--dry-run]',
    options: [
      '--channel <preview|production>    Required.',
      '--tarball <path>                 A single `.tgz` file to publish.',
      '--tarball-dir <dir>              Publish all `.tgz` files in the directory.',
      '--tag <distTag>                  Optional npm dist-tag override.',
      '--allow-dirty <bool>             true|false (default: false).',
      '--dry-run',
      '--secrets-source <auto|env|keychain>',
      '--keychain-service <name>         (default: happier/pipeline).',
      '--keychain-account <name>',
    ],
    bullets: ['Usually used by npm-release; use directly only when you already have a tarball.'],
    examples: ['node scripts/pipeline/run.mjs npm-publish --channel preview --tarball dist/release-assets/cli/happier-cli.tgz --dry-run'],
  },

  'npm-set-preview-versions': {
    summary: 'Compute (and optionally write) preview versions into package.json files.',
    usage:
      'node scripts/pipeline/run.mjs npm-set-preview-versions --publish-cli <true|false> --publish-stack <true|false> --publish-server <true|false> [--write true|false]',
    options: [
      '--repo-root <path>               Optional override.',
      '--publish-cli <bool>             (default: false).',
      '--publish-stack <bool>           (default: false).',
      '--publish-server <bool>          (default: false).',
      '--server-runner-dir <dir>        (default: packages/relay-server).',
      '--write <bool>                   true|false (default: true).',
    ],
    bullets: ['Mainly used internally by npm-release / release; most operators should use npm-release.'],
    examples: ['node scripts/pipeline/run.mjs npm-set-preview-versions --publish-cli true --publish-stack true --write false'],
  },
};

