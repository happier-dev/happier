import { describe, expect, it, vi } from 'vitest';

import { createPluginInstallationReviewFixture } from '@/plugins/testkit/pluginInstallationReviewFixture';

import {
  DaemonPluginChangePreparationError,
  createDaemonPluginChangeService,
} from './changeService';

describe('createDaemonPluginChangeService', () => {
  it('preserves a daemon-owner preparation denial code', async () => {
    const service = createDaemonPluginChangeService({
      prepare: async () => {
        throw new DaemonPluginChangePreparationError(
          'plugin_update_pinned',
          'Pinned plugin channels cannot advance',
        );
      },
    });

    await expect(service.requestPluginChange({
      kind: 'update',
      pluginId: 'acme.example',
    })).resolves.toEqual({
      kind: 'failed',
      code: 'plugin_update_pinned',
      message: 'Pinned plugin channels cannot advance',
    });
  });

  it('keeps review state ephemeral and applies a candidate at most once', async () => {
    const apply = vi.fn(async () => ({
      kind: 'committed' as const,
      pluginId: 'acme.example',
      desiredGeneration: 'generation-1',
      appliedGeneration: 'generation-1',
      pendingSurfaces: [],
    }));
    const cleanup = vi.fn(async () => undefined);
    const service = createDaemonPluginChangeService({
      prepare: vi.fn(async () => ({
        pluginId: 'acme.example',
        review: createPluginInstallationReviewFixture(),
        apply,
        cleanup,
      })),
      createPendingChangeId: () => 'pending-1',
      nowMs: () => 100,
    });

    const begun = await service.requestPluginChange({
      kind: 'installPath',
      locator: '/tmp/example',
      development: false,
    });
    expect(begun).toEqual({
      kind: 'reviewRequired',
      pendingChangeId: 'pending-1',
      review: expect.objectContaining({ pluginId: 'acme.example' }),
    });

    const decision = {
      pendingChangeId: 'pending-1',
      decision: 'installAndTrust' as const,
      actorEvidence: {
        kind: 'authenticatedLocalUser' as const,
        interactionId: 'interaction-1',
        occurredAtMs: 101,
      },
      optionalSelections: [],
    };
    const [first, duplicate] = await Promise.all([
      service.decidePluginChange(decision),
      service.decidePluginChange(decision),
    ]);

    expect(first).toEqual(expect.objectContaining({ kind: 'committed' }));
    expect(duplicate).toEqual(first);
    expect(apply).toHaveBeenCalledTimes(1);
    expect(cleanup).toHaveBeenCalledTimes(1);
    await expect(service.decidePluginChange(decision)).resolves.toEqual({ kind: 'expired' });
  });

  it('does not queue a second pending confirmation for the same plugin', async () => {
    const cleanupFirst = vi.fn(async () => undefined);
    const cleanupSecond = vi.fn(async () => undefined);
    let prepareCount = 0;
    const service = createDaemonPluginChangeService({
      prepare: async () => {
        prepareCount += 1;
        return {
          pluginId: 'acme.example',
          review: createPluginInstallationReviewFixture({
            pluginId: 'acme.example',
            displayName: 'Example',
            source: { kind: 'path', locator: `/tmp/example-${prepareCount}` },
            updateChannel: { kind: 'path', locator: `/tmp/example-${prepareCount}`, development: false },
          }),
          apply: async () => ({
            kind: 'committed' as const,
            pluginId: 'acme.example',
            desiredGeneration: 'generation-1',
            appliedGeneration: 'generation-1',
            pendingSurfaces: [],
          }),
          cleanup: prepareCount === 1 ? cleanupFirst : cleanupSecond,
        };
      },
      createPendingChangeId: () => `pending-${prepareCount}`,
    });

    await expect(service.requestPluginChange({ kind: 'installPath', locator: '/tmp/one', development: false }))
      .resolves.toEqual(expect.objectContaining({ kind: 'reviewRequired' }));
    await expect(service.requestPluginChange({ kind: 'installPath', locator: '/tmp/two', development: false }))
      .resolves.toEqual({ kind: 'busy', pluginId: 'acme.example' });
    expect(cleanupFirst).not.toHaveBeenCalled();
    expect(cleanupSecond).toHaveBeenCalledTimes(1);

    await service.shutdown();
    expect(cleanupFirst).toHaveBeenCalledTimes(1);
  });

  it('does not globally serialize preparation, apply, or cleanup for different plugins', async () => {
    const events: string[] = [];
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let prepareCount = 0;
    const service = createDaemonPluginChangeService({
      prepare: async () => {
        prepareCount += 1;
        const suffix = prepareCount;
        events.push(`prepare-${suffix}`);
        return {
          pluginId: `acme.plugin-${suffix}`,
          review: createPluginInstallationReviewFixture({
            pluginId: `acme.plugin-${suffix}`,
            displayName: `Plugin ${suffix}`,
            source: { kind: 'path', locator: `/tmp/plugin-${suffix}` },
            updateChannel: { kind: 'path', locator: `/tmp/plugin-${suffix}`, development: false },
          }),
          apply: async () => {
            events.push(`apply-${suffix}`);
            if (suffix === 1) await firstBlocked;
            return {
              kind: 'committed' as const,
              pluginId: `acme.plugin-${suffix}`,
              desiredGeneration: `generation-${suffix}`,
              appliedGeneration: `generation-${suffix}`,
              pendingSurfaces: [],
            };
          },
          cleanup: async () => { events.push(`cleanup-${suffix}`); },
        };
      },
      createPendingChangeId: () => `pending-${prepareCount}`,
    });

    const first = await service.requestPluginChange({ kind: 'installPath', locator: '/tmp/one', development: false });
    const second = await service.requestPluginChange({ kind: 'installPath', locator: '/tmp/two', development: false });
    if (first.kind !== 'reviewRequired' || second.kind !== 'reviewRequired') throw new Error('Expected reviews');

    const decidingFirst = service.decidePluginChange({
      pendingChangeId: first.pendingChangeId,
      decision: 'installAndTrust',
      actorEvidence: { kind: 'authenticatedLocalUser', interactionId: 'one', occurredAtMs: 1 },
    });
    await vi.waitFor(() => expect(events).toContain('apply-1'));
    const decidingSecond = service.decidePluginChange({
      pendingChangeId: second.pendingChangeId,
      decision: 'installAndTrust',
      actorEvidence: { kind: 'authenticatedLocalUser', interactionId: 'two', occurredAtMs: 2 },
    });
    await vi.waitFor(() => expect(events).toContain('apply-2'));
    releaseFirst();
    await Promise.all([decidingFirst, decidingSecond]);

    expect(events.indexOf('prepare-2')).toBeLessThan(events.indexOf('apply-1'));
    expect(events.indexOf('cleanup-2')).toBeGreaterThan(events.indexOf('apply-2'));
  });

  it('removes expired review state without making an unrelated plugin wait for candidate cleanup', async () => {
    let nowMs = 0;
    let releaseExpiredCleanup!: () => void;
    const expiredCleanupBlocked = new Promise<void>((resolve) => { releaseExpiredCleanup = resolve; });
    const prepare = vi.fn(async (request: Readonly<{ locator?: string }>) => {
      const first = request.locator === '/tmp/expired';
      const pluginId = first ? 'acme.expired' : 'acme.ready';
      return {
        pluginId,
        review: createPluginInstallationReviewFixture({
          pluginId,
          displayName: pluginId,
          source: { kind: 'path', locator: request.locator ?? '/tmp/unknown' },
          updateChannel: {
            kind: 'path',
            locator: request.locator ?? '/tmp/unknown',
            development: false,
          },
        }),
        apply: async () => ({
          kind: 'committed' as const,
          pluginId,
          desiredGeneration: 'generation-1',
          appliedGeneration: 'generation-1',
          pendingSurfaces: [],
        }),
        cleanup: async () => {
          if (first) await expiredCleanupBlocked;
        },
      };
    });
    const service = createDaemonPluginChangeService({
      prepare: prepare as Parameters<typeof createDaemonPluginChangeService>[0]['prepare'],
      nowMs: () => nowMs,
      createPendingChangeId: () => `pending-${prepare.mock.calls.length}`,
    });

    await expect(service.requestPluginChange({
      kind: 'installPath',
      locator: '/tmp/expired',
      development: false,
    })).resolves.toEqual(expect.objectContaining({ kind: 'reviewRequired' }));

    nowMs = 11 * 60_000;
    const unrelated = service.requestPluginChange({
      kind: 'installPath',
      locator: '/tmp/ready',
      development: false,
    });

    await vi.waitFor(() => expect(prepare).toHaveBeenCalledTimes(2));
    await expect(unrelated).resolves.toEqual(expect.objectContaining({
      kind: 'reviewRequired',
      review: expect.objectContaining({ pluginId: 'acme.ready' }),
    }));

    releaseExpiredCleanup();
    await service.shutdown();
  });

  it('releases same-plugin exclusivity after adoption before slow retirement work finishes', async () => {
    let finishRetirement!: () => void;
    const retirementBlocked = new Promise<void>((resolve) => { finishRetirement = resolve; });
    const events: string[] = [];
    let prepareCount = 0;
    const service = createDaemonPluginChangeService({
      prepare: async () => {
        prepareCount += 1;
        const generation = prepareCount;
        return {
          pluginId: 'acme.example',
          requiresReview: false,
          apply: async (
            _decision: unknown,
            control?: Readonly<{ onApplied: () => void }>,
          ) => {
            events.push(`apply-${generation}`);
            control?.onApplied();
            events.push(`adopted-${generation}`);
            if (generation === 1) await retirementBlocked;
            events.push(`retired-${generation}`);
            return {
              kind: 'committed' as const,
              pluginId: 'acme.example',
              desiredGeneration: `generation-${generation}`,
              appliedGeneration: `generation-${generation}`,
              pendingSurfaces: [],
            };
          },
          cleanup: async () => undefined,
        };
      },
    });

    const first = service.requestPluginChange({
      kind: 'development',
      pluginId: 'acme.example',
      sourceRootPath: '/tmp/example',
    });
    await vi.waitFor(() => expect(events).toContain('adopted-1'));

    const second = service.requestPluginChange({
      kind: 'development',
      pluginId: 'acme.example',
      sourceRootPath: '/tmp/example',
    });
    await vi.waitFor(() => expect(events).toContain('apply-2'));
    await expect(second).resolves.toEqual(expect.objectContaining({
      kind: 'committed',
      desiredGeneration: 'generation-2',
    }));

    finishRetirement();
    await expect(first).resolves.toEqual(expect.objectContaining({
      kind: 'committed',
      desiredGeneration: 'generation-1',
    }));
  });

  it('shares per-plugin apply exclusion with automatic currentness changes without blocking other plugins', async () => {
    let userApplyEntered!: () => void;
    const userApplyStarted = new Promise<void>((resolve) => { userApplyEntered = resolve; });
    let releaseUserApply!: () => void;
    const userApplyBlocked = new Promise<void>((resolve) => { releaseUserApply = resolve; });
    const service = createDaemonPluginChangeService({
      prepare: async () => ({
        pluginId: 'acme.example',
        requiresReview: false,
        apply: async (_decision, control) => {
          userApplyEntered();
          await userApplyBlocked;
          control?.onApplied();
          return {
            kind: 'committed' as const,
            pluginId: 'acme.example',
            desiredGeneration: 'generation-1',
            appliedGeneration: 'generation-1',
            pendingSurfaces: [],
          };
        },
        cleanup: async () => undefined,
      }),
    });

    const userApply = service.requestPluginChange({
      kind: 'development',
      pluginId: 'acme.example',
      sourceRootPath: '/tmp/example',
    });
    await userApplyStarted;

    let samePluginEntered = false;
    const samePluginRecovery = service.runAutomaticCurrentnessChange('acme.example', async () => {
      samePluginEntered = true;
    });
    await service.runAutomaticCurrentnessChange('acme.other', async () => undefined);
    expect(samePluginEntered).toBe(false);

    releaseUserApply();
    await Promise.all([userApply, samePluginRecovery]);
    expect(samePluginEntered).toBe(true);
    await service.shutdown();
  });

  it('rejects new changes during handoff and waits for the in-flight apply adoption boundary', async () => {
    let applyEntered!: () => void;
    const applyStarted = new Promise<void>((resolve) => {
      applyEntered = resolve;
    });
    let finishApply!: () => void;
    const applyBlocked = new Promise<void>((resolve) => {
      finishApply = resolve;
    });
    const prepare = vi.fn(async () => ({
      pluginId: 'acme.example',
      requiresReview: false as const,
      apply: async (
        _decision: unknown,
        control?: Readonly<{ onApplied: () => void }>,
      ) => {
        applyEntered();
        await applyBlocked;
        control?.onApplied();
        return {
          kind: 'committed' as const,
          pluginId: 'acme.example',
          desiredGeneration: 'generation-1',
          appliedGeneration: 'generation-1',
          pendingSurfaces: [],
        };
      },
      cleanup: async () => undefined,
    }));
    const service = createDaemonPluginChangeService({ prepare });

    const applying = service.requestPluginChange({
      kind: 'development',
      pluginId: 'acme.example',
      sourceRootPath: '/tmp/example',
    });
    await applyStarted;

    let quiesced = false;
    const quiescing = service.quiesceForHandoff().then((lease) => {
      quiesced = true;
      return lease;
    });
    expect(service.isQuiescing()).toBe(true);
    await expect(service.requestPluginChange({
      kind: 'development',
      pluginId: 'acme.second',
      sourceRootPath: '/tmp/second',
    })).resolves.toEqual({
      kind: 'unavailable',
      code: 'daemon_shutting_down',
    });
    expect(prepare).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    expect(quiesced).toBe(false);

    finishApply();
    const lease = await quiescing;
    expect(quiesced).toBe(true);
    await applying;

    lease.resume();
    expect(service.isQuiescing()).toBe(false);
    await expect(service.requestPluginChange({
      kind: 'development',
      pluginId: 'acme.example',
      sourceRootPath: '/tmp/example',
    })).resolves.toEqual(expect.objectContaining({ kind: 'committed' }));
    expect(prepare).toHaveBeenCalledTimes(2);
    await service.shutdown();
  });

  it('waits for in-flight candidate preparation and cleanup before completing handoff', async () => {
    let markPreparationStarted!: () => void;
    const preparationStarted = new Promise<void>((resolve) => {
      markPreparationStarted = resolve;
    });
    let finishPreparation!: () => void;
    const preparationBlocked = new Promise<void>((resolve) => {
      finishPreparation = resolve;
    });
    const cleanup = vi.fn(async () => undefined);
    const service = createDaemonPluginChangeService({
      prepare: async () => {
        markPreparationStarted();
        await preparationBlocked;
        return {
          pluginId: 'acme.preparing',
          requiresReview: false as const,
          apply: async () => ({
            kind: 'committed' as const,
            pluginId: 'acme.preparing',
            desiredGeneration: 'generation-1',
            appliedGeneration: 'generation-1',
            pendingSurfaces: [],
          }),
          cleanup,
        };
      },
    });

    const request = service.requestPluginChange({
      kind: 'development',
      pluginId: 'acme.preparing',
      sourceRootPath: '/tmp/preparing',
    });
    await preparationStarted;

    let quiesced = false;
    const quiescing = service.quiesceForHandoff().then((lease) => {
      quiesced = true;
      return lease;
    });
    const settledBeforePreparation = await Promise.race([
      quiescing.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 20)),
    ]);
    expect(settledBeforePreparation).toBe(false);
    expect(quiesced).toBe(false);

    finishPreparation();
    const lease = await quiescing;
    await expect(request).resolves.toEqual({
      kind: 'unavailable',
      code: 'daemon_shutting_down',
    });
    expect(cleanup).toHaveBeenCalledOnce();
    lease.resume();
    await service.shutdown();
  });

  it('counts concurrent candidate preparations against pending confirmation capacity', async () => {
    let releasePreparations!: () => void;
    const preparationsBlocked = new Promise<void>((resolve) => {
      releasePreparations = resolve;
    });
    let prepareCount = 0;
    const service = createDaemonPluginChangeService({
      prepare: async () => {
        prepareCount += 1;
        const suffix = prepareCount;
        if (suffix <= 64) await preparationsBlocked;
        const pluginId = `acme.capacity-${suffix}`;
        return {
          pluginId,
          review: createPluginInstallationReviewFixture({
            pluginId,
            displayName: pluginId,
            source: { kind: 'path', locator: `/tmp/${pluginId}` },
            updateChannel: { kind: 'path', locator: `/tmp/${pluginId}`, development: false },
          }),
          apply: async () => ({
            kind: 'committed' as const,
            pluginId,
            desiredGeneration: `generation-${suffix}`,
            appliedGeneration: `generation-${suffix}`,
            pendingSurfaces: [],
          }),
          cleanup: async () => undefined,
        };
      },
      createPendingChangeId: () => `pending-${prepareCount}`,
    });

    const admitted = Array.from({ length: 64 }, (_, index) => (
      service.requestPluginChange({
        kind: 'installPath',
        locator: `/tmp/capacity-${index + 1}`,
        development: false,
      })
    ));
    await vi.waitFor(() => expect(prepareCount).toBe(64));

    await expect(service.requestPluginChange({
      kind: 'installPath',
      locator: '/tmp/capacity-overflow',
      development: false,
    })).resolves.toEqual({
      kind: 'unavailable',
      code: 'pending_confirmation_capacity',
    });
    expect(prepareCount).toBe(64);

    releasePreparations();
    await expect(Promise.all(admitted)).resolves.toHaveLength(64);
    await service.shutdown();
  });

  it('keeps admission quiesced until every concurrent handoff holder resumes', async () => {
    const prepare = vi.fn(async () => ({
      pluginId: 'acme.example',
      requiresReview: false as const,
      apply: async () => ({
        kind: 'committed' as const,
        pluginId: 'acme.example',
        desiredGeneration: 'generation-1',
        appliedGeneration: 'generation-1',
        pendingSurfaces: [],
      }),
      cleanup: async () => undefined,
    }));
    const service = createDaemonPluginChangeService({ prepare });

    const [first, second] = await Promise.all([
      service.quiesceForHandoff(),
      service.quiesceForHandoff(),
    ]);
    first.resume();
    expect(service.isQuiescing()).toBe(true);
    await expect(service.requestPluginChange({
      kind: 'development',
      pluginId: 'acme.example',
      sourceRootPath: '/tmp/example',
    })).resolves.toEqual({
      kind: 'unavailable',
      code: 'daemon_shutting_down',
    });
    expect(prepare).not.toHaveBeenCalled();

    second.resume();
    expect(service.isQuiescing()).toBe(false);
    await expect(service.requestPluginChange({
      kind: 'development',
      pluginId: 'acme.example',
      sourceRootPath: '/tmp/example',
    })).resolves.toEqual(expect.objectContaining({ kind: 'committed' }));
    await service.shutdown();
  });

  it('preserves committed currentness when temporary-candidate cleanup fails', async () => {
    const onCleanupFailure = vi.fn();
    const service = createDaemonPluginChangeService({
      prepare: async () => ({
        pluginId: 'acme.example',
        review: createPluginInstallationReviewFixture(),
        apply: async () => ({
          kind: 'committed' as const,
          pluginId: 'acme.example',
          desiredGeneration: 'generation-1',
          appliedGeneration: 'generation-1',
          pendingSurfaces: [],
        }),
        cleanup: async () => {
          throw new Error('temporary directory remained busy');
        },
      }),
      createPendingChangeId: () => 'pending-1',
      onCleanupFailure,
    });

    const begun = await service.requestPluginChange({
      kind: 'installPath',
      locator: '/tmp/example',
      development: false,
    });
    if (begun.kind !== 'reviewRequired') throw new Error('Expected review');

    await expect(service.decidePluginChange({
      pendingChangeId: begun.pendingChangeId,
      decision: 'installAndTrust',
      actorEvidence: {
        kind: 'authenticatedLocalUser',
        interactionId: 'interaction-1',
        occurredAtMs: 1,
      },
    })).resolves.toEqual({
      kind: 'committed',
      pluginId: 'acme.example',
      desiredGeneration: 'generation-1',
      appliedGeneration: 'generation-1',
      pendingSurfaces: ['temporaryCandidateCleanup'],
    });
    expect(onCleanupFailure).toHaveBeenCalledWith('acme.example', expect.any(Error));

    const retry = await service.requestPluginChange({
      kind: 'installPath',
      locator: '/tmp/example',
      development: false,
    });
    if (retry.kind !== 'reviewRequired') throw new Error('Expected a second review');
    await expect(service.decidePluginChange({
      pendingChangeId: retry.pendingChangeId,
      decision: 'installAndTrust',
      actorEvidence: {
        kind: 'authenticatedLocalUser',
        interactionId: 'interaction-2',
        occurredAtMs: 2,
      },
    })).resolves.toMatchObject({
      kind: 'committed',
      pluginId: 'acme.example',
      pendingSurfaces: ['temporaryCandidateCleanup'],
    });
    expect(onCleanupFailure).toHaveBeenCalledTimes(2);
    await service.shutdown();
  });

  it('preserves a specific committed-reconciliation failure message from apply', async () => {
    const service = createDaemonPluginChangeService({
      prepare: async () => ({
        pluginId: 'acme.example',
        requiresReview: false,
        apply: async () => {
          throw new Error(
            'Storage-pressure quarantine eviction cleanup remains pending: reconciliation: generationCleanup unavailable',
          );
        },
        cleanup: async () => undefined,
      }),
    });

    await expect(service.requestPluginChange({
      kind: 'development',
      pluginId: 'acme.example',
      sourceRootPath: '/tmp/example',
    })).resolves.toEqual({
      kind: 'failed',
      code: 'plugin_change_failed',
      message: 'Storage-pressure quarantine eviction cleanup remains pending: reconciliation: generationCleanup unavailable',
    });
  });

  it('bounds cancellation cleanup and reports a candidate that cannot be removed', async () => {
    const onCleanupFailure = vi.fn();
    const service = createDaemonPluginChangeService({
      prepare: async () => ({
        pluginId: 'acme.example',
        review: createPluginInstallationReviewFixture(),
        apply: async () => ({ kind: 'failed' as const, code: 'not_used' }),
        cleanup: async () => await new Promise<void>(() => undefined),
      }),
      createPendingChangeId: () => 'pending-1',
      cleanupTimeoutMs: 0,
      onCleanupFailure,
    });
    const begun = await service.requestPluginChange({
      kind: 'installPath',
      locator: '/tmp/example',
      development: false,
    });
    if (begun.kind !== 'reviewRequired') throw new Error('Expected review');

    await expect(service.decidePluginChange({
      pendingChangeId: begun.pendingChangeId,
      decision: 'cancel',
    })).resolves.toEqual({ kind: 'cancelled' });
    expect(onCleanupFailure).toHaveBeenCalledWith('acme.example', expect.objectContaining({
      message: expect.stringContaining('timed out'),
    }));
  });
});
