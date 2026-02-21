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
export const COMMAND_HELP_CHECKS = {
  'checks-plan': {
    summary: 'Print the resolved CI check plan for a given profile.',
    usage:
      'node scripts/pipeline/run.mjs checks-plan --profile <none|fast|full|custom> [--custom-checks <csv>] [--github-output <path>] [--dry-run]',
    options: [
      '--profile <name>                  Required; none|fast|full|custom.',
      '--custom-checks <csv>             Required when --profile custom.',
      '--github-output <path>            Optional; writes KEY=VALUE lines for Actions.',
      '--dry-run',
    ],
    bullets: ['Useful to see exactly what `checks` would run before you execute it.'],
    examples: [
      'node scripts/pipeline/run.mjs checks-plan --profile fast',
      'node scripts/pipeline/run.mjs checks-plan --profile custom --custom-checks e2e_core,build_docs',
    ],
  },

  checks: {
    summary: 'Run the local CI check suite (parity with GitHub Actions).',
    usage:
      'node scripts/pipeline/run.mjs checks --profile <none|fast|full|custom> [--custom-checks <csv>] [--install-deps <auto|true|false>] [--dry-run]',
    options: [
      '--profile <name>                  Required; none|fast|full|custom.',
      '--custom-checks <csv>             Required when --profile custom.',
      '--install-deps <auto|true|false>  (default: auto).',
      '--dry-run',
    ],
    bullets: [
      'Use this when iterating on CI locally instead of waiting for GitHub runners.',
      'Uses your local toolchain; if GitHub differs, prefer running checks in a clean container/VM.',
    ],
    examples: [
      'node scripts/pipeline/run.mjs checks --profile fast',
      'node scripts/pipeline/run.mjs checks --profile custom --custom-checks e2e_core_slow,server_db_contract',
    ],
  },

  'smoke-cli': {
    summary: 'Run the CLI smoke test (sanity-check a built CLI package).',
    usage:
      'node scripts/pipeline/run.mjs smoke-cli [--package-dir <dir>] [--workspace-name <name>] [--skip-build true|false] [--dry-run]',
    options: [
      '--package-dir <dir>               (default: apps/cli).',
      '--workspace-name <name>           (default: @happier-dev/cli).',
      '--skip-build <bool>               true|false (default: false).',
      '--dry-run',
    ],
    bullets: ['Useful before publishing npm packages or CLI binaries.'],
    examples: ['node scripts/pipeline/run.mjs smoke-cli --skip-build false'],
  },
};

