import { existsSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';

import { coerceHappyMonorepoRootFromPath, resolveExplicitStackEnvFilePath } from '../utils/paths/paths.mjs';
import { resolveCliHomeDir } from '../utils/stack/dirs.mjs';

function takePrefixFlagValue(args, name) {
  const a0 = String(args[0] ?? '');
  if (a0 === name) {
    const next = String(args[1] ?? '');
    const value = next.trim();
    if (!value || value.startsWith('--')) {
      throw new Error(`Missing value for ${name}`);
    }
    return { value, consumed: 2 };
  }
  if (a0.startsWith(`${name}=`)) {
    const value = a0.slice(name.length + 1).trim();
    if (!value) {
      throw new Error(`Missing value for ${name}`);
    }
    return { value, consumed: 1 };
  }
  return { value: null, consumed: 0 };
}

export function readPrefixServerSelection(argv) {
  const args = Array.isArray(argv) ? argv.map((a) => String(a ?? '')) : [];
  const selection = { server: null, serverUrl: null, webappUrl: null, publicServerUrl: null, localServerUrl: null };
  const flagFields = { '--server': 'server', '--server-url': 'serverUrl', '--webapp-url': 'webappUrl',
    '--local-server-url': 'localServerUrl', '--public-server-url': 'publicServerUrl' };
  let commandIndex = 0;
  for (let i = 0; i < args.length; i += 1) {
    for (const [name, field] of Object.entries(flagFields)) {
      const flag = takePrefixFlagValue(args.slice(i), name);
      if (!flag.consumed) continue;
      selection[field] = flag.value;
      if (i === commandIndex) commandIndex += flag.consumed;
      i += flag.consumed - 1;
      break;
    }
  }
  const { server, serverUrl, webappUrl, publicServerUrl, localServerUrl } = selection;
  const commandArgv = args.slice(commandIndex);

  return {
    hasExplicitSelection: Boolean(server || serverUrl || webappUrl || publicServerUrl || localServerUrl),
    explicitServerUrl: serverUrl || publicServerUrl || null,
    onlyServerId: server && !serverUrl && !webappUrl && !publicServerUrl && !localServerUrl ? server : null,
    commandArgv,
    isAuthCommand: commandArgv[0] === 'auth' || commandArgv[0] === 'logout',
  };
}

export function splitHstackHappierWrapperArgs(argv) {
  const wrapperFlags = ['--stack-help', '--runtime', '--source'];
  let childIndex = 0;
  while (wrapperFlags.includes(argv[childIndex]) || String(argv[childIndex] ?? '').startsWith('--runtime=')) childIndex += 1;
  // Mode flags belong to the wrapper prefix. Everything from the child command
  // onward, including a child's own separator, belongs to the CLI.
  return {
    wrapperArgv: argv.slice(0, childIndex),
    forwardedArgv: argv.slice(argv[childIndex] === '--' ? childIndex + 1 : childIndex),
  };
}

function isIdentityScopedCliHomeDir(value) {
  return /(^|[\\/])cli-identities([\\/]|$)/.test(String(value ?? '').trim());
}

function resolvePhysicalPathAllowMissing(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  const resolved = resolve(raw);
  const missingParts = [];
  let current = resolved;
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) return resolved;
    missingParts.unshift(basename(current));
    current = parent;
  }
  try {
    const physicalExisting = realpathSync(current);
    return missingParts.length > 0 ? resolve(physicalExisting, ...missingParts) : physicalExisting;
  } catch {
    return resolved;
  }
}

function isPathInside(baseDir, candidate) {
  const base = String(baseDir ?? '').trim();
  const value = String(candidate ?? '').trim();
  if (!base || !value) return false;
  try {
    const rel = relative(resolvePhysicalPathAllowMissing(base), resolvePhysicalPathAllowMissing(value));
    return rel === '' || (!!rel && !rel.startsWith('..') && !isAbsolute(rel));
  } catch {
    return false;
  }
}

export function resolveStackHappierCliHome({ env = process.env, stackBaseDir }) {
  const stackEnvFilePath = resolveExplicitStackEnvFilePath(env);
  const rawOverride = String(env.HAPPIER_STACK_CLI_HOME_DIR ?? '').trim();
  const stackCliHomeOverride = isPathInside(stackBaseDir, rawOverride) ? rawOverride : '';
  const isStackScopedInvocation = Boolean(stackCliHomeOverride) || Boolean(stackEnvFilePath && existsSync(stackEnvFilePath));
  const explicitHomeDir = String(env.HAPPIER_HOME_DIR ?? '').trim();
  const explicitStackIdentityHomeDir = isIdentityScopedCliHomeDir(explicitHomeDir) && isPathInside(stackBaseDir, explicitHomeDir)
    ? explicitHomeDir : '';
  const stackScopedCliHomeDir = explicitStackIdentityHomeDir || stackCliHomeOverride || join(stackBaseDir, 'cli');
  const cliHomeDir = isStackScopedInvocation
    ? resolveCliHomeDir({ ...env, HAPPIER_STACK_CLI_HOME_DIR: stackScopedCliHomeDir }, { preferStackCliHomeDir: true })
    : resolveCliHomeDir(env);
  return { cliHomeDir, isStackScopedInvocation };
}

export function resolveStackHappierPassthroughEntrypoint({ rootDir, env = process.env } = {}) {
  const launcherRoot = String(rootDir ?? '').trim();
  const repoRoot = coerceHappyMonorepoRootFromPath(env?.HAPPIER_STACK_REPO_DIR) || '';
  if (repoRoot) {
    const stackRoot = join(repoRoot, 'apps', 'stack');
    const stackWrapperEntrypoint = join(stackRoot, 'bin', 'happier.mjs');
    if (existsSync(stackWrapperEntrypoint)) {
      return {
        cwd: stackRoot,
        entrypoint: stackWrapperEntrypoint,
        source: 'stack-repo-wrapper',
      };
    }
  }

  return {
    cwd: launcherRoot,
    entrypoint: join(launcherRoot, 'scripts', 'happier.mjs'),
    source: 'launcher-script',
  };
}
