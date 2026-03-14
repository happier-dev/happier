import './utils/env/env.mjs';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { parseArgs } from './utils/cli/args.mjs';
import { printResult, wantsHelp, wantsJson } from './utils/cli/cli.mjs';
import { getComponentDir, getRootDir, getStackName } from './utils/paths/paths.mjs';
import { resolveCliHomeDir } from './utils/stack/dirs.mjs';
import { getPublicServerUrlEnvOverride, resolveServerPortFromEnv } from './utils/server/urls.mjs';
import { applyStackActiveServerScopeEnv } from './utils/auth/stable_scope_id.mjs';
import { readCliDistIntegrity } from './utils/cli/cliDistIntegrity.mjs';
import { resolveStackRuntimeLaunchContext } from './runtime/launch/resolveStackRuntimeLaunchContext.mjs';
import { resolveCliRuntimeLaunchSpec } from './runtime/launch/resolveCliRuntimeLaunchSpec.mjs';

function isNodeRuntimeEntrypoint(entrypoint) {
  return /\.(?:cjs|js|mjs)$/i.test(String(entrypoint ?? '').trim());
}

function printHstackHappierHelp({ json }) {
  printResult({
    json,
    data: { passthrough: true },
    text: [
      '[happier] usage:',
      '  hstack happier <happier-cli args...>',
      '',
      'notes:',
      '  - This runs the monorepo CLI component (apps/cli) with stack env defaults.',
      '  - It auto-fills HAPPIER_HOME_DIR / HAPPIER_SERVER_URL / HAPPIER_WEBAPP_URL when missing.',
      '',
      'stack wrapper options:',
      '  --stack-help  Show this wrapper help (use -h/--help for CLI help)',
    ].join('\n'),
  });
}

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

function readPrefixServerSelection(argv) {
  const args = Array.isArray(argv) ? argv.map((a) => String(a ?? '')) : [];
  const readExplicitServerFlags = (scanArgs, { includeServer }) => {
    let server = null;
    let serverUrl = null;
    let webappUrl = null;
    let publicServerUrl = null;
    let localServerUrl = null;

    for (let i = 0; i < scanArgs.length; i += 1) {
      const slice = scanArgs.slice(i);

      if (includeServer) {
        const serverFlag = takePrefixFlagValue(slice, '--server');
        if (serverFlag.consumed) {
          server = serverFlag.value;
          i += serverFlag.consumed - 1;
          continue;
        }
      }
      const serverUrlFlag = takePrefixFlagValue(slice, '--server-url');
      if (serverUrlFlag.consumed) {
        serverUrl = serverUrlFlag.value;
        i += serverUrlFlag.consumed - 1;
        continue;
      }
      const webappUrlFlag = takePrefixFlagValue(slice, '--webapp-url');
      if (webappUrlFlag.consumed) {
        webappUrl = webappUrlFlag.value;
        i += webappUrlFlag.consumed - 1;
        continue;
      }
      const localServerUrlFlag = takePrefixFlagValue(slice, '--local-server-url');
      if (localServerUrlFlag.consumed) {
        localServerUrl = localServerUrlFlag.value;
        i += localServerUrlFlag.consumed - 1;
        continue;
      }
      const publicServerUrlFlag = takePrefixFlagValue(slice, '--public-server-url');
      if (publicServerUrlFlag.consumed) {
        publicServerUrl = publicServerUrlFlag.value;
        i += publicServerUrlFlag.consumed - 1;
      }
    }

    return { server, serverUrl, webappUrl, publicServerUrl, localServerUrl };
  };

  const { server, serverUrl, webappUrl, publicServerUrl, localServerUrl } = readExplicitServerFlags(args, { includeServer: true });

  return {
    hasExplicitSelection: Boolean(server || serverUrl || webappUrl || publicServerUrl || localServerUrl),
    explicitServerUrl: serverUrl || publicServerUrl || null,
  };
}

function normalizeServerUrl(url) {
  return String(url ?? '').trim().replace(/\/+$/, '');
}

function deriveEnvServerIdFromUrl(url) {
  const normalized = normalizeServerUrl(url);
  if (!normalized) return null;
  let h = 2166136261;
  for (let i = 0; i < normalized.length; i += 1) {
    h ^= normalized.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `env_${(h >>> 0).toString(16)}`;
}

function coerceServerProfileFromSettings(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = typeof raw.id === 'string' ? raw.id.trim() : '';
  const serverUrl = normalizeServerUrl(raw.serverUrl);
  const webappUrl = normalizeServerUrl(raw.webappUrl);
  const localServerUrl = normalizeServerUrl(raw.localServerUrl);
  const legacyPublicServerUrl = normalizeServerUrl(raw.publicServerUrl);
  const canonicalServerUrl = legacyPublicServerUrl && legacyPublicServerUrl !== serverUrl ? legacyPublicServerUrl : serverUrl;
  if (!id || !canonicalServerUrl || !webappUrl) return null;
  return {
    id,
    serverUrl: canonicalServerUrl,
    localServerUrl: localServerUrl || null,
    webappUrl,
  };
}

function readActiveServerUrlsFromCliSettings(homeDir) {
  const baseDir = String(homeDir ?? '').trim();
  if (!baseDir) return null;
  const settingsPath = join(baseDir, 'settings.json');
  if (!existsSync(settingsPath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    if (!parsed || typeof parsed !== 'object') return null;
    const schemaVersion = Number(parsed.schemaVersion ?? 0);
    if (!Number.isFinite(schemaVersion) || schemaVersion < 5) return null;
    const activeServerId = typeof parsed.activeServerId === 'string' ? parsed.activeServerId.trim() : '';
    const servers = parsed.servers && typeof parsed.servers === 'object' ? parsed.servers : null;
    if (!activeServerId || !servers) return null;
    return coerceServerProfileFromSettings(servers[activeServerId]);
  } catch {
    return null;
  }
}

function resolveCliEntrypoint(cliDir) {
  const distEntrypoint = join(cliDir, 'dist', 'index.mjs');
  const distIntegrity = readCliDistIntegrity(distEntrypoint);
  if (distIntegrity.ok) {
    return { kind: 'dist', nodeArgs: [distEntrypoint], distEntrypoint };
  }

  const srcEntrypoint = join(cliDir, 'src', 'index.ts');
  if (!existsSync(srcEntrypoint)) {
    return null;
  }

  try {
    const require = createRequire(import.meta.url);
    const tsxPkgJsonPath = require.resolve('tsx/package.json');
    const tsxLoaderPath = join(dirname(tsxPkgJsonPath), 'dist', 'esm', 'index.mjs');
    if (!existsSync(tsxLoaderPath)) return null;
    return {
      kind: 'tsx',
      nodeArgs: ['--import', tsxLoaderPath, srcEntrypoint],
      distEntrypoint,
      tsconfigPath: join(cliDir, 'tsconfig.json'),
    };
  } catch {
    return null;
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const { flags } = parseArgs(argv);
  const json = wantsJson(argv, { flags });

  if (flags.has('--stack-help')) {
    printHstackHappierHelp({ json });
    return;
  }

  const rootDir = getRootDir(import.meta.url);

  const stackName = (process.env.HAPPIER_STACK_STACK ?? '').toString().trim() || getStackName();
  const serverPort = resolveServerPortFromEnv({ env: process.env, defaultPort: 3005 });
  const prefixServerSelection = readPrefixServerSelection(argv);
  const runtimeLaunchContext = await resolveStackRuntimeLaunchContext({ argv, env: process.env });

  const internalServerUrl = `http://127.0.0.1:${serverPort}`;
  const { publicServerUrl } = getPublicServerUrlEnvOverride({ env: process.env, serverPort, stackName });

  const cliHomeDir = resolveCliHomeDir();

  const cliLaunchSpec = runtimeLaunchContext.snapshot ? resolveCliRuntimeLaunchSpec({ snapshot: runtimeLaunchContext.snapshot }) : null;
  const cliDir = cliLaunchSpec?.cliDir ?? getComponentDir(rootDir, 'happier-cli');
  const resolvedCli = cliLaunchSpec
    ? isNodeRuntimeEntrypoint(cliLaunchSpec.entrypoint)
      ? {
          kind: 'runtime-node',
          nodeArgs: [cliLaunchSpec.entrypoint],
          distEntrypoint: cliLaunchSpec.entrypoint,
        }
      : {
          kind: 'runtime',
          command: cliLaunchSpec.command,
          args: cliLaunchSpec.args,
          distEntrypoint: cliLaunchSpec.entrypoint,
        }
    : resolveCliEntrypoint(cliDir);
  if (wantsHelp(argv, { flags }) && !resolvedCli) {
    printHstackHappierHelp({ json });
    return;
  }
  if (!resolvedCli) {
    const expectedDistEntrypoint = join(cliDir, 'dist', 'index.mjs');
    console.error(`[happier] missing CLI build at: ${expectedDistEntrypoint}`);
    console.error('Run: hstack bootstrap');
    process.exit(1);
  }

  let env = { ...process.env };
  env.HAPPIER_HOME_DIR = env.HAPPIER_HOME_DIR || cliHomeDir;
  if (!prefixServerSelection.hasExplicitSelection && !env.HAPPIER_SERVER_URL && !env.HAPPIER_WEBAPP_URL) {
    const settingsDefaults = readActiveServerUrlsFromCliSettings(env.HAPPIER_HOME_DIR);
    if (settingsDefaults) {
      if (settingsDefaults.localServerUrl && settingsDefaults.localServerUrl !== settingsDefaults.serverUrl) {
        env.HAPPIER_PUBLIC_SERVER_URL = settingsDefaults.serverUrl;
        env.HAPPIER_LOCAL_SERVER_URL = settingsDefaults.localServerUrl;
        env.HAPPIER_SERVER_URL = settingsDefaults.localServerUrl;
      } else {
        delete env.HAPPIER_PUBLIC_SERVER_URL;
        delete env.HAPPIER_LOCAL_SERVER_URL;
        env.HAPPIER_SERVER_URL = settingsDefaults.serverUrl;
      }
      env.HAPPIER_WEBAPP_URL = settingsDefaults.webappUrl;
    }
  }
  // Only set default env vars when no explicit server selection flags are present
  if (!prefixServerSelection.hasExplicitSelection) {
    env.HAPPIER_SERVER_URL = env.HAPPIER_SERVER_URL || internalServerUrl;
    env.HAPPIER_WEBAPP_URL = env.HAPPIER_WEBAPP_URL || publicServerUrl;
  }
  if (resolvedCli.kind === 'tsx') {
    // TSX resolves path aliases (`@/...`) using the tsconfig it finds. When the CLI runs from arbitrary
    // working directories (common in stack + daemon flows), it can pick up the wrong tsconfig unless
    // we provide an explicit path.
    env.TSX_TSCONFIG_PATH = env.TSX_TSCONFIG_PATH || resolvedCli.tsconfigPath;
  }
  if (prefixServerSelection.hasExplicitSelection) {
    // If the user explicitly selects a server/profile, do not force a stack-stable active server id.
    // Otherwise credentials can be resolved from the wrong per-server directory, causing 401s.
    const derived = prefixServerSelection.explicitServerUrl
      ? deriveEnvServerIdFromUrl(prefixServerSelection.explicitServerUrl)
      : null;
    if (derived) {
      env.HAPPIER_ACTIVE_SERVER_ID = derived;
    } else {
      delete env.HAPPIER_ACTIVE_SERVER_ID;
    }
  } else {
    env = applyStackActiveServerScopeEnv({
      env,
      stackName,
      cliIdentity: (env.HAPPIER_STACK_CLI_IDENTITY ?? '').toString().trim() || 'default',
    });
  }

  const forwardedArgv = argv.filter((a) => a !== '--stack-help');
  const res =
    resolvedCli.kind === 'runtime'
      ? spawnSync(resolvedCli.command, [...resolvedCli.args, ...forwardedArgv], {
          stdio: 'inherit',
          env,
        })
      : spawnSync(process.execPath, ['--no-warnings', '--no-deprecation', ...resolvedCli.nodeArgs, ...forwardedArgv], {
          stdio: 'inherit',
          env,
        });

  if (res.error) {
    const msg = res.error instanceof Error ? res.error.message : String(res.error);
    console.error(`[happier] failed to run CLI: ${msg}`);
    process.exit(1);
  }

  process.exit(res.status ?? 1);
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error('[happier] failed:', message);
  if (process.env.DEBUG && err instanceof Error && err.stack) {
    console.error(err.stack);
  }
  process.exit(1);
});
