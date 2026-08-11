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
  'release-analyze': {
    summary: 'Classify changed release seams before notes/version materialization.',
    usage: 'node scripts/pipeline/run.mjs release-analyze --base <ref> --head <ref> --profile <integrated|stable> --has-cli-candidate <bool> --has-server-candidate <bool> --has-published-relay-predecessor <bool>',
    bullets: [
      'Returns deterministic risk triggers and required fast/heavy evidence; the release agent owns the semantic compatibility verdict.',
      'Run while inspecting the release diff, before committing release notes or versions.',
    ],
    examples: ['node scripts/pipeline/run.mjs release-analyze --base cli-v1.2.3 --head HEAD --profile integrated --has-cli-candidate true --has-server-candidate false --has-published-relay-predecessor false'],
  },
  'release-local-candidates': {
    summary: 'Execute immutable publication, verification, and rolling promotion locally through the canonical release scripts.',
    usage: 'node scripts/pipeline/run.mjs release-local-candidates --channel <dev|preview|stable> --source-sha <sha> --repository <owner/repo> --candidates <product=version,...> [--phase <publish-immutable|verify|promote-rolling|all>] [--dry-run]',
    bullets: [
      'Uses the same script-owned immutable publishers, candidate verifier, and rolling promoter as GitHub workflows.',
      'Each phase can be rerun independently without rebuilding a verified immutable candidate.',
    ],
    examples: ['node scripts/pipeline/run.mjs release-local-candidates --channel preview --source-sha <sha> --repository happier-dev/happier --candidates cli=1.2.3-preview.4,server=1.2.3-preview.5 --dry-run'],
  },
  release: {
    summary: 'Orchestrate a full dev/preview/production release (recommended entrypoint).',
    usage:
      'node scripts/pipeline/run.mjs release --confirm <action> --repository <owner/repo> [--deploy-environment dev|preview|production] [--deploy-targets <csv>] [--source-sha <sha>] [--workflow-control-sha <sha>] [--resume-run-id <run-id>] [--operation-id <id>] [--attempt-id <attempt_n>] [--release-notes-id <id>] [--qualified-v4-activation-approval <bool>] [--dry-run] [--json]',
    options: [
      '--confirm <action>                Required safety confirmation.',
      '--repository <owner/repo>         Required; e.g. happier-dev/happier.',
      "--deploy-environment <env>        dev|preview|production (default: preview).",
      '--deploy-targets <csv>            ui,server,website,docs,cli,stack,server_runner (default: ui,server,website,docs).',
      '--force-deploy <bool>             true|false (default: false).',
      '--bump <preset>                   Final releases require none; materialize version/changelog updates before dispatch.',
      '--ui-expo-action <mode>           none|ota|native|native_submit (default: none).',
      '--desktop-mode <mode>             none|build_only|build_and_publish (default: none).',
      '--release-profile <profile>       integrated|stable|deep (default: integrated for dev/preview, stable for production; deep is manual-only).',
      '--source-sha <sha>                Required for non-dry hosted dispatch; exact source commit to promote.',
      '--workflow-control-sha <sha>      Optional dispatcher-observed dev SHA for hosted workflow-control fencing.',
      '--resume-run-id <run-id>          Optional completed release run whose individually verified immutable candidates should be reused.',
      '--operation-id <id>               Optional conductor correlation ID; required for --dry-run --json.',
      '--attempt-id <attempt_n>           Hosted execution-attempt identity for exact resume correlation (default: attempt_1).',
      '--release-notes-id <id>           Required approved release-note entry for preview/production dispatches.',
      '--qualified-v4-activation-approval <bool>  Separate explicit approval for irreversible Qualified V4 activation (default: false).',
      '--allow-dirty <bool>              true|false (default: false).',
      '--dry-run                          Print release facts and hosted inputs without mutating.',
      '--json                            With --dry-run, emit the exact promotion-source dispatch plan as JSON.',
    ],
    bullets: [
      'Dry-run computes non-mutating release facts and prints hosted dispatch inputs without predicting hosted jobs.',
      'Non-dry preview/production releases dispatch release.yml; privileged release writes remain hosted.',
      'Final release dispatches require an exact source SHA and never create a post-admission version-bump commit.',
      'When supplied by hmaint, workflow-control SHA must equal the hosted workflow SHA before actor authorization or mutation.',
      'Resume retains the current authorized source and operation while reusing only candidates admitted from the exact completed origin run.',
      'The local dispatcher resolves integrated/stable through the public release contract; deep is never a normal release dispatch.',
      'Preview and production use one approved canonical release-note entry; automatic nightlies use generic unattended copy.',
      'Refuses to publish from a dirty worktree by default (use --allow-dirty true when intentional).',
      'Use --dry-run first; once green, re-run without --dry-run to dispatch.',
    ],
    examples: [
      'node scripts/pipeline/run.mjs release --confirm "release dev to dev" --repository happier-dev/happier --deploy-environment dev --dry-run',
      'node scripts/pipeline/run.mjs release --confirm "release dev to preview" --repository happier-dev/happier --deploy-environment preview --operation-id <operation-id> --release-notes-id <release-id> --dry-run --json',
      'node scripts/pipeline/run.mjs release --confirm "release dev to preview" --repository happier-dev/happier --deploy-environment preview --release-notes-id <release-id> --source-sha <40-character-sha>',
      'node scripts/pipeline/run.mjs release --confirm "release dev to preview" --repository happier-dev/happier --deploy-environment preview --release-notes-id <release-id> --source-sha <40-character-sha> --resume-run-id <completed-run-id>',
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
      'node scripts/pipeline/run.mjs promote-branch --source <branch> --target <branch> --mode <fast_forward|reset> --confirm <string> [--source-sha <sha>] [--allow-reset true|false] [--summary-file <path>] [--dry-run]',
    options: [
      '--source <branch>                 Required; e.g. dev.',
      '--source-sha <sha>                Required unless --dry-run; exact source commit to mutate from.',
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
      'node scripts/pipeline/run.mjs promote-deploy-branch --deploy-environment production --component website --source-ref main',
    ],
  },
};
