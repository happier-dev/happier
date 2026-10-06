import './utils/env/env.mjs';
import { parseArgs } from './utils/cli/args.mjs';
import { printResult, wantsHelp, wantsJson } from './utils/cli/cli.mjs';
import { getRootDir } from './utils/paths/paths.mjs';
import { selectActiveProducerRuntimeSnapshot } from './build/activate_runtime_snapshot.mjs';
import { resolveRuntimeBuildAuthority } from './runtime/shared/runtime_build_authority.mjs';
import { resolveControlledRuntimePlacement } from './utils/dev_targets/service_placement.mjs';
import { assertRuntimeSnapshotId } from './runtime/shared/runtime_paths.mjs';

function assertNamedStack(env) {
  const stackName = String(env.HAPPIER_STACK_STACK ?? '').trim() || 'main';
  if (stackName === 'main') {
    throw new Error('[runtime] selecting a producer runtime snapshot is supported for named stacks only in v1.');
  }
  return stackName;
}

async function main() {
  const argv = process.argv.slice(2);
  const { flags, kv } = parseArgs(argv);
  const json = wantsJson(argv, { flags });
  if (wantsHelp(argv, { flags })) {
    printResult({
      json,
      data: { json: true },
      text: [
        '[runtime] usage:',
        '  hstack stack runtime <name> select [--snapshot=<id>] [--server] [--json]',
        '',
        'note:',
        '  Selects the newest complete snapshot for this stack\'s execution target, or the exact requested pin.',
        '  It does not build, publish, activate, or otherwise mutate that producer or this stack\'s launch mode.',
      ].join('\n'),
    });
    return;
  }

  const rootDir = getRootDir(import.meta.url);
  const stackName = assertNamedStack(process.env);
  const authority = resolveRuntimeBuildAuthority({
    rootDir,
    consumerStackName: stackName,
    env: process.env,
    createRepoIdentityIfMissing: false,
  });
  const placement = await resolveControlledRuntimePlacement({
    stackName, stackBaseDir: authority.consumerStackBaseDir, sourceDir: authority.repoDir, env: process.env,
  });
  const selectedRuntime = await selectActiveProducerRuntimeSnapshot({
    consumerStackBaseDir: authority.consumerStackBaseDir,
    producerStackBaseDir: authority.producerStackBaseDir,
    producerStackName: authority.producerStackName,
    consumerStackName: authority.consumerStackName,
    target: placement.runtimeTarget,
    requiredComponents: flags.has('--server') || process.env.HAPPIER_STACK_SHARED_DB_SOURCE_STACK ? ['server'] : undefined,
    snapshotId: kv.has('--snapshot') ? assertRuntimeSnapshotId(kv.get('--snapshot')) : '',
  });

  printResult({
    json,
    data: {
      ok: true,
      stackName: authority.consumerStackName,
      consumerStackName: authority.consumerStackName,
      producerStackName: selectedRuntime.producerStackName ?? authority.producerStackName,
      snapshotId: selectedRuntime.snapshotId,
      snapshotPath: selectedRuntime.snapshotPath,
      currentPath: selectedRuntime.currentPath,
      reused: true,
      selected: true,
    },
    text: [
      `[runtime] selected ${authority.consumerStackName}`,
      `[runtime] producer: ${selectedRuntime.producerStackName ?? authority.producerStackName}`,
      `[runtime] snapshot: ${selectedRuntime.snapshotPath}`,
    ].join('\n'),
  });
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error('[runtime] failed:', message);
  if (process.env.DEBUG && error instanceof Error && error.stack) {
    console.error(error.stack);
  }
  process.exit(1);
});
