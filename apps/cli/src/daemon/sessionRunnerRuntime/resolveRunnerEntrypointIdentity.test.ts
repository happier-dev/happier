import { describe, expect, it } from 'vitest';

import {
  resolveEntrypointIdentityFromLaunchSpec,
  resolveSessionRunnerEntrypointIdentityFromProcessCommand,
} from './resolveRunnerEntrypointIdentity';

describe('runner entrypoint identity', () => {
  it('recognizes the source-runtime CLI entrypoint used by source QA launches', () => {
    const entrypoint = '/work/source-runtime/bundle-qa/apps/cli/src/index.mjs';
    expect(resolveSessionRunnerEntrypointIdentityFromProcessCommand(
      `node ${entrypoint} claude`,
    )).toMatchObject({ status: 'known', comparableId: 'path:/work/source-runtime/bundle-qa/apps/cli' });
    expect(resolveEntrypointIdentityFromLaunchSpec({
      runtime: 'node', filePath: '/usr/bin/node', args: [entrypoint, 'claude'],
    })).toMatchObject({ status: 'known', comparableId: 'path:/work/source-runtime/bundle-qa/apps/cli' });
    expect(resolveSessionRunnerEntrypointIdentityFromProcessCommand(
      'node "C:\\QA Stack\\source-runtime\\bundle-qa\\apps\\cli\\src\\index.mjs" claude',
    )).toMatchObject({ status: 'known', comparableId: 'path:c:/qa stack/source-runtime/bundle-qa/apps/cli' });
    expect(resolveSessionRunnerEntrypointIdentityFromProcessCommand(
      'node /work/source-runtime/current/apps/cli/src/index.mjs claude',
    )).toMatchObject({ status: 'unknown', reason: 'mutable_entrypoint_pointer' });
  });
  it('attests runner snapshots by their immutable fingerprint', () => {
    expect(resolveSessionRunnerEntrypointIdentityFromProcessCommand(
      'node /work/apps/cli/.runner-snapshots/2ee2ef1b2f776a89/index.mjs claude --happy-starting-mode remote',
    )).toMatchObject({
      status: 'known',
      source: 'process_command',
      comparableId: 'snapshot:2ee2ef1b2f776a89',
      entrypointVersion: null,
    });

    expect(resolveEntrypointIdentityFromLaunchSpec({
      runtime: 'node',
      filePath: '/usr/local/bin/node',
      args: ['/work/apps/cli/.runner-snapshots/30bb29f6afae521d/index.mjs'],
    })).toMatchObject({
      status: 'known',
      source: 'launch_spec',
      comparableId: 'snapshot:30bb29f6afae521d',
    });
  });

  it('attests canonical package-dist snapshots while retaining live flat snapshot identity', () => {
    const runtimeAssetSha256 = 'a'.repeat(64);
    expect(resolveSessionRunnerEntrypointIdentityFromProcessCommand(
      `node /work/apps/cli/.runner-snapshots/30bb29f6afae521d-${runtimeAssetSha256}-package-dist-v2/package-dist/index.mjs claude`,
    )).toMatchObject({
      status: 'known',
      source: 'process_command',
      comparableId: `snapshot:30bb29f6afae521d-${runtimeAssetSha256}-package-dist-v2`,
      entrypointVersion: null,
    });

    expect(resolveSessionRunnerEntrypointIdentityFromProcessCommand(
      'node /work/apps/cli/.runner-snapshots/2ee2ef1b2f776a89-package-dist-v1/package-dist/index.mjs claude',
    )).toMatchObject({
      status: 'known',
      source: 'process_command',
      comparableId: 'snapshot:2ee2ef1b2f776a89-package-dist-v1',
      entrypointVersion: null,
    });

    expect(resolveSessionRunnerEntrypointIdentityFromProcessCommand(
      'node /work/apps/cli/.runner-snapshots/2ee2ef1b2f776a89/index.mjs claude',
    )).toMatchObject({
      status: 'known',
      comparableId: 'snapshot:2ee2ef1b2f776a89',
    });
  });

  it('preserves case for POSIX runtime roots but normalizes Windows runtime roots', () => {
    expect(resolveSessionRunnerEntrypointIdentityFromProcessCommand(
      'node /Work/Happier/apps/cli/src/index.ts daemon start-sync',
    )).toMatchObject({
      status: 'known',
      comparableId: 'path:/Work/Happier/apps/cli',
    });

    expect(resolveSessionRunnerEntrypointIdentityFromProcessCommand(
      'node C:\\Users\\Alice\\Happier\\apps\\cli\\src\\index.ts daemon start-sync',
    )).toMatchObject({
      status: 'known',
      comparableId: 'path:c:/users/alice/happier/apps/cli',
    });

    expect(resolveSessionRunnerEntrypointIdentityFromProcessCommand(
      'node \\\\Server\\Share\\Happier\\apps\\cli\\dist\\index.mjs daemon start-sync',
    )).toMatchObject({
      status: 'known',
      comparableId: 'path://server/share/happier/apps/cli',
    });
  });
});
