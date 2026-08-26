import { isAbsolute, join } from 'node:path';

function workspaceValues(argv) {
  const values = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = String(argv[index]);
    if (argument.startsWith('--workspace=')) {
      values.push(argument.slice('--workspace='.length));
      continue;
    }
    if (argument === '--workspace') {
      values.push(String(argv[index + 1] ?? ''));
      index += 1;
    }
  }
  return values;
}

export function resolveNamedWorkspaceConfiguration({ argv, guestWorkspaceDir, mirrorWorkspaceDir }) {
  return workspaceValues(Array.isArray(argv) ? argv : []).map((declaration) => {
    const separator = declaration.indexOf('=');
    if (separator <= 0 || separator === declaration.length - 1) {
      throw new Error('[host] --workspace must use ID=ABSOLUTE_SOURCE_DIR');
    }
    const id = declaration.slice(0, separator).trim();
    const hostSourceDir = declaration.slice(separator + 1).trim();
    if (!isAbsolute(hostSourceDir)) {
      throw new Error(`[host] workspace ${JSON.stringify(id)} requires an absolute source directory`);
    }
    return {
      id,
      hostSourceDir,
      hostMirrorDir: join(mirrorWorkspaceDir, id),
      guestDir: join(guestWorkspaceDir, id),
    };
  });
}
