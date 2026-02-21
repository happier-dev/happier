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
export const COMMAND_HELP_GITHUB = {
  'github-publish-release': {
    summary: 'Create/update a GitHub Release and upload assets (supports rolling tags).',
    usage:
      'node scripts/pipeline/run.mjs github-publish-release --tag <tag> --title <title> --target-sha <sha> [--assets <csv>] [--assets-dir <dir>] [--dry-run]',
    options: [
      '--tag <tag>                       Required.',
      '--title <title>                   Required.',
      '--target-sha <sha>                Required.',
      '--prerelease <bool>               true|false (required by caller).',
      '--rolling-tag <tag>               Optional; update a moving tag too.',
      '--generate-notes <bool>           true|false.',
      '--notes <text>                    Optional release notes body.',
      '--assets <csv>                    Optional list of filenames.',
      '--assets-dir <dir>                Optional; uploads all matching assets from dir.',
      '--clobber <bool>                  true|false (default: true).',
      '--prune-assets <bool>             true|false (default: false).',
      '--release-message <text>          Optional; appended to notes.',
      '--max-commits <n>                 (default: 200).',
      '--allow-dirty <bool>              true|false (default: false).',
      '--dry-run',
      '--secrets-source <auto|env|keychain>',
      '--keychain-service <name>          (default: happier/pipeline).',
      '--keychain-account <name>',
    ],
    bullets: ['Requires GitHub CLI auth (`gh auth status`).'],
    examples: [
      'node scripts/pipeline/run.mjs github-publish-release --tag cli-preview --title "CLI Preview" --target-sha $(git rev-parse HEAD) --prerelease true --dry-run',
    ],
  },

  'github-audit-release-assets': {
    summary: 'Audit that a release has the expected assets (contract check).',
    usage:
      'node scripts/pipeline/run.mjs github-audit-release-assets --tag <tag> --kind <kind> [--version <ver>] [--targets <csv>] [--repo <owner/repo>]',
    options: [
      '--tag <tag>                       Required.',
      '--kind <kind>                     Required; validation profile (internal).',
      '--version <ver>                   Optional; expected version.',
      '--targets <csv>                   Optional; expected platform targets.',
      '--repo <owner/repo>               Optional.',
      '--assets-json <path>              Optional; pre-fetched assets JSON.',
      '--dry-run',
    ],
    bullets: ['Used by CI to ensure releases are complete and installers can find assets.'],
    examples: ['node scripts/pipeline/run.mjs github-audit-release-assets --tag cli-preview --kind cli'],
  },

  'github-commit-and-push': {
    summary: 'Commit selected paths and push to a remote ref (workflow helper).',
    usage:
      'node scripts/pipeline/run.mjs github-commit-and-push --paths <csv> --message <msg> --push-ref <ref> [--dry-run]',
    options: [
      '--paths <csv>                     Comma-separated paths to `git add`.',
      '--allow-missing <bool>            true|false (default: false).',
      '--message <msg>                   Commit message.',
      '--author-name <name>              Optional override.',
      '--author-email <email>            Optional override.',
      '--remote <name>                   Optional.',
      '--push-ref <ref>                  Optional; e.g. HEAD:dev.',
      '--push-mode <mode>                Optional; internal.',
      '--allow-dirty <bool>              true|false (default: false).',
      '--dry-run',
    ],
    bullets: ['Prefer normal git workflows for day-to-day work; use this when you need CI parity.'],
    examples: [
      'node scripts/pipeline/run.mjs github-commit-and-push --paths apps/ui/package.json --message "chore: bump ui" --push-ref HEAD:dev --dry-run',
    ],
  },
};

