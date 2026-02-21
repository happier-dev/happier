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

