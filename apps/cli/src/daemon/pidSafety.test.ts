import { describe, expect, it, vi } from 'vitest';

import { classifyHappyProcess } from './doctor';
import { hashProcessCommand } from './sessionRegistry';
import { isPidSafeHappySessionProcess } from './pidSafety';

describe('isPidSafeHappySessionProcess', () => {
  it.each([
    ['missing identity', {}],
    ['invalid process birth without a legacy hash', {
      expectedProcessStartTimeMs: Number.POSITIVE_INFINITY,
    }],
  ])('fails closed before process inspection for %s', async (_label, witness) => {
    const findHappyProcessByPidFn = vi.fn(async () => ({
      pid: 54_321,
      command: 'happier session',
      type: 'daemon-spawned-session',
    } as const));
    const readProcessIdentityByPidFn = vi.fn();

    await expect(isPidSafeHappySessionProcess({
      pid: 54_321,
      ...witness,
    }, {
      findHappyProcessByPidFn,
      readProcessIdentityByPidFn,
    })).resolves.toBe(false);

    expect(findHappyProcessByPidFn).not.toHaveBeenCalled();
    expect(readProcessIdentityByPidFn).not.toHaveBeenCalled();
  });

  it('uses exact process generation as the final safety linearization point', async () => {
    const pid = 54_321;
    const originalCommand =
      'happier session --existing-session sess-exact-process';
    const currentIdentity = {
      pid,
      processStartTimeMs: 2_000,
      command: 'happier session --existing-session sess-reused-process',
    };
    const findHappyProcessByPidFn = vi.fn();
    const readProcessIdentityByPidFn = vi.fn(
      async () => currentIdentity,
    );

    await expect(isPidSafeHappySessionProcess({
      pid,
      expectedProcessStartTimeMs: 1_000,
      expectedProcessCommandHash:
        hashProcessCommand(originalCommand),
    }, {
      findHappyProcessByPidFn,
      readProcessIdentityByPidFn,
    })).resolves.toBe(false);

    expect(findHappyProcessByPidFn).not.toHaveBeenCalled();
    expect(readProcessIdentityByPidFn).toHaveBeenCalledOnce();
  });

  it('keeps a copied source-snapshot runner only while its exact process start identity matches', async () => {
    const pid = 64_476;
    const command = [
      '/usr/local/bin/node',
      '--preserve-symlinks',
      '--preserve-symlinks-main',
      '--import',
      '/repo/node_modules/tsx/dist/esm/index.mjs',
      '--no-warnings',
      '--no-deprecation',
      '/repo/.project/tmp/cli-source-snapshot-source-51405-1785848300000-1/src/index.ts',
      'pi',
      '--happy-starting-mode',
      'remote',
      '--started-by',
      'daemon',
      '--existing-session',
      'sess-copied-source',
    ].join(' ');
    const classified = classifyHappyProcess({
      pid,
      name: '/usr/local/bin/node',
      cmd: command,
    });
    const findHappyProcessByPidFn = vi.fn(async () => classified);
    const currentProcessStartTimeMs = 1_785_848_500_000;
    let observedProcessStartTimeMs = currentProcessStartTimeMs;
    let observedCommand = command;
    const readProcessIdentityByPidFn = vi.fn(async () => ({
      pid,
      processStartTimeMs: observedProcessStartTimeMs,
      command: observedCommand,
    }));
    const witness = {
      pid,
      expectedProcessStartTimeMs: currentProcessStartTimeMs,
      expectedProcessCommandHash: hashProcessCommand(command),
    };
    const dependencies = {
      findHappyProcessByPidFn,
      readProcessIdentityByPidFn,
    };

    await expect(
      isPidSafeHappySessionProcess(witness, dependencies),
    ).resolves.toBe(true);

    observedProcessStartTimeMs += 1_000;
    await expect(
      isPidSafeHappySessionProcess(witness, dependencies),
    ).resolves.toBe(false);

    observedProcessStartTimeMs = currentProcessStartTimeMs;
    observedCommand = `${command} --same-process-command-drift`;
    await expect(
      isPidSafeHappySessionProcess(witness, dependencies),
    ).resolves.toBe(true);
  });

  it('keeps strict command classification and matching for legacy records without process birth', async () => {
    const pid = 42;
    const command = 'happier session --existing-session sess-legacy';
    const findHappyProcessByPidFn = vi.fn(async () => ({
      pid,
      command,
      type: 'user-session',
    }));

    await expect(isPidSafeHappySessionProcess({
      pid,
      expectedProcessCommandHash: hashProcessCommand(command),
    }, { findHappyProcessByPidFn })).resolves.toBe(true);
    await expect(isPidSafeHappySessionProcess({
      pid,
      expectedProcessCommandHash: hashProcessCommand('different command'),
    }, { findHappyProcessByPidFn })).resolves.toBe(false);
  });
});
