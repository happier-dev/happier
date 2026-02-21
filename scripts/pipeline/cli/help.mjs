// @ts-check

/**
 * @typedef {{
 *   enabled: boolean;
 *   bold: (s: string) => string;
 *   dim: (s: string) => string;
 *   cyan: (s: string) => string;
 *   green: (s: string) => string;
 *   yellow: (s: string) => string;
 *   red: (s: string) => string;
 * }} AnsiStyle
 */

/**
 * @param {string[]} lines
 * @param {number} spaces
 */
function indent(lines, spaces) {
  const pad = ' '.repeat(Math.max(0, spaces));
  return lines.map((l) => (l ? `${pad}${l}` : l));
}

/**
 * @param {string} s
 */
function code(s) {
  return `\`${s}\``;
}

/**
 * @type {Record<string, { summary: string; usage: string; bullets: string[]; examples: string[] }>}
 */
const COMMAND_HELP = {
  'npm-release': {
    summary: 'Pack and publish npm packages (CLI / stack / relay-server).',
    usage:
      'node scripts/pipeline/run.mjs npm-release --channel <preview|production> --publish-cli <true|false> --publish-stack <true|false> --publish-server <true|false> [--mode pack|pack+publish]',
    bullets: [
      "Preview publishes temporary versions (no commit) using a preview suffix (X.Y.Z-preview.<run>.<attempt>).",
      'Local auth: uses NPM_TOKEN if set, otherwise falls back to your local npm login state.',
      'GitHub Actions: defaults to npm provenance/trusted publishing where supported.',
    ],
    examples: [
      'node scripts/pipeline/run.mjs npm-release --channel preview --publish-cli true --publish-stack true --mode pack+publish',
      'node scripts/pipeline/run.mjs npm-release --channel preview --publish-server true --mode pack+publish',
      'node scripts/pipeline/run.mjs npm-release --channel production --publish-cli true --publish-stack true --publish-server true --mode pack+publish',
    ],
  },
  'npm-publish': {
    summary: 'Publish a pre-built .tgz tarball to npm (lower-level helper).',
    usage:
      'node scripts/pipeline/run.mjs npm-publish --channel <preview|production> (--tarball <path>|--tarball-dir <dir>) [--tag <distTag>]',
    bullets: ['Usually used by npm-release; use directly only when you already have a tarball.'],
    examples: [
      'node scripts/pipeline/run.mjs npm-publish --channel preview --tarball dist/release-assets/cli/happier-cli.tgz --dry-run',
    ],
  },
  'npm-set-preview-versions': {
    summary: 'Compute (and optionally write) preview versions into package.json files.',
    usage:
      'node scripts/pipeline/run.mjs npm-set-preview-versions --publish-cli <true|false> --publish-stack <true|false> --publish-server <true|false> [--write true|false]',
    bullets: ['Mainly used internally by the release orchestrator; most operators should use npm-release.'],
    examples: [
      'node scripts/pipeline/run.mjs npm-set-preview-versions --publish-cli true --publish-stack true --write false',
    ],
  },
  'checks-plan': {
    summary: 'Print the resolved CI check plan for a given profile.',
    usage: 'node scripts/pipeline/run.mjs checks-plan --profile <none|fast|full|custom> [--custom-checks <csv>]',
    bullets: [
      'Useful to see exactly what `checks` would run before you execute it.',
      'Profiles mirror GitHub Actions lanes (fast/full/etc).',
    ],
    examples: [
      'node scripts/pipeline/run.mjs checks-plan --profile fast',
      'node scripts/pipeline/run.mjs checks-plan --profile custom --custom-checks e2e_core,build_docs',
    ],
  },
  checks: {
    summary: 'Run the local CI check suite (parity with GitHub Actions).',
    usage:
      'node scripts/pipeline/run.mjs checks --profile <none|fast|full|custom> [--custom-checks <csv>] [--install-deps <auto|true|false>] [--dry-run]',
    bullets: [
      'Use this when iterating on CI locally instead of waiting for GitHub runners.',
      'Set HAPPIER_UI_VENDOR_WEB_ASSETS=1 when you need UI web assets vendored into the UI build.',
    ],
    examples: [
      'node scripts/pipeline/run.mjs checks --profile fast',
      'node scripts/pipeline/run.mjs checks --profile custom --custom-checks e2e_core_slow,server_db_contract',
    ],
  },
  'publish-cli-binaries': {
    summary: 'Build + publish CLI binaries to GitHub Releases (rolling + version tags).',
    usage:
      'node scripts/pipeline/run.mjs publish-cli-binaries --channel <preview|stable> [--release-message <text>] [--dry-run]',
    bullets: [
      'Requires MINISIGN_SECRET_KEY (+ MINISIGN_PASSPHRASE if encrypted).',
      'Publishes a rolling tag (cli-preview/cli-stable) and a versioned tag (cli-vX.Y.Z...).',
      'Set --allow-stable true to publish stable (safety rail).',
    ],
    examples: [
      'node scripts/pipeline/run.mjs publish-cli-binaries --channel preview --release-message "CLI preview"',
      'node scripts/pipeline/run.mjs publish-cli-binaries --channel preview --dry-run',
    ],
  },
  'publish-hstack-binaries': {
    summary: 'Build + publish hstack binaries to GitHub Releases (rolling + version tags).',
    usage:
      'node scripts/pipeline/run.mjs publish-hstack-binaries --channel <preview|stable> [--release-message <text>] [--dry-run]',
    bullets: [
      'Requires MINISIGN_SECRET_KEY (+ MINISIGN_PASSPHRASE if encrypted).',
      'Set --allow-stable true to publish stable (safety rail).',
    ],
    examples: [
      'node scripts/pipeline/run.mjs publish-hstack-binaries --channel preview --release-message "Stack preview"',
    ],
  },
  'publish-server-runtime': {
    summary: 'Build + publish relay-server (server runner) runtime binaries to GitHub Releases.',
    usage:
      'node scripts/pipeline/run.mjs publish-server-runtime --channel <preview|stable> [--release-message <text>] [--dry-run]',
    bullets: [
      'Requires MINISIGN_SECRET_KEY (+ MINISIGN_PASSPHRASE if encrypted).',
      'Set --allow-stable true to publish stable (safety rail).',
    ],
    examples: [
      'node scripts/pipeline/run.mjs publish-server-runtime --channel preview --release-message "Relay server preview"',
    ],
  },
  release: {
    summary: 'Orchestrate a full preview/production release (recommended entrypoint).',
    usage: 'node scripts/pipeline/run.mjs release --channel <preview|stable> [--dry-run]',
    bullets: [
      'Computes a release plan (changed components) then executes publish steps.',
      'Refuses to publish from a dirty worktree by default (use --allow-dirty true when intentional).',
    ],
    examples: [
      'node scripts/pipeline/run.mjs release --channel preview --dry-run',
      'node scripts/pipeline/run.mjs release --channel preview',
    ],
  },
  'deploy': {
    summary: 'Trigger deploy webhook(s) for a hosted surface (server/ui/website/docs).',
    usage: 'node scripts/pipeline/run.mjs deploy --deploy-environment <preview|production> --component <ui|server|website|docs> --repository <owner/repo> [--dry-run]',
    bullets: [
      'Deploy branches are `deploy/<env>/<component>`.',
      'Use after promoting a deploy branch, or with --ref-name to deploy a specific ref.',
    ],
    examples: [
      'node scripts/pipeline/run.mjs deploy --deploy-environment production --component website --repository happier-dev/happier',
    ],
  },
  'promote-branch': {
    summary: 'Promote one branch to another (fast-forward or reset) via GitHub API.',
    usage:
      'node scripts/pipeline/run.mjs promote-branch --source <branch> --target <branch> --mode <fast_forward|reset> --confirm <string> [--dry-run]',
    bullets: ['Requires GitHub CLI auth (`gh auth status`).', 'Reset is destructive; requires explicit confirmation flags.'],
    examples: ['node scripts/pipeline/run.mjs promote-branch --source dev --target main --mode fast_forward --confirm "promote main from dev" --dry-run'],
  },
  'promote-deploy-branch': {
    summary: 'Update a remote deploy branch to a source ref or SHA via GitHub API.',
    usage: 'node scripts/pipeline/run.mjs promote-deploy-branch --deploy-environment <preview|production> --component <ui|server|website|docs> (--source-ref <dev|main>|--sha <sha>)',
    bullets: ['Requires GitHub CLI auth (`gh auth status`).', 'Does not push your local git state; uses remote refs/SHA.'],
    examples: [
      'node scripts/pipeline/run.mjs promote-deploy-branch --deploy-environment production --component website --source-ref dev',
    ],
  },
  'publish-ui-web': {
    summary: 'Build + publish the UI web bundle as GitHub release assets.',
    usage: 'node scripts/pipeline/run.mjs publish-ui-web --channel <preview|stable> [--release-message <text>] [--dry-run]',
    bullets: [
      'Publishes a rolling tag and a versioned tag for the UI web bundle assets.',
      'Set --allow-stable true to publish stable (safety rail).',
    ],
    examples: [
      'node scripts/pipeline/run.mjs publish-ui-web --channel preview --release-message "UI web preview"',
    ],
  },
  'docker-publish': {
    summary: 'Build and publish multi-arch Docker images (Docker Hub + optional GHCR).',
    usage: 'node scripts/pipeline/run.mjs docker-publish --channel <preview|stable> [--sha <sha>] [--dry-run]',
    bullets: ['Uses buildx; can publish to multiple registries via --registries.'],
    examples: ['node scripts/pipeline/run.mjs docker-publish --channel preview --dry-run'],
  },
  'ui-mobile-release': {
    summary: 'Expo mobile release entrypoint (OTA, native build, submit).',
    usage: 'node scripts/pipeline/run.mjs ui-mobile-release --environment <preview|production> --action <ota|native|native_submit> --platform <ios|android|all> [--profile <easProfile>]',
    bullets: [
      'For native actions, --profile is required and must match the environment prefix (production* / preview*).',
      'Local iOS builds must run on host macOS; Android local builds can run in Dagger for reproducibility.',
    ],
    examples: [
      'node scripts/pipeline/run.mjs ui-mobile-release --environment preview --action ota --platform all',
      'node scripts/pipeline/run.mjs ui-mobile-release --environment production --action native --platform ios --profile production --native-build-mode local --native-local-runtime host',
    ],
  },
  'expo-submit': {
    summary: 'Submit a native build to TestFlight / Play Store (EAS Submit).',
    usage: 'node scripts/pipeline/run.mjs expo-submit --environment <preview|production> --platform <ios|android|all> [--profile <submitProfile>] [--path <artifactPath>]',
    bullets: [
      'Use `--path` to submit a locally-built artifact (IPA/AAB/APK).',
      'When submitting iOS with --path, the pipeline validates the archive bundle id matches --environment.',
      'Non-interactive iOS submit requires APPLE_API_PRIVATE_KEY (ASC API key).',
    ],
    examples: [
      'node scripts/pipeline/run.mjs expo-submit --environment production --platform ios --profile production --path dist/ui-mobile/happier-production-ios-v0.1.0.ipa',
      'node scripts/pipeline/run.mjs expo-submit --environment preview --platform android --profile preview --path dist/ui-mobile/happier-preview-android.aab',
    ],
  },
};

/**
 * @param {{ style: AnsiStyle; cliRelPath?: string }} opts
 */
export function renderPipelineHelp(opts) {
  const style = opts.style;
  const cli = opts.cliRelPath || 'scripts/pipeline/run.mjs';

  const lines = [
    style.cyan(style.bold('Happier Pipeline')),
    '',
    style.bold('Usage:'),
    `  node ${cli} ${style.bold('<command>')} [args...]`,
    '',
    style.bold('Global flags:'),
    ...indent(
      [
        `${style.bold('--help')} / ${style.bold('-h')}   Show help`,
        `${style.bold('--no-color')}    Disable ANSI colors (also respects NO_COLOR=1)`,
        `${style.bold('--color')}       Force ANSI colors`,
      ],
      2,
    ),
    '',
    style.bold('Secrets:'),
    ...indent(
      [
        `Many commands accept ${style.bold('--secrets-source')} ${style.bold('<auto|env|keychain>')}.`,
        `Keychain mode uses ${style.bold('--keychain-service')} / ${style.bold('--keychain-account')} (default service: happier/pipeline).`,
      ],
      2,
    ),
    '',
    style.bold('Help:'),
    `  node ${cli} --help`,
    `  node ${cli} help`,
    `  node ${cli} help ${style.bold('<command>')}`,
    `  node ${cli} ${style.bold('<command>')} --help`,
    '',
    style.bold('Common commands:'),
    ...indent(
      [
        `${style.bold('release')}                ${COMMAND_HELP.release.summary}`,
        `${style.bold('npm-release')}            ${COMMAND_HELP['npm-release'].summary}`,
        `${style.bold('deploy')}                 ${COMMAND_HELP.deploy.summary}`,
        `${style.bold('promote-deploy-branch')}  ${COMMAND_HELP['promote-deploy-branch'].summary}`,
        `${style.bold('checks')}                 ${COMMAND_HELP.checks.summary}`,
        `${style.bold('docker-publish')}         ${COMMAND_HELP['docker-publish'].summary}`,
        `${style.bold('ui-mobile-release')}      ${COMMAND_HELP['ui-mobile-release'].summary}`,
        `${style.bold('expo-submit')}            ${COMMAND_HELP['expo-submit'].summary}`,
        '',
        style.dim(`Tip: prefer ${code(`node ${cli} <command> --dry-run`)} first.`),
      ],
      2,
    ),
  ];

  return `${lines.join('\n')}\n`;
}

/**
 * @param {{ style: AnsiStyle; command: string; cliRelPath?: string }} opts
 */
export function renderCommandHelp(opts) {
  const style = opts.style;
  const cli = opts.cliRelPath || 'scripts/pipeline/run.mjs';
  const command = String(opts.command ?? '').trim();
  const spec = COMMAND_HELP[command] ?? null;

  if (!command) {
    return renderPipelineHelp({ style, cliRelPath: cli });
  }

  if (!spec) {
    const lines = [
      style.red(style.bold(`Unknown command: ${command}`)),
      '',
      'Run:',
      `  node ${cli} --help`,
    ];
    return `${lines.join('\n')}\n`;
  }

  const lines = [
    style.cyan(style.bold(`Happier Pipeline — ${command}`)),
    '',
    spec.summary,
    '',
    style.bold('Usage:'),
    `  ${spec.usage.replace(/^node scripts\/pipeline\/run\.mjs/, `node ${cli}`)}`,
    '',
    ...(spec.bullets.length > 0
      ? [style.bold('Notes:'), ...indent(spec.bullets.map((b) => `- ${b}`), 2), '']
      : []),
    ...(spec.examples.length > 0
      ? [style.bold('Examples:'), ...indent(spec.examples.map((e) => e), 2), '']
      : []),
    style.dim(`More: node ${cli} --help`),
  ];

  return `${lines.join('\n')}\n`;
}
