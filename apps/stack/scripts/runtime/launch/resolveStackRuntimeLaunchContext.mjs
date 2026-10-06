import { getRootDir, getStackName, resolveStackBaseDir } from '../../utils/paths/paths.mjs';
import { resolveStackRuntimeMode } from '../shared/runtime_mode.mjs';
import { resolveActiveRuntimeSnapshot } from './resolveActiveRuntimeSnapshot.mjs';
import { resolveRuntimeBuildAuthority } from '../shared/runtime_build_authority.mjs';
import { inspectLatestPublishedRuntimeSnapshot } from '../../build/activate_runtime_snapshot.mjs';

export async function resolveNativeDaemonRuntimeSnapshot({ stackName, env = process.env, mode = 'require' }) {
  if (mode === 'source') return null;
  const authority = resolveRuntimeBuildAuthority({
    rootDir: getRootDir(new URL('../../runtime_select.mjs', import.meta.url)),
    consumerStackName: stackName, env, createRepoIdentityIfMissing: false,
  });
  const inspection = await inspectLatestPublishedRuntimeSnapshot({
    stackBaseDir: authority.producerStackBaseDir, requiredComponents: ['daemon'],
  });
  if (inspection.snapshot) return { ...inspection.snapshot, producerStackName: authority.producerStackName };
  if (mode === 'prefer') return null;
  throw new Error(inspection.errors[0] ?? `[runtime] producer ${authority.producerStackName} has no native daemon runtime snapshot for ${process.platform}/${process.arch}. Build it through the repository producer with --daemon.`);
}

export async function resolveStackRuntimeLaunchContext({ argv = [], env = process.env, activeRuntimeState = null, target, requiredComponents } = {}) {
  const stackName = (env.HAPPIER_STACK_STACK ?? '').toString().trim() || getStackName(env);
  const { baseDir: stackBaseDir } = resolveStackBaseDir(stackName, env);
  const runtimeMode = resolveStackRuntimeMode({ argv, env, activeRuntimeState });
  const components = requiredComponents ?? (argv.includes('--no-daemon') && argv.includes('--no-ui') ? ['server'] : undefined);
  const snapshot = env.HAPPIER_STACK_SHARED_DB_SOURCE_STACK && components === undefined
    ? await resolveNativeDaemonRuntimeSnapshot({ stackName, env, mode: runtimeMode.mode })
    : await resolveActiveRuntimeSnapshot({ mode: runtimeMode.mode, stackBaseDir, target, env, requiredComponents: components });

  return {
    stackName,
    stackBaseDir,
    runtimeMode,
    snapshot,
  };
}
