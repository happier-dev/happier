import { join } from 'node:path';

import { parseArgs } from '../utils/cli/args.mjs';
import { printResult, wantsJson } from '../utils/cli/cli.mjs';
import { run } from '../utils/proc/proc.mjs';
import { coercePort } from '../utils/server/port.mjs';
import { collectReservedStackPorts, getDefaultPortStart, isPortFree, pickNextFreePort } from './port_reservation.mjs';
import { resolveStackBaseDir, resolveStackEnvPath } from '../utils/paths/paths.mjs';
import { stackExistsSync } from '../utils/stack/stacks.mjs';
import { ensureEnvFileUpdated } from '../utils/env/env_file.mjs';
import { parseEnvToObject } from '../utils/env/dotenv.mjs';
import { readTextOrEmpty } from '../utils/fs/ops.mjs';
import { withStackEnv } from './stack_environment.mjs';
import { resolveRequestedRepoCheckoutDir } from './repo_checkout_resolution.mjs';
import { resolveStackTauriIdentity } from '../utils/tauri/stack_overrides.mjs';
import { installMacOsDesktopApp, resolveMacOsDesktopInstallPlan } from '../utils/tauri/desktop_install.mjs';

const readExistingEnv = readTextOrEmpty;

function resolveDesktopMode({ flags, kv }) {
  const raw = String(kv.get('--desktop') ?? '').trim().toLowerCase();
  if (flags.has('--no-desktop') || raw === 'none' || raw === 'false' || raw === '0') return 'none';
  if (raw === 'build') return 'build';
  if (raw === 'install' || raw === '') return 'install';
  throw new Error(`[stack install] invalid --desktop value: ${raw} (expected: install, build, none)`);
}

function resolveServiceMode({ flags, kv }) {
  const raw = String(kv.get('--service') ?? '').trim().toLowerCase();
  if (flags.has('--no-service') || raw === 'none' || raw === 'false' || raw === '0') return 'none';
  if (!raw) return 'user';
  if (raw === 'user' || raw === 'system') return raw;
  throw new Error(`[stack install] invalid --service value: ${raw} (expected: user, system, none)`);
}

function resolveRuntimeMode({ kv }) {
  const raw = String(kv.get('--runtime-mode') ?? '').trim().toLowerCase() || 'require';
  if (raw === 'require' || raw === 'prefer') return raw;
  throw new Error(`[stack install] invalid --runtime-mode value: ${raw} (expected: require, prefer)`);
}

function resolveInstallPlatform({ kv, platform = process.platform }) {
  return String(kv.get('--desktop-platform') ?? '').trim() || platform;
}

function resolveServerUrl(port) {
  return `http://127.0.0.1:${port}`;
}

async function readStackEnv(stackName) {
  const { envPath } = resolveStackEnvPath(stackName);
  const raw = await readExistingEnv(envPath);
  return { envPath, env: parseEnvToObject(raw) };
}

async function resolveExistingStackRepoUpdate({ rootDir, stackName, repo }) {
  const requested = String(repo ?? '').trim();
  if (!requested) return '';
  const { env } = await readStackEnv(stackName);
  const resolved = await resolveRequestedRepoCheckoutDir({
    rootDir,
    repoSelection: requested,
    defaultRepoDir: String(env.HAPPIER_STACK_REPO_DIR ?? '').trim(),
    remoteName: String(env.HAPPIER_STACK_STACK_REMOTE ?? '').trim() || 'upstream',
  });
  return resolved || requested;
}

async function resolveInstallPort({ stackName, explicitPortRaw, stackAlreadyExists }) {
  const explicitPort = coercePort(explicitPortRaw);
  if (explicitPort) {
    return explicitPort;
  }
  if (stackAlreadyExists) {
    const { env } = await readStackEnv(stackName);
    const existing = coercePort(env.HAPPIER_STACK_SERVER_PORT);
    if (existing) return existing;
  }

  const reservedPorts = await collectReservedStackPorts({ excludeStackName: stackName });
  return await pickNextFreePort(getDefaultPortStart(stackName), { reservedPorts });
}

async function assertPortCanBePinned({ stackName, port, stackAlreadyExists }) {
  const { env } = stackAlreadyExists ? await readStackEnv(stackName) : { env: {} };
  const existing = coercePort(env.HAPPIER_STACK_SERVER_PORT);
  if (existing === port) return;
  const free = await isPortFree(port);
  if (!free) {
    throw new Error(`[stack install] port ${port} is not free on 127.0.0.1.`);
  }
}

function buildDesktopMetadata({ stackName, port, desktopDebug, env = process.env }) {
  const identity = resolveStackTauriIdentity({
    env: {
      ...env,
      HAPPIER_STACK_STACK: stackName,
    },
    baseProductName: 'Happier',
  });
  const { baseDir } = resolveStackBaseDir(stackName, env);
  const profile = desktopDebug ? 'debug' : 'release';
  const sourceAppPath = join(baseDir, 'tauri-target', profile, 'bundle', 'macos', `${identity.productName}.app`);
  const installPlan = resolveMacOsDesktopInstallPlan({
    productName: identity.productName,
    sourceAppPath,
    env,
  });
  return {
    ...identity,
    serverUrl: resolveServerUrl(port),
    debug: desktopDebug,
    sourceAppPath,
    installDir: installPlan.installDir,
    targetAppPath: installPlan.targetAppPath,
  };
}

export async function buildStackInstallPlan({
  rootDir,
  stackName,
  argv = [],
  env = process.env,
  platform = process.platform,
  stackExists = stackExistsSync,
} = {}) {
  const { flags, kv } = parseArgs(argv);
  const desktopMode = resolveDesktopMode({ flags, kv });
  const serviceMode = resolveServiceMode({ flags, kv });
  const runtimeMode = resolveRuntimeMode({ kv });
  const desktopPlatform = resolveInstallPlatform({ kv, platform });
  const stackAlreadyExists = stackExists(stackName);
  const port = await resolveInstallPort({
    stackName,
    explicitPortRaw: kv.get('--port') ?? '',
    stackAlreadyExists,
  });
  const desktopDebug = flags.has('--desktop-debug');
  const repo = String(kv.get('--repo') ?? kv.get('--repo-dir') ?? '').trim();
  const serverFlavor = String(kv.get('--server-flavor') ?? kv.get('--server') ?? '').trim();

  if (stackName === 'main') {
    throw new Error('[stack install] stack install requires a named stack; "main" is reserved.');
  }
  if (desktopMode === 'install' && desktopPlatform !== 'darwin') {
    throw new Error('[stack install] desktop installation is only supported on macOS in v1. Re-run with --no-desktop on this platform.');
  }

  const steps = [];
  if (!stackAlreadyExists) {
    steps.push({
      id: 'create-stack',
      script: 'stack.mjs',
      args: [
        'new',
        stackName,
        '--non-interactive',
        `--port=${port}`,
        ...(repo ? [`--repo=${repo}`] : []),
        ...(serverFlavor ? [`--server=${serverFlavor}`] : []),
      ],
    });
  } else {
    const envUpdates = [
      { key: 'HAPPIER_STACK_SERVER_PORT', value: String(port) },
    ];
    if (repo) {
      envUpdates.push({
        key: 'HAPPIER_STACK_REPO_DIR',
        value: await resolveExistingStackRepoUpdate({ rootDir, stackName, repo }),
      });
    }
    steps.push({
      id: 'update-stack-env',
      envUpdates,
    });
  }

  steps.push({
    id: 'build-runtime',
    script: 'build.mjs',
    args: ['--all', '--activate-runtime', ...(flags.has('--force-rebuild') ? ['--force-rebuild'] : [])],
  });
  steps.push({
    id: 'set-runtime-mode',
    envUpdates: [{ key: 'HAPPIER_STACK_RUNTIME_MODE', value: runtimeMode }],
  });

  const desktop = desktopMode === 'none'
    ? null
    : buildDesktopMetadata({ stackName, port, desktopDebug, env });

  if (desktop) {
    steps.push({
      id: 'build-desktop',
      script: 'build.mjs',
      args: ['--tauri'],
      env: {
        HAPPIER_STACK_TAURI_SERVER_URL: desktop.serverUrl,
        HAPPIER_STACK_TAURI_DEBUG: desktop.debug ? '1' : '0',
      },
    });
  }

  if (serviceMode !== 'none') {
    steps.push({ id: 'install-service', script: 'service.mjs', args: ['install', `--mode=${serviceMode}`] });
    if (!flags.has('--no-restart')) {
      steps.push({ id: 'restart-service', script: 'service.mjs', args: ['restart', `--mode=${serviceMode}`] });
    }
  }

  if (desktopMode === 'install' && desktop) {
    steps.push({ id: 'install-desktop', sourceAppPath: desktop.sourceAppPath, targetAppPath: desktop.targetAppPath });
  }

  return {
    ok: true,
    stackName,
    dryRun: flags.has('--dry-run'),
    port,
    runtimeMode,
    serviceMode,
    desktopMode,
    desktop,
    steps,
    rootDir,
  };
}

async function runStackScript({ rootDir, stackName, script, args, extraEnv = {} }) {
  await withStackEnv({
    stackName,
    extraEnv,
    fn: async ({ env }) => {
      await run(process.execPath, [join(rootDir, 'scripts', script), ...args], { cwd: rootDir, env });
    },
  });
}

async function executeStackInstallPlan(plan) {
  const { rootDir, stackName } = plan;

  for (const step of plan.steps) {
    if (step.id === 'create-stack') {
      await run(process.execPath, [join(rootDir, 'scripts', step.script), ...step.args], { cwd: rootDir });
      continue;
    }
    if (step.id === 'update-stack-env' || step.id === 'set-runtime-mode') {
      const { envPath } = resolveStackEnvPath(stackName);
      await ensureEnvFileUpdated({ envPath, updates: step.envUpdates ?? [] });
      continue;
    }
    if (step.id === 'build-runtime' || step.id === 'build-desktop') {
      await runStackScript({ rootDir, stackName, script: step.script, args: step.args, extraEnv: step.env ?? {} });
      continue;
    }
    if (step.id === 'install-service' || step.id === 'restart-service') {
      await runStackScript({ rootDir, stackName, script: step.script, args: step.args });
      continue;
    }
    if (step.id === 'install-desktop') {
      await installMacOsDesktopApp({
        productName: plan.desktop.productName,
        sourceAppPath: step.sourceAppPath,
      });
    }
  }
}

export async function runStackInstallCommand({
  rootDir,
  stackName,
  argv = [],
  json = wantsJson(argv),
  env = process.env,
  platform = process.platform,
} = {}) {
  const plan = await buildStackInstallPlan({ rootDir, stackName, argv, env, platform });
  if (!plan.dryRun) {
    await assertPortCanBePinned({ stackName, port: plan.port, stackAlreadyExists: stackExistsSync(stackName) });
    await executeStackInstallPlan(plan);
  }

  printResult({
    json,
    data: plan,
    text: [
      `[stack install] ${plan.dryRun ? 'planned' : 'installed'} ${stackName}`,
      `[stack install] port: ${plan.port}`,
      `[stack install] desktop: ${plan.desktopMode}`,
      `[stack install] service: ${plan.serviceMode}`,
    ].join('\n'),
  });
}
