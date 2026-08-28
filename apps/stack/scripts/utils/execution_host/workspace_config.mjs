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

function workspaceStackValues(argv) {
  const values = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = String(argv[index]);
    if (argument.startsWith('--workspace-stack=')) {
      values.push(argument.slice('--workspace-stack='.length));
      continue;
    }
    if (argument === '--workspace-stack') {
      values.push(String(argv[index + 1] ?? ''));
      index += 1;
    }
  }
  return values;
}

export function resolveNamedWorkspaceConfiguration({ argv, guestWorkspaceDir, mirrorWorkspaceDir }) {
  const args = Array.isArray(argv) ? argv : [];
  const stackNames = new Map();
  for (const declaration of workspaceStackValues(args)) {
    const separator = declaration.indexOf('=');
    if (separator <= 0 || separator === declaration.length - 1) {
      throw new Error('[dev-vm] --workspace-stack must use ID=STACK_NAME');
    }
    const id = declaration.slice(0, separator).trim();
    if (stackNames.has(id)) throw new Error(`[dev-vm] duplicate Stack name for workspace ${JSON.stringify(id)}`);
    stackNames.set(id, declaration.slice(separator + 1).trim());
  }
  const workspaces = workspaceValues(args).map((declaration) => {
    const separator = declaration.indexOf('=');
    if (separator <= 0 || separator === declaration.length - 1) {
      throw new Error('[dev-vm] --workspace must use ID=ABSOLUTE_SOURCE_DIR');
    }
    const id = declaration.slice(0, separator).trim();
    const hostSourceDir = declaration.slice(separator + 1).trim();
    if (!isAbsolute(hostSourceDir)) {
      throw new Error(`[dev-vm] workspace ${JSON.stringify(id)} requires an absolute source directory`);
    }
    return {
      id,
      ...(stackNames.has(id) ? { stackName: stackNames.get(id) } : {}),
      hostSourceDir,
      hostMirrorDir: join(mirrorWorkspaceDir, id),
      guestDir: join(guestWorkspaceDir, id),
    };
  });
  const workspaceIds = new Set(workspaces.map((workspace) => workspace.id));
  for (const id of stackNames.keys()) {
    if (!workspaceIds.has(id)) throw new Error(`[dev-vm] --workspace-stack refers to unknown workspace id: ${id}`);
  }
  return workspaces;
}
