import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(packageRoot, '../..');
const siblingArgument = process.argv[2];

function run(command, args, cwd, env = process.env) {
  return spawnSync(command, args, {
    cwd,
    env,
    stdio: 'inherit',
  });
}

function runLocalCanonicalWriterContract() {
  const serverRoot = resolve(repoRoot, 'apps/server');
  const vitestEntrypoint = resolve(repoRoot, 'node_modules/vitest/vitest.mjs');
  const remoteProtocolOwner = resolve(
    repoRoot,
    'packages/protocol/src/sessionRuntimeActivity/projection.ts',
  );
  const devProtocolOwner = resolve(
    repoRoot,
    'packages/protocol/src/sessions/runtime/activity/sessionRuntimeActivity.ts',
  );
  const remoteOwnerTest = resolve(
    serverRoot,
    'sources/app/session/runtimeActivity/writeProjection.sqlite.integration.spec.ts',
  );
  const devOwnerTest = resolve(serverRoot, 'sources/app/session/sessionWriteService.spec.ts');
  const hasRemoteTopology = existsSync(remoteProtocolOwner);
  const hasDevTopology = existsSync(devProtocolOwner);

  if (hasRemoteTopology === hasDevTopology) {
    throw new Error('Runtime Activity topology is missing or ambiguous');
  }

  if (hasRemoteTopology) {
    if (!existsSync(remoteOwnerTest)) {
      throw new Error(`Remote canonical Runtime Activity writer contract is missing: ${remoteOwnerTest}`);
    }
    return run(process.execPath, [
      vitestEntrypoint,
      'run',
      '--isolate',
      '-c',
      resolve(serverRoot, 'vitest.integration.config.ts'),
      remoteOwnerTest,
    ], serverRoot);
  }
  if (!existsSync(devOwnerTest)) {
    throw new Error(`Dev canonical Runtime Activity writer contract is missing: ${devOwnerTest}`);
  }
  if (hasDevTopology) {
    return run(process.execPath, [
      vitestEntrypoint,
      'run',
      '--isolate',
      '-c',
      resolve(serverRoot, 'vitest.config.ts'),
      devOwnerTest,
    ], serverRoot);
  }
  throw new Error('Unreachable Runtime Activity topology selection');
}

if (!siblingArgument) {
  console.error('Usage: yarn test:contracts:runtime-activity <sibling-checkout-path>');
  process.exitCode = 2;
} else {
  const siblingCheckout = resolve(repoRoot, siblingArgument);
  const siblingFixture = resolve(
    siblingCheckout,
    'packages/tests/fixtures/runtime-activity/projection-v1.json',
  );

  if (!existsSync(siblingFixture)) {
    console.error(`Sibling Runtime Activity fixture not found: ${siblingFixture}`);
    process.exitCode = 2;
  } else {
    const result = run(process.execPath, [
      resolve(packageRoot, 'scripts/run-vitest-with-heartbeat.mjs'),
      '--config',
      resolve(packageRoot, 'vitest.core.config.ts'),
      resolve(packageRoot, 'suites/contracts/runtimeActivityProjection.test.ts'),
    ], packageRoot, {
      ...process.env,
      HAPPIER_RUNTIME_ACTIVITY_PARITY_SIBLING: siblingCheckout,
    });

    if (result.status !== 0) {
      process.exitCode = result.status ?? 1;
    } else {
      const writerResult = runLocalCanonicalWriterContract();
      process.exitCode = writerResult.status ?? 1;
    }
  }
}
