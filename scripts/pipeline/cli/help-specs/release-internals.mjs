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

/**
 * Wrapper flags (owned by `run.mjs`) for `release-*` wrapped scripts:
 * - `--deploy-environment <preview|production>`
 * - `--dry-run`
 * - `--secrets-source <auto|env|keychain>`
 * - `--keychain-service <name>`
 * - `--keychain-account <name>`
 *
 * All other flags are forwarded verbatim to the underlying script in `scripts/pipeline/release/*`.
 */

/** @type {Record<string, CommandHelpSpec>} */
export const COMMAND_HELP_RELEASE_INTERNALS = {
  'release-bump-plan': {
    summary: 'Compute a bump plan from “changed components” inputs (workflow helper).',
    usage:
      'node scripts/pipeline/run.mjs release-bump-plan --environment <preview|production> --bump-preset <none|patch|minor|major> [--deploy-targets <csv>]',
    options: [
      '--environment <preview|production>  Required.',
      '--bump-preset <preset>            Required; none|patch|minor|major.',
      '--bump-app-override <preset>      (default: preset).',
      '--bump-cli-override <preset>      (default: preset).',
      '--bump-stack-override <preset>    (default: preset).',
      '--deploy-targets <csv>            Optional.',
      '--changed-ui <bool>',
      '--changed-cli <bool>',
      '--changed-stack <bool>',
      '--changed-server <bool>',
      '--changed-website <bool>',
      '--changed-shared <bool>',
    ],
    bullets: ['Most operators should use `release`, not this subcommand.'],
    examples: [
      'node scripts/pipeline/run.mjs release-bump-plan --environment preview --bump-preset patch --changed-ui true --changed-server true',
    ],
  },

  'release-bump-versions-dev': {
    summary: 'Bump selected component versions and push a commit to a branch (CI helper).',
    usage:
      'node scripts/pipeline/run.mjs release-bump-versions-dev [--bump-app <bump>] [--bump-server <bump>] [--push-branch <branch>] [--dry-run]',
    options: [
      '--bump-app <none|patch|minor|major> (default: none).',
      '--bump-server <none|patch|minor|major> (default: none).',
      '--bump-website <none|patch|minor|major> (default: none).',
      '--bump-cli <none|patch|minor|major> (default: none).',
      '--bump-stack <none|patch|minor|major> (default: none).',
      '--push-branch <branch>            (default: dev).',
      '--commit-message <text>           Optional.',
      '--dry-run',
    ],
    bullets: ['Used by release workflows to prepare version bumps on dev/main.'],
    examples: [
      'node scripts/pipeline/run.mjs release-bump-versions-dev --bump-cli patch --bump-stack patch --push-branch dev --dry-run',
    ],
  },

  'release-sync-installers': {
    summary: 'Sync installer scripts from scripts/release/installers into apps/website/public (advanced helper).',
    usage:
      'node scripts/pipeline/run.mjs release-sync-installers [--deploy-environment <preview|production>] [--check] [--source-dir <dir>] [--target-dir <dir>]',
    options: [
      '--deploy-environment <env>        Wrapper flag (default: production).',
      '--secrets-source <auto|env|keychain>  Wrapper flag.',
      '--keychain-service <name>         Wrapper flag (default: happier/pipeline).',
      '--keychain-account <name>         Wrapper flag.',
      '--dry-run                         Wrapper flag.',
      '--check                           Script flag; fail if installers are out of sync.',
      '--source-dir <dir>                Script flag (default: scripts/release/installers).',
      '--target-dir <dir>                Script flag (default: apps/website/public).',
    ],
    bullets: ['In most flows, publish-* commands validate installers automatically (via --check-installers).'],
    examples: ['node scripts/pipeline/run.mjs release-sync-installers --check --dry-run'],
  },

  'release-bump-version': {
    summary: 'Bump a single component version in-place (advanced helper).',
    usage:
      'node scripts/pipeline/run.mjs release-bump-version --component <app|cli|server|website|stack> --bump <none|patch|minor|major>',
    options: [
      '--deploy-environment <env>        Wrapper flag (default: production).',
      '--secrets-source <auto|env|keychain>  Wrapper flag.',
      '--keychain-service <name>         Wrapper flag (default: happier/pipeline).',
      '--keychain-account <name>         Wrapper flag.',
      '--dry-run                         Wrapper flag.',
      '--component <name>                Script flag (required).',
      '--bump <kind>                     Script flag (required).',
    ],
    bullets: ['Updates app version across Expo + Tauri config when component=app.'],
    examples: ['node scripts/pipeline/run.mjs release-bump-version --component cli --bump patch'],
  },

  'release-build-cli-binaries': {
    summary: 'Build CLI binary artifacts + minisign checksums (advanced helper).',
    usage:
      'node scripts/pipeline/run.mjs release-build-cli-binaries --channel <preview|stable> [--version <ver>] [--targets <csv>] [--externals <csv>]',
    options: [
      '--deploy-environment <env>        Wrapper flag (default: production).',
      '--secrets-source <auto|env|keychain>  Wrapper flag.',
      '--keychain-service <name>         Wrapper flag (default: happier/pipeline).',
      '--keychain-account <name>         Wrapper flag.',
      '--dry-run                         Wrapper flag.',
      '--channel <preview|stable>        Script flag.',
      '--version <ver>                   Script flag; defaults to apps/cli package.json.',
      '--targets <csv>                   Script flag.',
      '--externals <csv>                 Script flag; bun externals.',
    ],
    bullets: ['Requires bun + minisign (for signatures).'],
    examples: ['node scripts/pipeline/run.mjs release-build-cli-binaries --channel preview --targets linux-x64,linux-arm64'],
  },

  'release-build-hstack-binaries': {
    summary: 'Build hstack binary artifacts + minisign checksums (advanced helper).',
    usage:
      'node scripts/pipeline/run.mjs release-build-hstack-binaries --channel <preview|stable> [--version <ver>] [--entrypoint <path>] [--targets <csv>]',
    options: [
      '--deploy-environment <env>        Wrapper flag (default: production).',
      '--secrets-source <auto|env|keychain>  Wrapper flag.',
      '--keychain-service <name>         Wrapper flag (default: happier/pipeline).',
      '--keychain-account <name>         Wrapper flag.',
      '--dry-run                         Wrapper flag.',
      '--channel <preview|stable>        Script flag.',
      '--version <ver>                   Script flag; defaults to apps/stack package.json.',
      '--entrypoint <path>               Script flag; defaults to apps/stack/scripts/self_host.mjs.',
      '--targets <csv>                   Script flag.',
      '--externals <csv>                 Script flag.',
    ],
    bullets: ['Requires bun + minisign (for signatures).'],
    examples: ['node scripts/pipeline/run.mjs release-build-hstack-binaries --channel preview --targets darwin-arm64'],
  },

  'release-build-server-binaries': {
    summary: 'Build server binary artifacts + minisign checksums (advanced helper).',
    usage:
      'node scripts/pipeline/run.mjs release-build-server-binaries --channel <preview|stable> [--version <ver>] [--entrypoint <path>] [--targets <csv>]',
    options: [
      '--deploy-environment <env>        Wrapper flag (default: production).',
      '--secrets-source <auto|env|keychain>  Wrapper flag.',
      '--keychain-service <name>         Wrapper flag (default: happier/pipeline).',
      '--keychain-account <name>         Wrapper flag.',
      '--dry-run                         Wrapper flag.',
      '--channel <preview|stable>        Script flag.',
      '--version <ver>                   Script flag; defaults to apps/server package.json.',
      '--entrypoint <path>               Script flag; defaults to apps/server/sources/main.light.ts.',
      '--targets <csv>                   Script flag.',
      '--externals <csv>                 Script flag; bun externals.',
    ],
    bullets: ['Ensures Prisma clients are generated before compiling.'],
    examples: ['node scripts/pipeline/run.mjs release-build-server-binaries --channel preview --targets linux-x64'],
  },

  'release-publish-manifests': {
    summary: 'Generate “latest.json” manifest(s) for a product/channel (advanced helper).',
    usage:
      'node scripts/pipeline/run.mjs release-publish-manifests --product <happier|hstack|happier-server> --channel <preview|stable> --assets-base-url <url> [--artifacts-dir <dir>]',
    options: [
      '--deploy-environment <env>        Wrapper flag (default: production).',
      '--secrets-source <auto|env|keychain>  Wrapper flag.',
      '--keychain-service <name>         Wrapper flag (default: happier/pipeline).',
      '--keychain-account <name>         Wrapper flag.',
      '--dry-run                         Wrapper flag.',
      '--product <name>                  Script flag (required).',
      '--channel <preview|stable>        Script flag (required).',
      '--assets-base-url <url>           Script flag (required).',
      '--artifacts-dir <dir>             Script flag (default: dist/release-assets).',
      '--out-dir <dir>                   Script flag (default: dist/manifests).',
      '--rollout-percent <n>             Script flag (default: 100).',
      '--critical <bool>                 Script flag (default: false).',
      '--notes-url <url>                 Script flag (optional).',
      '--min-supported-version <ver>     Script flag (optional).',
      '--version <ver>                   Script flag (optional).',
      '--commit-sha <sha>                Script flag (optional).',
      '--workflow-run-id <id>            Script flag (optional).',
    ],
    bullets: ['Manifests are consumed by installer scripts and self-host tooling.'],
    examples: [
      'node scripts/pipeline/run.mjs release-publish-manifests --product happier --channel preview --assets-base-url https://github.com/happier-dev/happier/releases/download/cli-preview',
    ],
  },

  'release-verify-artifacts': {
    summary: 'Verify checksums/signatures and optionally smoke-test release artifacts (advanced helper).',
    usage:
      'node scripts/pipeline/run.mjs release-verify-artifacts [--artifacts-dir <dir>] [--checksums <path>] [--public-key <path>] [--skip-smoke]',
    options: [
      '--deploy-environment <env>        Wrapper flag (default: production).',
      '--secrets-source <auto|env|keychain>  Wrapper flag.',
      '--keychain-service <name>         Wrapper flag (default: happier/pipeline).',
      '--keychain-account <name>         Wrapper flag.',
      '--dry-run                         Wrapper flag.',
      '--artifacts-dir <dir>             Script flag (default: dist/release-assets).',
      '--checksums <path>                Script flag; defaults to first checksums-*.txt found.',
      '--public-key <path>               Script flag; or set MINISIGN_PUBLIC_KEY.',
      '--skip-smoke                      Script flag.',
    ],
    bullets: ['This is safety-critical; prefer running it in CI in addition to local runs.'],
    examples: [
      'node scripts/pipeline/run.mjs release-verify-artifacts --artifacts-dir dist/release-assets/cli --public-key scripts/release/installers/happier-release.pub',
    ],
  },

  'release-compute-changed-components': {
    summary: 'Compute “changed components” booleans from a git diff range (advanced helper).',
    usage: 'node scripts/pipeline/run.mjs release-compute-changed-components --base <ref> --head <ref> [--out <githubOutputPath>]',
    options: [
      '--deploy-environment <env>        Wrapper flag (default: production).',
      '--dry-run                         Wrapper flag.',
      '--secrets-source <auto|env|keychain>  Wrapper flag.',
      '--keychain-service <name>         Wrapper flag.',
      '--keychain-account <name>         Wrapper flag.',
      '--base <ref>                      Script flag (required).',
      '--head <ref>                      Script flag (required).',
      '--out <path>                      Script flag; writes KEY=VALUE lines.',
    ],
    bullets: ['Used by workflows to decide what to publish.'],
    examples: ['node scripts/pipeline/run.mjs release-compute-changed-components --base origin/main --head HEAD'],
  },

  'release-resolve-bump-plan': {
    summary: 'Resolve which components should be bumped given a preset + changed inputs (advanced helper).',
    usage:
      'node scripts/pipeline/run.mjs release-resolve-bump-plan --environment <preview|production> --bump-preset <none|patch|minor|major> [--github-output <path>]',
    options: [
      '--deploy-environment <env>        Wrapper flag (default: production).',
      '--dry-run                         Wrapper flag.',
      '--secrets-source <auto|env|keychain>  Wrapper flag.',
      '--keychain-service <name>         Wrapper flag.',
      '--keychain-account <name>         Wrapper flag.',
      '--environment <preview|production>  Script flag (required).',
      '--bump-preset <preset>            Script flag (required).',
      '--bump-app-override <preset>      Script flag (default: preset).',
      '--bump-cli-override <preset>      Script flag (default: preset).',
      '--bump-stack-override <preset>    Script flag (default: preset).',
      '--deploy-targets <csv>            Script flag.',
      '--changed-ui <bool>',
      '--changed-cli <bool>',
      '--changed-stack <bool>',
      '--changed-server <bool>',
      '--changed-website <bool>',
      '--changed-shared <bool>',
      '--github-output <path>',
    ],
    bullets: ['Generally invoked via release-bump-plan.'],
    examples: ['node scripts/pipeline/run.mjs release-resolve-bump-plan --environment preview --bump-preset patch --changed-ui true'],
  },

  'release-compute-deploy-plan': {
    summary: 'Compute whether deploy branches need updating for each hosted component (advanced helper).',
    usage:
      'node scripts/pipeline/run.mjs release-compute-deploy-plan --deploy-environment <preview|production> --source-ref <ref> --force-deploy <bool> --deploy-ui <bool> --deploy-server <bool> --deploy-website <bool> --deploy-docs <bool>',
    options: [
      '--deploy-environment <env>        Script flag (required).',
      '--source-ref <ref>                Script flag (required).',
      '--force-deploy <bool>             Script flag.',
      '--deploy-ui <bool>                Script flag.',
      '--deploy-server <bool>            Script flag.',
      '--deploy-website <bool>           Script flag.',
      '--deploy-docs <bool>              Script flag.',
      '--remote <name>                   Script flag (default: origin).',
      '--github-output <path>            Script flag.',
      '--dry-run                         Wrapper flag.',
      '--secrets-source <auto|env|keychain>  Wrapper flag.',
      '--keychain-service <name>         Wrapper flag.',
      '--keychain-account <name>         Wrapper flag.',
    ],
    bullets: ['Used internally to decide whether to promote deploy branches.'],
    examples: [
      'node scripts/pipeline/run.mjs release-compute-deploy-plan --deploy-environment preview --source-ref dev --force-deploy false --deploy-ui true --deploy-server true --deploy-website true --deploy-docs true',
    ],
  },

  'release-build-ui-web-bundle': {
    summary: 'Build the UI web bundle artifact (advanced helper).',
    usage:
      'node scripts/pipeline/run.mjs release-build-ui-web-bundle --channel <preview|stable> [--version <ver>] [--dist-dir <dir>] [--out-dir <dir>] [--skip-build]',
    options: [
      '--deploy-environment <env>        Wrapper flag (default: production).',
      '--dry-run                         Wrapper flag.',
      '--secrets-source <auto|env|keychain>  Wrapper flag.',
      '--keychain-service <name>         Wrapper flag.',
      '--keychain-account <name>         Wrapper flag.',
      '--channel <preview|stable>        Script flag.',
      '--version <ver>                   Script flag; defaults to apps/ui package.json.',
      '--dist-dir <dir>                  Script flag (default: apps/ui/dist).',
      '--out-dir <dir>                   Script flag (default: dist/release-assets/ui-web).',
      '--skip-build                      Script flag.',
    ],
    bullets: ['Most operators should use publish-ui-web, not this helper.'],
    examples: ['node scripts/pipeline/run.mjs release-build-ui-web-bundle --channel preview --skip-build'],
  },
};

