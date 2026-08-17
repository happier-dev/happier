// @ts-check

import { releaseTargets } from '../../release/component-registry.mjs';
import { RELEASE_VALIDATION_PROFILE_IDS } from '../../release-validation/registry.mjs';

const releaseTargetChoices = releaseTargets.join(',');
const releaseProfileChoices = RELEASE_VALIDATION_PROFILE_IDS.join('|');

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
    examples: [
      'node scripts/pipeline/run.mjs release-analyze --base cli-v1.2.3 --head HEAD --profile integrated --has-cli-candidate true --has-server-candidate false --has-published-relay-predecessor false',
    ],
  },
  'release-local-candidates': {
    summary: 'Execute immutable publication, verification, and rolling promotion locally through the canonical release scripts.',
    usage: 'node scripts/pipeline/run.mjs release-local-candidates --channel <dev|preview|stable> --source-sha <sha> --repository <owner/repo> --candidates <product=version,...> [--phase <publish-immutable|verify|promote-rolling|all>] [--dry-run]',
    options: [
      '--channel <channel>              Public release channel.',
      '--source-sha <sha>               Exact candidate source SHA.',
      '--repository <owner/repo>        GitHub repository holding immutable releases.',
      '--candidates <csv>               cli|stack|server|ui-web entries in product=version form.',
      '--phase <phase>                  publish-immutable|verify|promote-rolling|all (default: all).',
      '--release-message <text>         Optional release annotation.',
      '--confirm <text>                 Required non-dry text: execute local release candidates.',
      '--dry-run                        Print the exact sequential phase commands without external writes.',
      '--json                           Emit the phase plan as JSON.',
    ],
    bullets: [
      'Uses the same script-owned immutable publishers, candidate verifier, and rolling promoter as GitHub workflows.',
      'Each phase can be rerun independently; a failed platform build does not require replaying an already verified immutable candidate.',
      'Native/platform-specific artifact preparation must run on a host that supports the selected product requirements.',
    ],
    examples: [
      'node scripts/pipeline/run.mjs release-local-candidates --channel preview --source-sha <sha> --repository happier-dev/happier --candidates cli=1.2.3-preview.4,server=1.2.3-preview.5 --dry-run',
    ],
  },
  release: {
    summary: 'Orchestrate a full dev/preview/production release (recommended entrypoint).',
    usage:
      `node scripts/pipeline/run.mjs release --confirm <action> --repository <owner/repo> [--deploy-environment dev|preview|production] [--deploy-targets <csv>] [--release-profile <${releaseProfileChoices}>] [--source-sha <sha>] [--workflow-control-sha <sha>] [--operation-id <id>] [--attempt-id <attempt_n>] [--release-notes-id <id>] [--resume-run-id <run-id>] [--qualified-v4-activation-approval <bool>] [--dry-run] [--json]`,
    options: [
      '--confirm <action>                Required safety confirmation.',
      '--repository <owner/repo>         Required; e.g. happier-dev/happier.',
      "--deploy-environment <env>        dev|preview|production (default: preview).",
      `--deploy-targets <csv>            ${releaseTargetChoices} (default: ui,server,website,docs).`,
      '--release-profile <integrated|stable|deep>  Defaults to integrated for dev/preview and stable for production; deep is dry-run only.',
      '--force-deploy <bool>             true|false (default: false).',
      '--bump <preset>                   Must be none for final exact-SHA promotion; patch|minor|major are rejected.',
      '--ui-expo-action <mode>           none|ota|native|native_submit (default: none).',
      '--desktop-mode <mode>             none|build_only|build_and_publish (default: none).',
      '--source-sha <sha>                Exact approved source branch SHA; required for non-dry hosted dispatch.',
      '--workflow-control-sha <sha>       Exact dispatcher-observed dev SHA used to fence hosted workflow control.',
      '--operation-id <id>               Conductor correlation identity; required for conductor dry-run JSON and forwarded to hosted runs.',
      '--attempt-id <attempt_n>           Hosted execution-attempt identity for exact resume correlation (default: attempt_1).',
      '--release-notes-id <id>           Approved canonical release-note entry selected for normal preview/production releases.',
      '--resume-run-id <run-id>          Optional completed release run whose individually verified immutable candidates should be reused.',
      '--qualified-v4-activation-approval <bool>  Separate irreversible-migration approval; false unless the exact stable packet explicitly requires and authorizes Qualified V4 activation.',
      '--release-message <text>          Optional; included in GitHub releases.',
      '--allow-dirty <bool>              true|false (default: false).',
      '--dry-run                          Print release facts and hosted inputs without mutating.',
      '--json                             With --dry-run, emit only the exact promotion-source identity JSON.',
    ],
    bullets: [
      'Dry-run computes non-mutating release facts and prints hosted dispatch inputs without predicting hosted jobs.',
      'Materialize and commit CHANGELOG and version changes before resolving the exact source SHA; final hosted dispatch must use --bump none.',
      'Dry-run remains available only with --bump none, so its source SHA describes the final candidate rather than a planned mutation.',
      'Non-dry preview/production releases dispatch release.yml; privileged release writes remain hosted.',
      'The resolved profile is forwarded to the hosted workflow as validation_profile.',
      'Use --dry-run --json to obtain sourceBranch and authorizedPromotionSourceSha for an exact later dispatch.',
      'Reuse the same conductor operation identity from preparation through hosted dispatch and status correlation.',
      'Preview and production select one approved canonical release-note entry by --release-notes-id; automatic nightlies use generic metadata.',
      'Resume retains the current authorized source and operation identity and reuses only candidates admitted from the exact completed origin run.',
      'Qualified V4 activation is never authorized by the ordinary branch-promotion confirmation; it requires the separate explicit approval flag.',
      'Refuses to publish from a dirty worktree by default (use --allow-dirty true when intentional).',
      'Use --dry-run with --bump none first; then dispatch the same exact candidate with --bump none.',
    ],
    examples: [
      'node scripts/pipeline/run.mjs release --confirm "release dev to dev" --repository happier-dev/happier --deploy-environment dev --bump none --dry-run',
      'node scripts/pipeline/run.mjs release --confirm "release dev to preview" --repository happier-dev/happier --deploy-environment preview --operation-id <operation-id> --release-notes-id <release-id> --bump none --dry-run --json',
      'node scripts/pipeline/run.mjs release --confirm "release dev to preview" --repository happier-dev/happier --deploy-environment preview --operation-id <operation-id> --release-notes-id <release-id> --source-sha <approved-candidate-sha> --bump none',
      'node scripts/pipeline/run.mjs release --confirm "release dev to preview" --repository happier-dev/happier --deploy-environment preview --operation-id <operation-id> --release-notes-id <release-id> --source-sha <approved-candidate-sha> --resume-run-id <completed-run-id> --bump none',
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
      'node scripts/pipeline/run.mjs promote-branch --source <branch> --source-sha <sha> --target <branch> --mode <fast_forward|reset> --confirm <string> [--allow-reset true|false] [--summary-file <path>] [--dry-run]',
    options: [
      '--source <branch>                 Required; e.g. dev.',
      '--source-sha <sha>                Exact approved source SHA; required unless --dry-run.',
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
