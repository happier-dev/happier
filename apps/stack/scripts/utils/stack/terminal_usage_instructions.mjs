import { cmd, sectionTitle } from '../ui/layout.mjs';
import { cyan, dim } from '../ui/ansi.mjs';

export function renderTerminalUsageInstructions({
  internalServerUrl,
  cliHomeDir,
  publicServerUrl,
  activeServerId = '',
  stackName = '',
}) {
  const serverUrl = String(internalServerUrl ?? '').trim();
  const homeDir = String(cliHomeDir ?? '').trim();
  const webappUrl = String(publicServerUrl ?? '').trim();
  const scope = String(activeServerId ?? '').trim();
  const stack = String(stackName ?? '').trim();
  const stackWrapperCommand = stack ? `HAPPIER_STACK_STACK="${stack}" hstack happier` : 'hstack happier';

  return [
    '',
    sectionTitle('Terminal usage'),
    dim(`To run ${cyan('happier')} against this stack (and have sessions appear in the UI), use the stack-aware wrapper:`),
    ...(stack ? [cmd(`export HAPPIER_STACK_STACK="${stack}"`)] : []),
    cmd('hstack happier auth status --json'),
    cmd('hstack happier'),
    '',
    dim('Low-level env fallback (if you need the raw CLI env directly):'),
    cmd(`export HAPPIER_SERVER_URL="${serverUrl}"`),
    cmd(`export HAPPIER_HOME_DIR="${homeDir}"`),
    cmd(`export HAPPIER_WEBAPP_URL="${webappUrl}"`),
    ...(scope ? [cmd(`export HAPPIER_ACTIVE_SERVER_ID="${scope}"`)] : []),
    '',
    dim('Sanity check (should be ok:true):'),
    cmd(`${stackWrapperCommand} auth status --json`),
    '',
    dim('Then run:'),
    cmd('hstack happier'),
    '',
    dim('One-liner (no exports):'),
    cmd(
      [
        ...(stack ? [`HAPPIER_STACK_STACK="${stack}"`] : []),
        `HAPPIER_SERVER_URL="${serverUrl}"`,
        `HAPPIER_HOME_DIR="${homeDir}"`,
        `HAPPIER_WEBAPP_URL="${webappUrl}"`,
        ...(scope ? [`HAPPIER_ACTIVE_SERVER_ID="${scope}"`] : []),
        'hstack happier',
      ].join(' '),
    ),
    '',
    dim('Note: keep HAPPIER_HOME_DIR as shown to use this stack/sandbox account and credentials if you bypass the wrapper.'),
  ];
}
