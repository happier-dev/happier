import { join, resolve } from 'node:path';
import { writeFile } from 'node:fs/promises';

import { expandHome } from '../paths/canonical_home.mjs';
import { coerceHappyMonorepoRootFromPath, getComponentDir, getWorkspaceDir, resolveStackEnvPath } from '../paths/paths.mjs';
import { ensureDir } from '../fs/ops.mjs';
import { getEnvValueAny } from '../env/values.mjs';
import { readEnvObjectFromFile } from '../env/read.mjs';
import { resolveCommandPath } from '../proc/commands.mjs';
import { run, runCapture } from '../proc/proc.mjs';
import { getCliHomeDirFromEnvOrDefault } from './dirs.mjs';

function resolveWorkspaceDirFromStackEnv({ rootDir, stackEnv }) {
  const raw = getEnvValueAny(stackEnv, ['HAPPIER_STACK_WORKSPACE_DIR']);
  if (!raw) {
    return getWorkspaceDir(rootDir, stackEnv);
  }
  const expanded = expandHome(raw);
  return expanded.startsWith('/') ? expanded : resolve(rootDir, expanded);
}

function resolveComponentDirFromStackEnv({ rootDir, stackEnv, keys, component }) {
  const raw = getEnvValueAny(stackEnv, keys);
  if (!raw) return getComponentDir(rootDir, component, stackEnv);
  const expanded = expandHome(raw);
  if (expanded.startsWith('/')) return expanded;
  const workspaceDir = resolveWorkspaceDirFromStackEnv({ rootDir, stackEnv });
  return resolve(workspaceDir, expanded);
}

export async function isCursorInstalled({ cwd, env } = {}) {
  if (await resolveCommandPath('cursor', { cwd, env })) return true;
  if (process.platform !== 'darwin') return false;
  try {
    await runCapture('open', ['-Ra', 'Cursor'], { cwd, env });
    return true;
  } catch {
    return false;
  }
}

export async function openWorkspaceInEditor({ rootDir, editor, workspacePath }) {
  if (editor === 'code') {
    const codePath = await resolveCommandPath('code', { cwd: rootDir, env: process.env });
    if (!codePath) {
      throw new Error(
        "[stack] VS Code CLI 'code' not found on PATH. In VS Code: Cmd+Shift+P → 'Shell Command: Install code command in PATH'."
      );
    }
    await run(codePath, ['-n', workspacePath], { cwd: rootDir, env: process.env, stdio: 'inherit' });
    return;
  }

  const cursorPath = await resolveCommandPath('cursor', { cwd: rootDir, env: process.env });
  if (cursorPath) {
    try {
      await run(cursorPath, ['-n', workspacePath], { cwd: rootDir, env: process.env, stdio: 'inherit' });
    } catch {
      await run(cursorPath, [workspacePath], { cwd: rootDir, env: process.env, stdio: 'inherit' });
    }
    return;
  }

  if (process.platform === 'darwin') {
    // Cursor installed but CLI missing is common on macOS.
    await run('open', ['-na', 'Cursor', workspacePath], { cwd: rootDir, env: process.env, stdio: 'inherit' });
    return;
  }

  throw new Error("[stack] Cursor CLI 'cursor' not found on PATH (and non-macOS fallback is unavailable).");
}

export async function writeStackCodeWorkspace({
  rootDir,
  stackName,
  includeStackDir,
  includeAllComponents,
  includeCliHome,
}) {
  const { baseDir, envPath } = resolveStackEnvPath(stackName);
  const stackEnv = await readEnvObjectFromFile(envPath);

  const serverComponent =
    getEnvValueAny(stackEnv, ['HAPPIER_STACK_SERVER_COMPONENT']) || 'happy-server-light';

  const selectedComponents = includeAllComponents
    ? ['happy', 'happy-cli', 'happy-server-light', 'happy-server']
    : ['happy', 'happy-cli', serverComponent];

  const componentSpecs = [
    { component: 'happy', keys: ['HAPPIER_STACK_COMPONENT_DIR_HAPPY'] },
    { component: 'happy-cli', keys: ['HAPPIER_STACK_COMPONENT_DIR_HAPPY_CLI'] },
    {
      component: 'happy-server-light',
      keys: ['HAPPIER_STACK_COMPONENT_DIR_HAPPY_SERVER_LIGHT'],
    },
    { component: 'happy-server', keys: ['HAPPIER_STACK_COMPONENT_DIR_HAPPY_SERVER'] },
  ];
  const byName = new Map(componentSpecs.map((c) => [c.component, c.keys]));

  const folders = [];
  if (includeStackDir) {
    folders.push({ name: `stack:${stackName}`, path: baseDir });
  }
  if (includeCliHome) {
    const cliHomeDir = getCliHomeDirFromEnvOrDefault({ stackBaseDir: baseDir, env: stackEnv });
    folders.push({ name: `cli:${stackName}`, path: expandHome(cliHomeDir) });
  }
  for (const component of selectedComponents) {
    const keys = byName.get(component) ?? [];
    const componentDir = resolveComponentDirFromStackEnv({ rootDir, stackEnv, keys, component });
    const monoRoot = coerceHappyMonorepoRootFromPath(componentDir);
    folders.push({ name: component, path: monoRoot || componentDir });
  }

  // Deduplicate by path (can happen if multiple components are pointed at the same dir).
  const uniqFolders = folders.filter((f, i, arr) => arr.findIndex((x) => x.path === f.path) === i);

  await ensureDir(baseDir);
  const workspacePath = join(baseDir, `stack.${stackName}.code-workspace`);
  const payload = {
    folders: uniqFolders,
    settings: {
      'search.exclude': {
        '**/node_modules/**': true,
        '**/.git/**': true,
        '**/logs/**': true,
        '**/cli/logs/**': true,
      },
      'files.watcherExclude': {
        '**/node_modules/**': true,
        '**/.git/**': true,
        '**/logs/**': true,
        '**/cli/logs/**': true,
      },
    },
  };
  await writeFile(workspacePath, JSON.stringify(payload, null, 2) + '\n', 'utf-8');

  return {
    workspacePath,
    baseDir,
    envPath,
    serverComponent,
    folders: uniqFolders,
    flags: {
      includeStackDir: Boolean(includeStackDir),
      includeCliHome: Boolean(includeCliHome),
      includeAllComponents: Boolean(includeAllComponents),
    },
  };
}
