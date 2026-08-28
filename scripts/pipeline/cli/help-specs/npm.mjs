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
    summary: 'Pack and publish npm packages (CLI / stack / relay-server / public SDKs).',
    usage:
      'node scripts/pipeline/run.mjs npm-release --channel <dev|preview|production> --publish-cli <true|false> --publish-stack <true|false> --publish-server <true|false> --publish-plugin-sdk <true|false> --publish-sdk <true|false> --publish-channels-protocol <true|false> [--mode pack|pack+publish]',
    options: [
      '--channel <dev|preview|production> Required.',
      '--publish-cli <bool>              Publish apps/cli (default: false).',
      '--publish-stack <bool>            Publish apps/stack (default: false).',
      '--publish-server <bool>           Publish packages/relay-server (default: false).',
      '--publish-plugin-sdk <bool>       Publish the lockstep plugin-sdk/plugin-ui pair (default: false).',
      '--publish-sdk <bool>              Publish packages/sdk (default: false).',
      '--publish-channels-protocol <bool> Publish packages/channels-protocol (default: false).',
      '--server-runner-dir <dir>         (default: packages/relay-server).',
      '--run-tests <auto|true|false>     (default: auto).',
      '--mode <pack|pack+publish>        (default: pack+publish).',
      '--authorized-sha <40-hex>         Required for a real pack+publish; use the exact SHA emitted by release admission.',
      '--plugin-sdk-version <version>    Optional exact lockstep pair version.',
      '--sdk-version <version>           Optional exact SDK version.',
      '--channels-protocol-version <version> Optional exact Channels protocol version.',
      '--approve-public-sdk-release <bool> Explicit maintainer publication approval.',
      '--plugin-sdk-ready <bool>         Confirm Plugin SDK/UI readiness.',
      '--plugin-sdk-api-classification <first_publication|compatible|breaking>',
      '--plugin-sdk-migration-notes <not_required|release-id>',
      '--sdk-auth-readiness <not_ready|ready|waived>',
      '--sdk-auth-waiver <name>          Required when auth readiness is waived.',
      '--sdk-api-classification <first_publication|compatible|breaking>',
      '--sdk-migration-notes <not_required|release-id>',
      '--release-notes-id <id>          Approved release section containing migration notes.',
      '--allow-dirty <bool>              true|false (default: false).',
      '--dry-run',
      '--secrets-source <auto|env|keychain>',
      '--keychain-service <name>         (default: happier/pipeline).',
      '--keychain-account <name>',
    ],
    bullets: [
      'Dev/preview publishes temporary versions (no commit) using the rolling release-ring suffix (for example X.Y.Z-dev.<sequence>).',
      'Public SDK releases use sandbox-only manifests; plugin-sdk and plugin-ui remain a single lockstep pair.',
      'The public Channels protocol has its own consumers and cadence: it packs through the same sandbox and publishes through the generic tarball publisher, never the lockstep pair.',
      'Pack-only and dry-run work without publication admission. Real public SDK publication fails closed until readiness, API classification, migration notes, and maintainer approval are explicit.',
      'Local auth: uses NPM_TOKEN if set, otherwise falls back to your local npm login state.',
    ],
    examples: [
      'node scripts/pipeline/run.mjs npm-release --channel dev --publish-cli true --authorized-sha <release-admitted-sha> --mode pack+publish',
      'node scripts/pipeline/run.mjs npm-release --channel preview --publish-cli true --publish-stack true --authorized-sha <release-admitted-sha> --mode pack+publish',
      'node scripts/pipeline/run.mjs npm-release --channel preview --publish-server true --authorized-sha <release-admitted-sha> --mode pack+publish',
      'node scripts/pipeline/run.mjs npm-release --channel preview --publish-plugin-sdk true --publish-sdk false --mode pack',
      'node scripts/pipeline/run.mjs npm-release --channel preview --publish-channels-protocol true --mode pack',
    ],
  },

  'npm-publish': {
    summary: 'Dry-run npm publication for a pre-built .tgz tarball.',
    usage:
      'node scripts/pipeline/run.mjs npm-publish --channel <dev|preview|production> (--tarball <path>|--tarball-dir <dir>) [--tag <distTag>] [--authorized-sha <40-hex>] --dry-run',
    options: [
      '--channel <dev|preview|production> Required.',
      '--tarball <path>                 A single `.tgz` file to publish.',
      '--tarball-dir <dir>              Publish all `.tgz` files in the directory.',
      '--tag <distTag>                  Optional npm dist-tag override.',
      '--authorized-sha <40-hex>        Accepted for dry-run parity; real publication is disabled.',
      '--allow-dirty <bool>             Accepted for dry-run parity (default: false).',
      '--dry-run',
      '--secrets-source <auto|env|keychain>',
      '--keychain-service <name>         (default: happier/pipeline).',
      '--keychain-account <name>',
    ],
    bullets: [
      'Real local publication is disabled with DIRECT_NPM_PUBLISH_DISABLED.',
      'Use checkout-bound npm-release from the checkout that prepared the candidate for a real publication.',
    ],
    examples: ['node scripts/pipeline/run.mjs npm-publish --channel dev --tarball dist/release-assets/cli/happier-cli.tgz --dry-run'],
  },

  'npm-set-preview-versions': {
    summary: 'Compute (and optionally write) preview versions into package.json files.',
    usage:
      'node scripts/pipeline/run.mjs npm-set-preview-versions --publish-cli <true|false> --publish-stack <true|false> --publish-server <true|false> --publish-plugin-sdk <true|false> --publish-sdk <true|false> [--write true|false]',
    options: [
      '--repo-root <path>               Optional override.',
      '--publish-cli <bool>             (default: false).',
      '--publish-stack <bool>           (default: false).',
      '--publish-server <bool>          (default: false).',
      '--publish-plugin-sdk <bool>      Compute/write the lockstep plugin-sdk/plugin-ui version (default: false).',
      '--publish-sdk <bool>             Compute/write the public SDK version (default: false).',
      '--publish-channels-protocol <bool> Compute/write the public Channels protocol version (default: false).',
      '--server-runner-dir <dir>        (default: packages/relay-server).',
      '--write <bool>                   true|false (default: true).',
    ],
    bullets: ['Mainly used internally by npm-release / release; most operators should use npm-release.'],
    examples: [
      'node scripts/pipeline/run.mjs npm-set-preview-versions --publish-cli true --publish-stack true --write false',
      'node scripts/pipeline/run.mjs npm-set-preview-versions --publish-plugin-sdk true --publish-sdk false --write false',
    ],
  },
};
