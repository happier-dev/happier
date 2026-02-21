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

import { COMMAND_HELP } from './help-specs.mjs';

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
    '',
    style.bold('All commands:'),
    ...indent(
      Object.keys(COMMAND_HELP)
        .sort((a, b) => a.localeCompare(b))
        .map((name) => `${style.bold(name.padEnd(28))} ${COMMAND_HELP[name].summary}`),
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
    ...(Array.isArray(spec.options) && spec.options.length > 0
      ? [style.bold('Options:'), ...indent(spec.options.map((o) => `- ${o}`), 2), '']
      : []),
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
