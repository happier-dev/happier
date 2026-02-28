import { cmd, sectionTitle } from '../ui/layout.mjs';
import { cyan, dim } from '../ui/ansi.mjs';

export function renderTerminalUsageInstructions({ internalServerUrl, cliHomeDir, publicServerUrl }) {
  const serverUrl = String(internalServerUrl ?? '').trim();
  const homeDir = String(cliHomeDir ?? '').trim();
  const webappUrl = String(publicServerUrl ?? '').trim();

  return [
    '',
    sectionTitle('Terminal usage'),
    dim(`To run ${cyan('happier')} against this stack (and have sessions appear in the UI), use the stack's isolated CLI home:`),
    cmd(`export HAPPIER_SERVER_URL="${serverUrl}"`),
    cmd(`export HAPPIER_HOME_DIR="${homeDir}"`),
    cmd(`export HAPPIER_WEBAPP_URL="${webappUrl}"`),
    '',
    dim('Sanity check (should be ok:true):'),
    cmd('happier auth status --json'),
    '',
    dim('Then run:'),
    cmd('happier'),
    '',
    dim('One-liner (no exports):'),
    cmd(`HAPPIER_SERVER_URL="${serverUrl}" HAPPIER_HOME_DIR="${homeDir}" HAPPIER_WEBAPP_URL="${webappUrl}" happier`),
    '',
    dim('Note: keep HAPPIER_HOME_DIR as shown to use this stack/sandbox account and credentials.'),
  ];
}
