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
export const COMMAND_HELP_MISC = {
  'secrets-import': {
    summary: 'Import `.env.pipeline*` values into the Keychain bundle secret (macOS only).',
    usage:
      'node scripts/pipeline/run.mjs secrets-import [--env <preview|production>] [--env-files <csv>] [--only-missing true|false] [--dry-run]',
    options: [
      '--env <env>                       Optional; preview|production. When set, imports env-specific bundle for that env.',
      '--env-files <csv>                 Optional. When omitted, uses `.env.pipeline.local` plus env overlays (preview+production by default, or just --env).',
      '--keychain-service <name>         (default: happier/pipeline).',
      '--keychain-account <name>         Optional; prefix namespace (stored as `<prefix>/base` and `<prefix>/<env>`).',
      '--only-missing <bool>             true|false (default: false).',
      '--ignore-missing <bool>           true|false (default: true).',
      '--cleanup-env-files <mode>        auto|prompt|true|false (default: auto; prompts only in interactive TTY).',
      '--verbose <bool>                  true|false (default: false; prints key *names* only).',
      '--dry-run',
    ],
    bullets: [
      'Merges/upserts keys into the existing Keychain JSON bundle; it does not delete keys missing from input.',
      'Never prints secret values (only counts and optional key names).',
    ],
    examples: [
      'node scripts/pipeline/run.mjs secrets-import --dry-run',
      'node scripts/pipeline/run.mjs secrets-import --env production --dry-run',
      'node scripts/pipeline/run.mjs secrets-import --env production --env-files .env.pipeline.local,.env.pipeline.production.local --verbose true',
    ],
  },
  'testing-create-auth-credentials': {
    summary: 'Create local auth credential files for testing (helper).',
    usage:
      'node scripts/pipeline/run.mjs testing-create-auth-credentials [--server-url <url>] [--home-dir <dir>] [--active-server-id <id>] [--secret-base64 <b64>]',
    options: [
      '--server-url <url>                Optional.',
      '--home-dir <dir>                  Optional.',
      '--active-server-id <id>           Optional.',
      '--secret-base64 <b64>             Optional.',
      '--dry-run',
    ],
    bullets: ['Used by e2e suites; avoid checking generated secrets into git.'],
    examples: [
      'node scripts/pipeline/run.mjs testing-create-auth-credentials --server-url http://localhost:3000 --home-dir /tmp/happier-home',
    ],
  },
};
