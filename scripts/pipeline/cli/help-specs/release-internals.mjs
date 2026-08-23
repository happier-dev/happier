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

/**
 * Wrapper flags (owned by `run.mjs`) for `release-*` wrapped scripts:
 * - `--deploy-environment <dev|preview|production>`
 * - `--dry-run`
 * - `--secrets-source <auto|env|keychain>`
 * - `--keychain-service <name>`
 * - `--keychain-account <name>`
 *
 * All other flags are forwarded verbatim to the underlying script in `scripts/pipeline/release/*`.
 */

/** @type {Record<string, CommandHelpSpec>} */
const publicReleaseChannelChoices = formatPublicReleaseChannelChoices();

export const COMMAND_HELP_RELEASE_INTERNALS = {
  'release-contract': {
    summary: 'Print the versioned public release contract as JSON.',
    usage: 'node scripts/pipeline/run.mjs release-contract',
    options: [],
    bullets: [
      'JSON-only read surface for canonical release targets, validation suites, and the integrated, stable, and deep profiles.',
      'It is preparation-only: it does not select a candidate, dispatch validation, publish, deploy, migrate, or cut over a self-hosted relay.',
    ],
    examples: ['node scripts/pipeline/run.mjs release-contract'],
  },

  'release-bump-plan': {
    summary: 'Compute a bump plan from “changed components” inputs (workflow helper).',
    usage:
      'node scripts/pipeline/run.mjs release-bump-plan --environment <dev|preview|production> --bump-preset <none|patch|minor|major> [--deploy-targets <csv>]',
    options: [
      '--environment <dev|preview|production>  Required.',
      '--bump-preset <preset>            Required; none|patch|minor|major.',
      '--bump-app-override <preset>      (default: preset).',
      '--bump-cli-override <preset>      (default: preset).',
      '--bump-stack-override <preset>    (default: preset).',
      '--bump-plugin-sdk-override <preset> (default: preset; applies to the lockstep pair).',
      '--bump-sdk-override <preset>      (default: preset).',
      '--deploy-targets <csv>            Optional.',
      '--changed-ui <bool>',
      '--changed-cli <bool>',
      '--changed-stack <bool>',
      '--changed-server <bool>',
      '--changed-website <bool>',
      '--changed-shared <bool>',
      '--changed-plugin-sdk <bool>',
      '--changed-sdk <bool>',
      '--versioned-app-changed <bool>   Optional per-component override.',
      '--versioned-cli-changed <bool>   Optional per-component override.',
      '--versioned-stack-changed <bool> Optional per-component override.',
      '--versioned-server-changed <bool> Optional per-component override.',
      '--versioned-plugin-sdk-changed <bool> Optional per-component override.',
      '--versioned-sdk-changed <bool>   Optional per-component override.',
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
      '--bump-plugin-sdk <none|patch|minor|major> (default: none; lockstep plugin-sdk/plugin-ui).',
      '--bump-sdk <none|patch|minor|major> (default: none).',
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
      'node scripts/pipeline/run.mjs release-bump-version --component <app|cli|server|website|stack|plugin_sdk|sdk> --bump <none|patch|minor|major>',
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
      `node scripts/pipeline/run.mjs release-build-cli-binaries --channel <${publicReleaseChannelChoices}> [--version <ver>] [--targets <csv>] [--externals <csv>] [--cliproxyapi-managed-runtime-executable <path>] [--macos-signing-identity <identity> --macos-notarization-output <path>]`,
    options: [
      '--deploy-environment <env>        Wrapper flag (default: production).',
      '--secrets-source <auto|env|keychain>  Wrapper flag.',
      '--keychain-service <name>         Wrapper flag (default: happier/pipeline).',
      '--keychain-account <name>         Wrapper flag.',
      '--dry-run                         Wrapper flag.',
      `--channel <${publicReleaseChannelChoices}>        Script flag.`,
      '--version <ver>                   Script flag; defaults to apps/cli package.json.',
      '--targets <csv>                   Script flag.',
      '--externals <csv>                 Script flag; bun externals.',
      '--cliproxyapi-managed-runtime-executable <path>  Script flag; one prebuilt wrapper for one target.',
      '--macos-signing-identity <identity>  Script flag; Developer ID identity for one Darwin target.',
      '--macos-notarization-output <path>  Script flag; required with macOS signing identity.',
    ],
    bullets: ['Requires bun + minisign (for signatures).'],
    examples: ['node scripts/pipeline/run.mjs release-build-cli-binaries --channel preview --targets linux-x64,linux-arm64'],
  },

  'release-build-hstack-binaries': {
    summary: 'Build hstack binary artifacts + minisign checksums (advanced helper).',
    usage:
      `node scripts/pipeline/run.mjs release-build-hstack-binaries --channel <${publicReleaseChannelChoices}> [--version <ver>] [--entrypoint <path>] [--targets <csv>]`,
    options: [
      '--deploy-environment <env>        Wrapper flag (default: production).',
      '--secrets-source <auto|env|keychain>  Wrapper flag.',
      '--keychain-service <name>         Wrapper flag (default: happier/pipeline).',
      '--keychain-account <name>         Wrapper flag.',
      '--dry-run                         Wrapper flag.',
      `--channel <${publicReleaseChannelChoices}>        Script flag.`,
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
      `node scripts/pipeline/run.mjs release-build-server-binaries --channel <${publicReleaseChannelChoices}> [--version <ver>] [--entrypoint <path>] [--targets <csv>]`,
    options: [
      '--deploy-environment <env>        Wrapper flag (default: production).',
      '--secrets-source <auto|env|keychain>  Wrapper flag.',
      '--keychain-service <name>         Wrapper flag (default: happier/pipeline).',
      '--keychain-account <name>         Wrapper flag.',
      '--dry-run                         Wrapper flag.',
      `--channel <${publicReleaseChannelChoices}>        Script flag.`,
      '--version <ver>                   Script flag; defaults to apps/server package.json.',
      '--entrypoint <path>               Script flag; defaults to apps/server/sources/main.light.ts.',
      '--targets <csv>                   Script flag.',
      '--externals <csv>                 Script flag; bun externals.',
    ],
    bullets: ['Ensures Prisma clients are generated before compiling.'],
    examples: ['node scripts/pipeline/run.mjs release-build-server-binaries --channel preview --targets linux-x64'],
  },

  'release-prepare-binary-assets': {
    summary: 'Prepare binary release assets through the shared product publisher path.',
    usage:
      `node scripts/pipeline/run.mjs release-prepare-binary-assets --product <cli|hstack|server> --channel <${publicReleaseChannelChoices}> --version <ver> --assets-base-url <url> --commit-sha <sha> [--skip-smoke]`,
    options: [
      '--deploy-environment <env>        Wrapper flag (default: production).',
      '--secrets-source <auto|env|keychain>  Wrapper flag.',
      '--keychain-service <name>         Wrapper flag (default: happier/pipeline).',
      '--keychain-account <name>         Wrapper flag.',
      '--dry-run                         Wrapper flag.',
      '--product <cli|hstack|server>     Script flag (required).',
      `--channel <${publicReleaseChannelChoices}>        Script flag (required).`,
      '--version <ver>                   Script flag (required).',
      '--assets-base-url <url>           Script flag (required).',
      '--commit-sha <sha>                Script flag (required).',
      '--workflow-run-id <id>            Script flag (optional).',
      '--skip-smoke                      Skip optional smoke tests; native CLI version attestation still runs.',
    ],
    bullets: ['Builds artifacts, generates manifests, and verifies artifacts through the shared product metadata.'],
    examples: [
      'node scripts/pipeline/run.mjs release-prepare-binary-assets --product cli --channel preview --version 1.2.3-preview.4 --assets-base-url https://github.com/happier-dev/happier/releases/download/cli-preview --commit-sha HEAD --skip-smoke',
    ],
  },

  'release-publish-manifests': {
    summary: 'Generate “latest.json” manifest(s) for a product/channel (advanced helper).',
    usage:
      `node scripts/pipeline/run.mjs release-publish-manifests --product <happier|hstack|happier-server> --channel <${publicReleaseChannelChoices}> --assets-base-url <url> [--artifacts-dir <dir>]`,
    options: [
      '--deploy-environment <env>        Wrapper flag (default: production).',
      '--secrets-source <auto|env|keychain>  Wrapper flag.',
      '--keychain-service <name>         Wrapper flag (default: happier/pipeline).',
      '--keychain-account <name>         Wrapper flag.',
      '--dry-run                         Wrapper flag.',
      '--product <name>                  Script flag (required).',
      `--channel <${publicReleaseChannelChoices}>        Script flag (required).`,
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
    summary: 'Verify checksums/signatures, attest native CLI versions, and optionally smoke-test release artifacts (advanced helper).',
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
      '--skip-smoke                      Skip optional smoke tests; native CLI version attestation still runs.',
    ],
    bullets: ['This is safety-critical; prefer running it in CI in addition to local runs.'],
    examples: [
      'node scripts/pipeline/run.mjs release-verify-artifacts --artifacts-dir dist/release-assets/cli --public-key scripts/release/installers/happier-release.pub',
    ],
  },

  'release-validate': {
    summary: 'Run centralized release validation suites against published channels or local builds.',
    usage:
      'node scripts/pipeline/run.mjs release-validate --suite <suite> [--platform <linux|darwin|win32>] ([--source <kind> --ref <value>] | [--from-source <kind> --from-ref <value> --to-source <kind> --to-ref <value>] | [--product <id> --version <ver>]) [--dry-run]',
    options: [
      '--deploy-environment <env>        Wrapper flag (default: production).',
      '--secrets-source <auto|env|keychain>  Wrapper flag.',
      '--keychain-service <name>         Wrapper flag (default: happier/pipeline).',
      '--keychain-account <name>         Wrapper flag.',
      '--dry-run                         Wrapper flag.',
      '--suite <suite>                   Script flag; installers-smoke|binary-smoke|artifact-verify|docker-release-assets|cli-update|daemon-continuity|session-continuity.',
      '--profile <integrated|stable|deep>  Profile planning only; mutually exclusive with --suite and requires --dry-run.',
      '--platform <linux|darwin|win32>   Script flag; defaults to current runtime platform.',
      '--source <kind>                   Direct source mode (published-channel|published-tag|local-build|local-pack|git-ref-build).',
      '--ref <ref>                       Direct source ref.',
      '--from-source <kind>              Update mode source kind.',
      '--from-ref <ref>                  Update mode source ref.',
      '--to-source <kind>                Update mode target kind.',
      '--to-ref <ref>                    Update mode target ref.',
      '--product <cli|hstack|server>     Script flag for artifact-verify; resolves artifacts/checksums/manifests centrally.',
      '--version <ver>                   Script flag for artifact-verify product targets.',
      '--release-channel <stable|preview|dev>  Script flag for artifact-verify product targets and installers-smoke local-build validation.',
      '--payload-publication-admission <status>  Internal installers-smoke update flag; exact payload reversion requires canonical pre-activation admission.',
      '--checksums <path>                Script flag for artifact-verify local-build overrides.',
      '--public-key <path>               Script flag for artifact-verify local-build overrides.',
      '--skip-smoke                      Skip optional artifact smoke; native CLI version attestation still runs.',
    ],
    bullets: [
      'Executable suites: installers-smoke (published-channel|published-tag|local-build with --release-channel), binary-smoke (local-build on linux), artifact-verify (local-build or --product/--version).',
      'Docker suite: docker-release-assets (local-build|published-channel; published-channel -> local-build upgrade).',
      'Continuity suites: daemon-continuity, session-continuity (local-build).',
      'cli-update (published-channel|published-tag -> published-channel|published-tag|local-build|local-pack).',
      'Profiles list canonical suite IDs only; run each automatic suite separately with its required source inputs.',
    ],
    examples: [
      'node scripts/pipeline/run.mjs release-validate --suite installers-smoke --platform linux --source published-channel --ref preview --dry-run',
      'node scripts/pipeline/run.mjs release-validate --suite installers-smoke --platform linux --source local-build --ref . --release-channel preview --dry-run',
      'node scripts/pipeline/run.mjs release-validate --suite artifact-verify --platform linux --product cli --version 1.2.3-preview.4 --release-channel preview --skip-smoke --dry-run',
      'node scripts/pipeline/run.mjs release-validate --suite cli-update --platform darwin --from-source published-tag --from-ref cli-preview --to-source local-build --to-ref HEAD --dry-run',
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

  'release-compute-versioned-component-changes': {
    summary: 'Compute per-component version bump changes using the latest immutable release tags for the target environment.',
    usage:
      'node scripts/pipeline/run.mjs release-compute-versioned-component-changes --environment <dev|preview|production> --head <ref> [--out <githubOutputPath>]',
    options: [
      '--deploy-environment <env>        Wrapper flag (default: production).',
      '--dry-run                         Wrapper flag.',
      '--secrets-source <auto|env|keychain>  Wrapper flag.',
      '--keychain-service <name>         Wrapper flag.',
      '--keychain-account <name>         Wrapper flag.',
      '--environment <dev|preview|production>  Script flag (required).',
      '--head <ref>                      Script flag (required).',
      '--out <path>                      Script flag; writes KEY=VALUE lines.',
    ],
    bullets: ['Used by release planning to decide whether versioned components need a new release since the last channel-appropriate tag.'],
    examples: ['node scripts/pipeline/run.mjs release-compute-versioned-component-changes --environment preview --head origin/dev'],
  },

  'release-resolve-bump-plan': {
    summary: 'Resolve which components should be bumped given a preset + changed inputs (advanced helper).',
    usage:
      'node scripts/pipeline/run.mjs release-resolve-bump-plan --environment <dev|preview|production> --bump-preset <none|patch|minor|major> [--github-output <path>]',
    options: [
      '--deploy-environment <env>        Wrapper flag (default: production).',
      '--dry-run                         Wrapper flag.',
      '--secrets-source <auto|env|keychain>  Wrapper flag.',
      '--keychain-service <name>         Wrapper flag.',
      '--keychain-account <name>         Wrapper flag.',
      '--environment <dev|preview|production>  Script flag (required).',
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
      '--versioned-app-changed <bool>   Optional per-component override.',
      '--versioned-cli-changed <bool>   Optional per-component override.',
      '--versioned-stack-changed <bool> Optional per-component override.',
      '--versioned-server-changed <bool> Optional per-component override.',
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
      'node scripts/pipeline/run.mjs release-compute-deploy-plan --deploy-environment preview --source-ref preview --force-deploy false --deploy-ui true --deploy-server true --deploy-website true --deploy-docs true',
    ],
  },

  'release-build-ui-web-bundle': {
    summary: 'Build the UI web bundle artifact (advanced helper).',
    usage:
      `node scripts/pipeline/run.mjs release-build-ui-web-bundle --channel <${publicReleaseChannelChoices}> [--version <ver>] [--dist-dir <dir>] [--out-dir <dir>] [--skip-build]`,
    options: [
      '--deploy-environment <env>        Wrapper flag (default: production).',
      '--dry-run                         Wrapper flag.',
      '--secrets-source <auto|env|keychain>  Wrapper flag.',
      '--keychain-service <name>         Wrapper flag.',
      '--keychain-account <name>         Wrapper flag.',
      `--channel <${publicReleaseChannelChoices}>        Script flag.`,
      '--version <ver>                   Script flag; defaults to apps/ui package.json.',
      '--dist-dir <dir>                  Script flag (default: apps/ui/dist).',
      '--out-dir <dir>                   Script flag (default: dist/release-assets/ui-web).',
      '--skip-build                      Script flag.',
    ],
    bullets: ['Most operators should use publish-ui-web, not this helper.'],
    examples: ['node scripts/pipeline/run.mjs release-build-ui-web-bundle --channel preview --skip-build'],
  },
};
