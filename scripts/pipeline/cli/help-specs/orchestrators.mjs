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
export const COMMAND_HELP_ORCHESTRATORS = {
  release: {
    summary: 'Orchestrate a full preview/production release (recommended entrypoint).',
    usage:
      'node scripts/pipeline/run.mjs release --confirm <action> --repository <owner/repo> [--deploy-environment preview|production] [--deploy-targets <csv>] [--dry-run]',
    options: [
      '--confirm <action>                Required safety confirmation.',
      '--repository <owner/repo>         Required; e.g. happier-dev/happier.',
      "--deploy-environment <env>        preview|production (default: preview).",
      '--deploy-targets <csv>            ui,server,website,docs,cli,stack,server_runner (default: ui,server,website,docs).',
      '--force-deploy <bool>             true|false (default: false).',
      '--bump <preset>                   none|patch|minor|major (default: none).',
      '--bump-app-override <preset>      none|patch|minor|major|preset (default: preset).',
      '--bump-cli-override <preset>      none|patch|minor|major|preset (default: preset).',
      '--bump-stack-override <preset>    none|patch|minor|major|preset (default: preset).',
      '--ui-expo-action <mode>           none|ota|native|native_submit (default: none).',
      '--ui-expo-builder <builder>       eas_cloud|eas_local (default: eas_cloud).',
      '--ui-expo-profile <profile>       auto|preview|preview-apk|production|production-apk (default: auto).',
      '--ui-expo-platform <p>            ios|android|all (default: all).',
      '--desktop-mode <mode>             none|build_only|build_and_publish (default: none).',
      '--release-message <text>          Optional; included in GitHub releases.',
      '--npm-mode <mode>                 pack|pack+publish (default: pack+publish).',
      '--npm-run-tests <mode>            auto|true|false (default: auto).',
      '--npm-server-runner-dir <dir>     (default: packages/relay-server).',
      '--sync-dev-from-main <bool>       true|false (default: true).',
      '--allow-dirty <bool>              true|false (default: false).',
      '--dry-run                          Print intended actions without mutating.',
      '--secrets-source <auto|env|keychain>',
      '--keychain-service <name>         (default: happier/pipeline).',
      '--keychain-account <name>',
    ],
    bullets: [
      'Computes a release plan (changed components) then executes publish steps.',
      'Refuses to publish from a dirty worktree by default (use --allow-dirty true when intentional).',
      'Use --dry-run first; once green, re-run without --dry-run to execute.',
    ],
    examples: [
      'node scripts/pipeline/run.mjs release --confirm "release preview from dev" --repository happier-dev/happier --deploy-environment preview --dry-run',
      'node scripts/pipeline/run.mjs release --confirm "release preview from dev" --repository happier-dev/happier --deploy-environment preview',
    ],
  },

  deploy: {
    summary: 'Trigger deploy webhook(s) for a hosted surface (server/ui/website/docs).',
    usage:
      'node scripts/pipeline/run.mjs deploy --deploy-environment <preview|production> --component <ui|server|website|docs> [--repository <owner/repo>] [--ref-name <ref>] [--sha <sha>] [--dry-run]',
    options: [
      '--deploy-environment <env>        preview|production (default: production).',
      '--component <name>                ui|server|website|docs (required).',
      '--repository <owner/repo>         Optional; falls back to GITHUB_REPOSITORY env.',
      '--ref-name <ref>                  Ref to deploy (default: deploy/<env>/<component>).',
      '--sha <sha>                       Optional; passed through for auditing.',
      '--dry-run',
      '--secrets-source <auto|env|keychain>',
      '--keychain-service <name>         (default: happier/pipeline).',
      '--keychain-account <name>',
    ],
    bullets: ['Deploy branches are `deploy/<env>/<component>`.'],
    examples: [
      'node scripts/pipeline/run.mjs deploy --deploy-environment production --component website --repository happier-dev/happier',
    ],
  },

  'promote-branch': {
    summary: 'Promote one branch to another (fast-forward or reset) via GitHub API.',
    usage:
      'node scripts/pipeline/run.mjs promote-branch --source <branch> --target <branch> --mode <fast_forward|reset> --confirm <string> [--allow-reset true|false] [--summary-file <path>] [--dry-run]',
    options: [
      '--source <branch>                 Required; e.g. dev.',
      '--target <branch>                 Required; e.g. main.',
      '--mode <fast_forward|reset>       Required.',
      '--confirm <text>                  Required safety text (free-form).',
      '--allow-reset <bool>              Required for --mode reset (default: false).',
      '--summary-file <path>             Optional; append markdown summary (Actions: $GITHUB_STEP_SUMMARY).',
      '--allow-dirty <bool>              true|false (default: false).',
      '--dry-run',
      '--secrets-source <auto|env|keychain>',
      '--keychain-service <name>         (default: happier/pipeline).',
      '--keychain-account <name>',
    ],
    bullets: ['Requires GitHub CLI auth (`gh auth status`).'],
    examples: [
      'node scripts/pipeline/run.mjs promote-branch --source dev --target main --mode fast_forward --confirm "promote main from dev" --dry-run',
    ],
  },

  'promote-deploy-branch': {
    summary: 'Update a remote deploy branch to a source ref or SHA via GitHub API.',
    usage:
      'node scripts/pipeline/run.mjs promote-deploy-branch --deploy-environment <preview|production> --component <ui|server|website|docs> [--source-ref <ref>] [--sha <sha>] [--summary-file <path>] [--dry-run]',
    options: [
      '--deploy-environment <env>        preview|production (required).',
      '--component <name>                ui|server|website|docs (required).',
      '--source-ref <ref>                Optional; e.g. dev or main.',
      '--sha <sha>                       Optional; exact commit SHA (alternative to --source-ref).',
      '--summary-file <path>             Optional GitHub Step Summary output path.',
      '--allow-dirty <bool>              true|false (default: false).',
      '--dry-run',
      '--secrets-source <auto|env|keychain>',
      '--keychain-service <name>         (default: happier/pipeline).',
      '--keychain-account <name>',
    ],
    bullets: ['Requires GitHub CLI auth (`gh auth status`).'],
    examples: [
      'node scripts/pipeline/run.mjs promote-deploy-branch --deploy-environment production --component website --source-ref dev',
    ],
  },
};
