import { readFile, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { resolveExecutableCommand } from '@happier-dev/cli-common/process';
import { expandHomeDirPath } from '@/utils/path/expandHomeDirPath';

export type NpmMachineConfigEnvironment = Readonly<{
  homeDir: string; cwd: string; execPath: string; platform: NodeJS.Platform; env: NodeJS.ProcessEnv;
}>;

async function configFile(path: string, env: NodeJS.ProcessEnv): Promise<Record<string, string>> {
  let raw: string;
  try { raw = await readFile(path, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}; throw new Error('npm_config_unavailable'); }
  const result: Record<string, string> = {};
  // Only root scalar INI entries select registry credentials; sections and arrays do not.
  let section = false;
  for (const line of raw.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed || /^[;#]/u.test(trimmed)) continue;
    if (trimmed.startsWith('[')) { section = true; continue; }
    if (section) continue;
    const match = /^([^=]+?)\s*=\s*(.*)$/u.exec(trimmed);
    if (!match) continue;
    const key = match[1]!.trim();
    let value = match[2]!.trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      if (value.startsWith('"')) { try { value = JSON.parse(value) as string; } catch { continue; } }
      else value = value.slice(1, -1);
    } else value = value.replace(/(?<!\\)[;#].*$/u, '').trim().replace(/\\([;#])/gu, '$1');
    result[key] = value.replace(/\$\{([^}]+)\}/gu, (whole, name: string) => env[name.replace(/\?$/u, '')] ?? (name.endsWith('?') ? '' : whole));
  }
  return result;
}

async function projectRoot(cwd: string): Promise<string> {
  let current = resolve(cwd);
  for (;;) {
    const found = await Promise.all(['package.json', 'node_modules'].map(async (name) => {
      try { await stat(join(current, name)); return true; } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
        throw new Error('npm_config_unavailable');
      }
    }));
    if (found.some(Boolean) || dirname(current) === current) return current;
    current = dirname(current);
  }
}

/** Acquires this Machine's selected-registry token afresh, without copying it into profile storage. */
export async function readMachineNpmAuthorization(registryOrigin: string, projectDir?: string, environment?: NpmMachineConfigEnvironment): Promise<string | undefined> {
  const context = environment ?? { homeDir: homedir(), cwd: process.cwd(), execPath: process.execPath, platform: process.platform, env: process.env };
  const envConfig: Record<string, string> = {};
  for (const [key, value] of Object.entries(context.env)) {
    if (/^npm_config_/iu.test(key) && value !== undefined) {
      const configKey = key.slice('npm_config_'.length);
      envConfig[configKey.startsWith('//') ? configKey : configKey.toLowerCase().replace(/_/gu, '-')] = value;
    }
  }
  const root = await projectRoot(projectDir ?? context.cwd);
  const project = await configFile(join(root, '.npmrc'), context.env);
  const local = { ...project, ...envConfig };
  const pathValue = (value: string) => {
    const expanded = expandHomeDirPath(value, { ...context.env, HOME: context.homeDir, USERPROFILE: context.homeDir }, context.platform);
    return isAbsolute(expanded) ? expanded : resolve(context.cwd, expanded);
  };
  const user = await configFile(pathValue(local.userconfig ?? join(context.homeDir, '.npmrc')), context.env);
  let prefix = local.prefix ?? user.prefix ?? context.env.PREFIX;
  if (!prefix) {
    // npm 12.2.1 Config.loadGlobalPrefix uses Node's installation, not the host
    // executable: Happier may itself be a standalone Bun binary.
    const node = resolveExecutableCommand('node', { env: context.env, cwd: context.cwd });
    if (node) {
      const nodePath = await realpath(node);
      prefix = context.platform === 'win32' ? dirname(nodePath) : dirname(dirname(nodePath));
      if (context.platform !== 'win32' && context.env.DESTDIR) prefix = join(context.env.DESTDIR, prefix);
    }
  }
  const globalconfig = local.globalconfig ?? user.globalconfig ?? (prefix ? join(prefix, 'etc', 'npmrc') : undefined);
  const global = globalconfig ? await configFile(pathValue(globalconfig), context.env) : {};
  const config = { ...global, ...user, ...project, ...envConfig };
  const token = config[`//${new URL(registryOrigin).host}/:_authToken`];
  return token && !/\$\{[^}]+\}/u.test(token) ? `Bearer ${token}` : undefined;
}
