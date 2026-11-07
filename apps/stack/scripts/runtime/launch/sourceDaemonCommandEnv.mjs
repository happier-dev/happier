import { join } from 'node:path';

import { syncInstalledFirstPartyShims } from '@happier-dev/cli-common/firstPartyRuntime';

/** Expose exactly the source launch selected by the runtime owner to Session shells. */
export async function sourceDaemonCommandEnv({ env, cliHomeDir, cliLaunchSpec }) {
  if (cliLaunchSpec?.sourceSnapshot !== true) return env;
  const shimDir = join(cliHomeDir, 'source-runtime', 'bin');
  await syncInstalledFirstPartyShims({ componentId: 'happier-cli', sourceLaunch: {
    shimDir, command: cliLaunchSpec.command, args: cliLaunchSpec.args,
  } });
  const result = { ...env };
  const windows = process.platform === 'win32';
  const pathNames = Object.keys(result).filter(name => windows ? name.toUpperCase() === 'PATH' : name === 'PATH');
  const pathName = pathNames[0] ?? (windows ? 'Path' : 'PATH');
  const delimiter = windows ? ';' : ':';
  const inheritedPath = result[pathName] ?? '';
  for (const name of pathNames) delete result[name];
  result[pathName] = [shimDir, ...inheritedPath.split(delimiter).filter(part => windows
    ? part.toLowerCase() !== shimDir.toLowerCase() : part !== shimDir)].join(delimiter);
  if (windows) {
    const extensionNames = Object.keys(result).filter(name => name.toUpperCase() === 'PATHEXT');
    const extensionName = extensionNames[0] ?? 'PATHEXT';
    const extensions = result[extensionName]?.split(';').filter(Boolean) ?? [];
    for (const name of extensionNames) delete result[name];
    result[extensionName] = extensions.some(extension => extension.toUpperCase() === '.CMD')
      ? extensions.join(';') : [...extensions, '.CMD'].join(';');
  }
  return result;
}
