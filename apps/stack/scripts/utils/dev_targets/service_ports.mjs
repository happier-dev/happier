import { posix, win32 } from 'node:path';
import { posixQuote, powershellQuote, resolveRemoteStackStatePaths, wrapRemoteScript } from './remote_commands.mjs';

// Probe on the service host, using the same selector as the controller. The
// caller must complete native retirement before asking to reuse this choice.
export function buildRemoteServicePortSelectionCommand(target, { stackName, runtimeMode = 'source', service = 'server', startPort, preferredServerPort, reservedPorts = [] }) {
  const pathApi = target.platform === 'windows' ? win32 : posix;
  const ownerPath = pathApi.join(target.repoDir, 'apps/stack/scripts/utils/stack/runtime_ports.mjs');
  // Every Stack on this target root shares one reservation directory.
  const paths = resolveRemoteStackStatePaths(target, { stackName, runtimeMode });
  const reservationDir = `${paths.stackStorageDir}/.service-port-reservations`;
  const expression = [
    '(async () => {',
    `const {selectStackServicePortOnHost} = await import(require('node:url').pathToFileURL(${JSON.stringify(ownerPath)}).href);`,
    'let allocation;',
    `const port = await selectStackServicePortOnHost({reservationDir: ${JSON.stringify(reservationDir)}, stackName: ${JSON.stringify(paths.stackName)}, service: ${JSON.stringify(service)}, startPort: ${JSON.stringify(startPort)}, preferredServerPort: ${JSON.stringify(preferredServerPort)}, reservedPorts: new Set(${JSON.stringify(reservedPorts)}), onPortChange: change => { allocation = change; }});`,
    'process.stdout.write(JSON.stringify(allocation ?? {port}));',
    '})().catch(error => { console.error(error); process.exit(1); });',
  ].join('\n');
  return wrapRemoteScript(target, target.platform === 'windows'
    ? `node -e ${powershellQuote(expression)}; exit $LASTEXITCODE`
    : `exec node -e ${posixQuote(expression)}`);
}
