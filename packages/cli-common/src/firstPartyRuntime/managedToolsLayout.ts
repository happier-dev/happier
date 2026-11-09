import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveHappyHomeDirFromEnvironment } from '../agents/resolveHappyHomeDir.js';
import { resolveManagedToolsRoot } from '../agents/managedToolsRoot.js';
import { isCanonicalAbsolutePathInsideRoot, resolveCanonicalAbsolutePath, resolveHomeDirFromEnvironment } from '../path/index.js';
import { MANAGED_TOOLS_ROOT_ENV_KEY } from './installLayoutContract.js';

type SeparateUserToolsLayout = Readonly<{
  toolsRoot: string;
  persistence?: Readonly<{ path: string; content: string }>;
}>;

function isExternal(root: string, env: NodeJS.ProcessEnv, happyHomeDir: string): boolean {
  return !isCanonicalAbsolutePathInsideRoot(happyHomeDir, root)
    && !isCanonicalAbsolutePathInsideRoot(resolveHomeDirFromEnvironment(env), root);
}

/** The existing Linux setup recipe owns creation; startup activates this code-only location. */
export function resolveSeparateUserToolsLayout(input: Readonly<{
  env?: NodeJS.ProcessEnv; machineStateRoot: string; platform?: NodeJS.Platform;
}>): SeparateUserToolsLayout {
  const env = input.env ?? process.env;
  const toolsRoot = resolveManagedToolsRoot(env);
  const happyHomeDir = resolveHappyHomeDirFromEnvironment(env);
  if ((input.platform ?? process.platform) !== 'linux' || isExternal(toolsRoot, env, happyHomeDir)) return { toolsRoot };
  const identity = resolveCanonicalAbsolutePath(happyHomeDir)!.comparisonKey;
  const externalRoot = join(input.machineStateRoot, 'tools', createHash('sha256').update(identity).digest('hex'));
  return { toolsRoot: externalRoot, persistence: {
    path: join(happyHomeDir, 'install-layout.json'),
    content: JSON.stringify({ managedToolsRoot: externalRoot }) + '\n',
  } };
}

/** Read once with private configuration; all tool consumers use the selected environment. */
export function applyPersistedManagedToolsRoot(input: Readonly<{
  env: NodeJS.ProcessEnv; happyHomeDir: string; platform?: NodeJS.Platform;
}>): void {
  const { env, happyHomeDir } = input;
  if ((input.platform ?? process.platform) !== 'linux' || env[MANAGED_TOOLS_ROOT_ENV_KEY]?.trim()
    || isExternal(resolveManagedToolsRoot(env), env, happyHomeDir)) return;
  try {
    const record: unknown = JSON.parse(readFileSync(join(happyHomeDir, 'install-layout.json'), 'utf8'));
    if (!record || typeof record !== 'object' || !('managedToolsRoot' in record)
      || typeof record.managedToolsRoot !== 'string') return;
    const root = resolveCanonicalAbsolutePath(record.managedToolsRoot, { env, platform: 'linux' });
    if (root && isExternal(root.path, env, happyHomeDir)) env[MANAGED_TOOLS_ROOT_ENV_KEY] = root.path;
  } catch {
    // Optional installed code retains its existing typed unavailable admission;
    // a missing or damaged local layout must not stop daemon startup.
  }
}
