import { describe, expect, it, vi } from 'vitest';
import { FeaturesResponseSchema } from '@happier-dev/protocol';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpc';
import { readRpcErrorCode, RpcError } from '@happier-dev/protocol/rpcErrors';

import { createSessionHandoffCoordinator } from './sessionHandoffCoordinator';

const baseInput = {
  sessionId: 'session-1',
  sourceMachineId: 'source-machine',
  targetMachineId: 'target-machine',
  sessionStorageMode: 'persisted' as const,
};

function readyStart() {
  return {
    handoffId: 'handoff-1',
    status: { handoffId: 'handoff-1', status: 'ready_for_cutover', phase: 'staging_target', recoveryActions: [] },
    endpointCandidates: [],
    targetPath: '/workspace',
    handoffMetadataV2: { workspaceReplicationSourceRootPath: '/workspace' },
  };
}

function readyTarget() {
  return {
    handoffId: 'handoff-1',
    status: { handoffId: 'handoff-1', status: 'ready_for_cutover', phase: 'staging_target', recoveryActions: [] },
    remoteSessionId: 'remote-1',
    directSource: { kind: 'claudeConfig', configDir: '/target/.claude' },
    resume: {
      directory: '/target/workspace',
      agent: 'codex',
      resume: 'remote-1',
      transcriptStorage: 'persisted',
      approvedNewDirectoryCreation: true,
    },
  };
}

function createHarness(overrides: Partial<Parameters<typeof createSessionHandoffCoordinator>[0]> = {}) {
  const calls: string[] = [];
  const update = vi.fn();
  const port = {
    assertExistingStateSupported: async () => {
      const { resolveExistingSessionHandoffEligibilityThroughCatalog } = await import('@/backends/catalog');
      const eligibility = resolveExistingSessionHandoffEligibilityThroughCatalog({ flavor: 'claude', machineId: baseInput.sourceMachineId, claudeSessionId: 'native-1' });
      if (!eligibility.eligible) throw new Error(eligibility.reasonCode);
    },
    readServerFeatures: async () => FeaturesResponseSchema.parse({
      features: {
        sessions: { enabled: true, handoff: { enabled: true } },
        machines: { enabled: true, transfer: { enabled: true, directPeer: { enabled: false }, serverRouted: { enabled: true } } },
      },
      capabilities: {},
    }),
    directPeerAvailable: true,
    preferredTransportStrategies: ['direct_peer', 'server_routed_stream'] as const,
    probeTargetCapability: vi.fn(async () => ({ protocolVersion: 2 as const, atomicTargetResume: true, targetCleanup: true })),
    startSource: vi.fn(async () => { calls.push('start'); return readyStart(); }),
    prepareTarget: vi.fn(async () => { calls.push('prepare'); return readyTarget(); }),
    getTargetPrepareResult: vi.fn(async () => readyTarget()),
    resumeTarget: vi.fn(async () => { calls.push('resume'); return { handoffId: 'handoff-1', sessionId: 'session-1', disposition: 'started_for_handoff' as const }; }),
    confirmTarget: vi.fn(async () => { calls.push('confirm'); return readyTarget().status; }),
    bindTarget: vi.fn(async () => { calls.push('bind'); }),
    commitTarget: vi.fn(async () => { calls.push('commit'); return { handoffId: 'handoff-1', status: { ...readyTarget().status, status: 'completed' as const, phase: 'finalizing' as const } }; }),
    cleanupSource: vi.fn(async () => { calls.push('cleanup'); return { handoffId: 'handoff-1', status: { ...readyTarget().status, status: 'completed' as const, phase: 'finalizing' as const } }; }),
    abortTarget: vi.fn(async () => ({
      handoffId: 'handoff-1',
      status: { ...readyTarget().status, status: 'aborted' as const },
      targetCleanup: { status: 'not_owned' as const, reason: 'resume_not_attempted' as const },
    })),
    abortSource: vi.fn(async () => ({
      handoffId: 'handoff-1',
      status: { ...readyTarget().status, status: 'aborted' as const },
    })),
    wait: vi.fn(async () => undefined),
    ...overrides,
  };
  return { coordinator: createSessionHandoffCoordinator(port), port, calls, update };
}

describe('sessionHandoffCoordinator', () => {
  it('preserves a message-less capability refusal before source mutation', async () => {
    const { coordinator, calls } = createHarness({
      probeTargetCapability: async () => ({ ok: false, errorCode: RPC_ERROR_CODES.FORBIDDEN }),
    });
    const error = await coordinator.admit({ ...baseInput, stateTransfer: 'existing' }).catch((caught: unknown) => caught);

    expect(readRpcErrorCode(error)).toBe(RPC_ERROR_CODES.FORBIDDEN);
    expect(error).toMatchObject({ message: 'Session handoff failed' });
    expect(calls).toEqual([]);
  });

  it.each([
    { role: 'target', decoded: true, code: RPC_ERROR_CODES.FORBIDDEN },
    { role: 'source', decoded: true, code: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE },
    { role: 'target', decoded: false, code: RPC_ERROR_CODES.METHOD_NOT_FOUND },
  ] as const)('preserves capability refusal policy for $role ($code, decoded=$decoded)', async ({ role, decoded, code }) => {
    const capability = { protocolVersion: 2, atomicTargetResume: true, targetCleanup: true, existingState: true };
    const refusal = async () => {
      if (decoded) return { error: 'Capability request refused', errorCode: code };
      throw new RpcError('Capability request refused', code);
    };
    const { coordinator, calls } = createHarness({
      probeTargetCapability: role === 'target' ? refusal : async () => capability,
      probeSourceCapability: role === 'source' ? refusal : async () => capability,
    });
    const error = await coordinator.admit({ ...baseInput, stateTransfer: 'existing' }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect(readRpcErrorCode(error)).toBe(code === RPC_ERROR_CODES.METHOD_NOT_FOUND ? undefined : code);
    expect(calls).toEqual([]);
  });

  it('applies actual catalog admission before source mutation for unsupported existing-state Agents', async () => {
    const harness = createHarness({
      probeSourceCapability: async () => ({ protocolVersion: 2, atomicTargetResume: true, targetCleanup: true, existingState: true }),
      probeTargetCapability: async () => ({ protocolVersion: 2, atomicTargetResume: true, targetCleanup: true, existingState: true }),
      assertExistingStateSupported: async () => {
        const { resolveExistingSessionHandoffEligibilityThroughCatalog } = await import('@/backends/catalog');
        const eligibility = resolveExistingSessionHandoffEligibilityThroughCatalog({ flavor: 'opencode', machineId: baseInput.sourceMachineId, opencodeSessionId: 'native-1' });
        if (!eligibility.eligible) throw new Error(eligibility.reasonCode);
      },
    });
    await expect(harness.coordinator.admit({ ...baseInput, stateTransfer: 'existing' })).rejects.toThrow('existing_state_unsupported');
    expect(harness.calls).toEqual([]);
  });

  it('refuses existing state before source mutation unless both peers advertise support', async () => {
    for (const [sourceSupports, targetSupports] of [[false, true], [true, false], [undefined, true]]) {
      const harness = createHarness({
        probeSourceCapability: async () => ({ protocolVersion: 2, atomicTargetResume: true, targetCleanup: true, existingState: sourceSupports }),
        probeTargetCapability: async () => ({ protocolVersion: 2, atomicTargetResume: true, targetCleanup: true, existingState: targetSupports }),
      });
      await expect(harness.coordinator.admit({ ...baseInput, stateTransfer: 'existing' })).rejects.toThrow('existing');
      expect(harness.port.startSource).not.toHaveBeenCalled();
    }
  });

  it('uses existing state without a transfer carrier and preserves the atomic cutover sequence', async () => {
    const harness = createHarness({
      probeSourceCapability: async () => ({ protocolVersion: 2, atomicTargetResume: true, targetCleanup: true, existingState: true }),
      probeTargetCapability: async () => ({ protocolVersion: 2, atomicTargetResume: true, targetCleanup: true, existingState: true }),
      readServerFeatures: async () => FeaturesResponseSchema.parse({ features: { sessions: { enabled: true, handoff: { enabled: true } }, machines: { enabled: true, transfer: { enabled: false } } }, capabilities: {} }),
      directPeerAvailable: false,
    });
    const result = await (await harness.coordinator.admit({ ...baseInput, stateTransfer: 'existing' })).execute({ update: harness.update });
    expect(result).toMatchObject({ ok: true });
    expect(harness.port.startSource).toHaveBeenCalledWith(expect.objectContaining({ stateTransfer: 'existing' }));
    expect(harness.port.prepareTarget).toHaveBeenCalledWith(expect.objectContaining({ stateTransfer: 'existing' }));
    expect(harness.calls).toEqual(['start', 'prepare', 'resume', 'confirm', 'bind', 'commit', 'cleanup', 'bind']);
  });

  it('admits a local move only on a daemon that advertises same-machine lifecycle support', async () => {
    const input = { ...baseInput, targetMachineId: baseInput.sourceMachineId, targetPath: '/workspace/my-app' };
    const old = createHarness();
    await expect(old.coordinator.admit(input)).rejects.toThrow('same-machine');
    expect(old.port.startSource).not.toHaveBeenCalled();
    const local = createHarness({ probeTargetCapability: async () => ({ protocolVersion: 2, atomicTargetResume: true, targetCleanup: true, sameMachineHandoff: true }) });
    const result = await (await local.coordinator.admit(input)).execute({ update: local.update });
    expect(result).toMatchObject({ ok: true });
    expect(local.port.startSource).toHaveBeenCalledWith(expect.objectContaining({ targetPath: input.targetPath }));
  });

  it('cancels a same-machine handoff through a single daemon abort after source start', async () => {
    const controller = new AbortController();
    const local = createHarness({
      probeTargetCapability: async () => ({ protocolVersion: 2, atomicTargetResume: true, targetCleanup: true, sameMachineHandoff: true }),
      startSource: async () => { controller.abort(); return readyStart(); },
    });
    const admitted = await local.coordinator.admit({ ...baseInput, targetMachineId: baseInput.sourceMachineId, targetPath: '/workspace/my-app' });
    await expect(admitted.execute({ update: local.update, signal: controller.signal })).resolves.toEqual({ kind: 'cancelled' });
    expect(local.port.abortTarget).toHaveBeenCalledOnce();
    expect(local.port.abortSource).not.toHaveBeenCalled();
  });

  it('uses local bundle reuse when no machine-transfer carrier is enabled', async () => {
    const local = createHarness({
      probeTargetCapability: async () => ({ protocolVersion: 2, atomicTargetResume: true, targetCleanup: true, sameMachineHandoff: true }),
      readServerFeatures: async () => FeaturesResponseSchema.parse({ features: { sessions: { enabled: true, handoff: { enabled: true } }, machines: { enabled: true, transfer: { enabled: false } } }, capabilities: {} }),
      directPeerAvailable: false,
    });
    const result = await (await local.coordinator.admit({ ...baseInput, targetMachineId: baseInput.sourceMachineId, targetPath: '/workspace/my-app' })).execute({ update: local.update });
    expect(result).toMatchObject({ ok: true });
  });

  it('admits capability before source mutation and runs the complete existing primitive sequence', async () => {
    const { coordinator, port, calls, update } = createHarness();
    const admitted = await coordinator.admit(baseInput);
    expect(port.probeTargetCapability).toHaveBeenCalledOnce();
    expect(port.startSource).not.toHaveBeenCalled();

    const result = await admitted.execute({ update });
    expect(result).toEqual({ ok: true, result: expect.objectContaining({ handoffId: 'handoff-1' }) });
    expect(calls).toEqual(['start', 'prepare', 'resume', 'confirm', 'bind', 'commit', 'cleanup', 'bind']);
    expect(update).toHaveBeenCalledWith({ domainRef: { kind: 'handoff', id: 'handoff-1' } });
    const phases = update.mock.calls.flatMap(([value]) => value.progress?.kind === 'phase' ? [value.progress.phase] : []);
    expect(phases).toEqual([
      'starting_source', 'preparing_target', 'resuming_target', 'confirming_target',
      'binding_target', 'committing_target', 'cleaning_source', 'finalizing_target',
    ]);
  });

  it('uses the enabled relay when direct peer is preferred but disabled by the server', async () => {
    const { coordinator, port, update } = createHarness({ transportStrategy: 'direct_peer' });
    const result = await (await coordinator.admit(baseInput)).execute({ update });

    expect(result).toMatchObject({ ok: true });
    expect(port.startSource).toHaveBeenCalledWith(expect.objectContaining({
      negotiatedTransportStrategy: 'server_routed_stream',
    }));
    expect(port.prepareTarget).toHaveBeenCalledWith(expect.objectContaining({
      negotiatedTransportStrategy: 'server_routed_stream',
      allowServerRoutedFallback: true,
    }));
  });

  it.each([true, false])('allows direct-peer relay fallback only when enabled (%s)', async (relayEnabled) => {
    const { coordinator, port, update } = createHarness({
      readServerFeatures: async () => FeaturesResponseSchema.parse({
        features: {
          sessions: { enabled: true, handoff: { enabled: true } },
          machines: { enabled: true, transfer: { enabled: true, directPeer: { enabled: true }, serverRouted: { enabled: relayEnabled } } },
        },
        capabilities: {},
      }),
    });
    expect(await (await coordinator.admit(baseInput)).execute({ update })).toMatchObject({ ok: true });
    expect(port.startSource).toHaveBeenCalledWith(expect.objectContaining({
      preferredTransportStrategies: relayEnabled ? ['direct_peer', 'server_routed_stream'] : ['direct_peer'],
    }));
    expect(port.prepareTarget).toHaveBeenCalledWith(expect.objectContaining({
      negotiatedTransportStrategy: 'direct_peer',
      allowServerRoutedFallback: relayEnabled,
    }));
  });

  it('uses the relay when the source has no direct-peer transport', async () => {
    const { coordinator, port, update } = createHarness({
      directPeerAvailable: false,
      readServerFeatures: async () => FeaturesResponseSchema.parse({
        features: {
          sessions: { enabled: true, handoff: { enabled: true } },
          machines: { enabled: true, transfer: { enabled: true, directPeer: { enabled: true }, serverRouted: { enabled: true } } },
        },
        capabilities: {},
      }),
    });
    expect(await (await coordinator.admit(baseInput)).execute({ update })).toMatchObject({ ok: true });
    expect(port.startSource).toHaveBeenCalledWith(expect.objectContaining({
      negotiatedTransportStrategy: 'server_routed_stream',
    }));
  });

  it.each([
    [null, 'server_features_unavailable'],
    [FeaturesResponseSchema.parse({ features: {}, capabilities: {} }), 'handoff_disabled'],
    [
      FeaturesResponseSchema.parse({ features: { sessions: { enabled: true, handoff: { enabled: true } } }, capabilities: {} }),
      'transfer_disabled',
    ],
    [
      FeaturesResponseSchema.parse({
        features: {
          sessions: { enabled: true, handoff: { enabled: true } },
          machines: { enabled: true, transfer: { enabled: true, directPeer: { enabled: false }, serverRouted: { enabled: false } } },
        },
        capabilities: {},
      }),
      'server_routed_transfer_disabled',
    ],
  ] as const)('fails closed before mutating the source when transfer policy is unavailable or disabled (%#)', async (features, errorCode) => {
    const { coordinator, port, update } = createHarness({ readServerFeatures: async () => features });
    expect(await (await coordinator.admit(baseInput)).execute({ update })).toMatchObject({ ok: false, errorCode });
    expect(port.startSource).not.toHaveBeenCalled();
    expect(port.prepareTarget).not.toHaveBeenCalled();
  });

  it('uses an explicitly selected target directory instead of the source-derived path', async () => {
    const { coordinator, port, update } = createHarness();

    await (await coordinator.admit({ ...baseInput, targetPath: '/home/guest/workspace' })).execute({ update });

    expect(port.prepareTarget).toHaveBeenCalledWith(expect.objectContaining({
      targetPath: '/home/guest/workspace',
    }));
    expect(port.startSource).toHaveBeenCalledWith(expect.not.objectContaining({
      targetPath: expect.anything(),
    }));
  });

  it('aborts the admitted handoff when target preparation fails and normalizes the domain failure', async () => {
    const { coordinator, port, update } = createHarness({
      prepareTarget: vi.fn(async () => ({ ok: false, errorCode: 'target_prepare_failed', error: { message: 'nested detail' } })),
    });
    const result = await (await coordinator.admit(baseInput)).execute({ update });
    expect(result).toEqual({ ok: false, errorCode: 'target_prepare_failed', error: 'nested detail' });
    expect(port.abortTarget).toHaveBeenCalledWith(expect.objectContaining({ handoffId: 'handoff-1' }));
    expect(port.abortSource).toHaveBeenCalledWith(expect.objectContaining({ handoffId: 'handoff-1' }));
    expect(port.resumeTarget).not.toHaveBeenCalled();
  });

  it('does not confirm or rebind a handoff when the target already runs the session', async () => {
    const { coordinator, port, update } = createHarness({
      resumeTarget: vi.fn(async () => ({
        handoffId: 'handoff-1',
        sessionId: 'session-1',
        disposition: 'preexisting_or_adopted' as const,
      })),
    });

    const result = await (await coordinator.admit(baseInput)).execute({ update });

    expect(result).toEqual({
      ok: false,
      errorCode: 'target_session_already_running',
      error: 'This session is already running on the selected target',
    });
    expect(port.confirmTarget).not.toHaveBeenCalled();
    expect(port.bindTarget).not.toHaveBeenCalled();
    expect(port.commitTarget).not.toHaveBeenCalled();
    expect(port.abortTarget).toHaveBeenCalledWith({
      handoffId: 'handoff-1',
      sessionId: 'session-1',
      reason: 'target_session_already_running',
    });
    expect(port.abortSource).toHaveBeenCalledWith({
      handoffId: 'handoff-1',
      reason: 'target_session_already_running',
    });
  });

  it('fails and aborts the staged handoff when the authoritative target status is not found after prepare acceptance', async () => {
    const pendingStatus = {
      handoffId: 'handoff-1',
      status: 'pending' as const,
      phase: 'staging_target' as const,
      recoveryActions: [],
    };
    const { coordinator, port, update } = createHarness({
      prepareTarget: vi.fn(async () => ({ handoffId: 'handoff-1', status: pendingStatus })),
      getTargetStatus: vi.fn(async () => ({ ok: false, errorCode: 'not_found' })),
      getTargetPrepareResult: vi.fn(async () => ({ ok: false, errorCode: 'not_found' })),
      wait: vi.fn(async () => {
        throw new Error('coordinator continued polling after definitive target status loss');
      }),
    });

    const result = await (await coordinator.admit(baseInput)).execute({ update });

    expect(result).toEqual({
      ok: false,
      errorCode: 'not_found',
      error: 'Target preparation status is unavailable',
    });
    expect(port.getTargetPrepareResult).not.toHaveBeenCalled();
    expect(port.wait).not.toHaveBeenCalled();
    expect(port.abortTarget).toHaveBeenCalledWith({
      handoffId: 'handoff-1',
      sessionId: 'session-1',
      reason: 'not_found',
    });
    expect(port.abortSource).toHaveBeenCalledWith({ handoffId: 'handoff-1', reason: 'not_found' });
    expect(port.resumeTarget).not.toHaveBeenCalled();
  });

  it('keeps polling when the final prepare result is not found but authoritative target status remains pending', async () => {
    const pendingStatus = {
      handoffId: 'handoff-1',
      status: 'pending' as const,
      phase: 'staging_target' as const,
      recoveryActions: [],
    };
    const { coordinator, port, update } = createHarness({
      prepareTarget: vi.fn(async () => ({ handoffId: 'handoff-1', status: pendingStatus })),
      getTargetStatus: vi.fn(async () => ({ handoffId: 'handoff-1', status: pendingStatus })),
      getTargetPrepareResult: vi.fn()
        .mockResolvedValueOnce({ ok: false, errorCode: 'not_found' })
        .mockResolvedValueOnce(readyTarget()),
    });

    await expect((await coordinator.admit(baseInput)).execute({ update })).resolves.toMatchObject({ ok: true });
    expect(port.getTargetStatus).toHaveBeenCalledTimes(2);
    expect(port.getTargetPrepareResult).toHaveBeenCalledTimes(2);
    expect(port.wait).toHaveBeenCalledTimes(2);
    expect(port.abortTarget).not.toHaveBeenCalled();
    expect(port.abortSource).not.toHaveBeenCalled();
  });

  it('projects authoritative workspace byte transfer into the parent action operation', async () => {
    const pendingStatus = {
      handoffId: 'handoff-1',
      status: 'pending' as const,
      phase: 'staging_target' as const,
      recoveryActions: [],
      progress: {
        updatedAtMs: 123,
        checkpoint: 'transfer_blobs' as const,
        planned: { totalFiles: 4, totalBytes: 4096 },
        transferred: { files: 2, bytes: 1024, blobs: 1 },
        current: { relativePath: 'src/index.ts' },
        resumable: true,
      },
    };
    const { coordinator, update } = createHarness({
      prepareTarget: vi.fn(async () => ({ handoffId: 'handoff-1', status: pendingStatus })),
      getTargetStatus: vi.fn(async () => ({ handoffId: 'handoff-1', status: pendingStatus })),
      getTargetPrepareResult: vi.fn(async () => readyTarget()),
    });

    await (await coordinator.admit(baseInput)).execute({ update });

    expect(update).toHaveBeenCalledWith({
      progress: {
        kind: 'determinate',
        current: 1024,
        total: 4096,
        label: 'Transferring workspace · src/index.ts',
      },
    });
  });

  it('projects authoritative session bundle byte transfer into the parent action operation', async () => {
    const pendingStatus = {
      handoffId: 'handoff-1',
      status: 'pending' as const,
      phase: 'staging_target' as const,
      recoveryActions: [],
      progress: {
        updatedAtMs: 123,
        checkpoint: 'import_session' as const,
        planned: { totalBytes: 4096 },
        transferred: { bytes: 1024 },
        current: { phaseDetail: 'transferring_session' },
        resumable: false,
      },
    };
    const { coordinator, update } = createHarness({
      prepareTarget: vi.fn(async () => ({ handoffId: 'handoff-1', status: pendingStatus })),
      getTargetStatus: vi.fn(async () => ({ handoffId: 'handoff-1', status: pendingStatus })),
      getTargetPrepareResult: vi.fn(async () => readyTarget()),
    });

    await (await coordinator.admit(baseInput)).execute({ update });

    expect(update).toHaveBeenCalledWith({
      progress: {
        kind: 'determinate',
        current: 1024,
        total: 4096,
        label: 'Transferring session data',
      },
    });
  });

  it('treats source cleanup trouble after target commit as success with a visible warning', async () => {
    const { coordinator } = createHarness({
      cleanupSource: vi.fn(async () => ({ ok: false, errorCode: 'source_cleanup_failed', errorMessage: 'Source is unreachable' })),
    });
    await expect((await coordinator.admit(baseInput)).execute({ update: vi.fn() })).resolves.toEqual({
      ok: true,
      result: {
        handoffId: 'handoff-1',
        status: expect.objectContaining({ status: 'completed' }),
        warning: { code: 'source_cleanup_failed', message: 'Source is unreachable' },
      },
    });
  });

  it('continues independently of an observing socket after admission', async () => {
    let resolvePending!: (value: unknown) => void;
    const pending = new Promise<unknown>((resolve) => { resolvePending = resolve; });
    const { coordinator, port, calls } = createHarness({
      prepareTarget: vi.fn(async () => await pending),
    });
    const execution = (await coordinator.admit(baseInput)).execute({ update: vi.fn() });
    await vi.waitFor(() => expect(calls).toEqual(['start']));
    resolvePending(readyTarget());
    await expect(execution).resolves.toMatchObject({ ok: true });
    expect(port.commitTarget).toHaveBeenCalledOnce();
  });

  it('lets cancellation interrupt the pending transfer-policy read before the source is touched', async () => {
    const controller = new AbortController();
    const readServerFeatures = vi.fn((signal?: AbortSignal) => new Promise<null>((resolve) => {
      // Settles only through the forwarded cancellation signal, like a fetch that is still in flight.
      signal?.addEventListener('abort', () => resolve(null), { once: true });
    }));
    const { coordinator, port, update } = createHarness({ readServerFeatures });

    const pending = (await coordinator.admit(baseInput)).execute({ update, signal: controller.signal });
    await vi.waitFor(() => expect(readServerFeatures).toHaveBeenCalledOnce());
    controller.abort();

    const result = await Promise.race([
      pending,
      new Promise<'still_waiting'>((resolve) => setTimeout(() => resolve('still_waiting'), 1_000)),
    ]);
    expect(result).toEqual({ kind: 'cancelled' });
    expect(readServerFeatures).toHaveBeenCalledWith(controller.signal);
    expect(port.startSource).not.toHaveBeenCalled();
    expect(port.abortSource).not.toHaveBeenCalled();
  });

  it('acknowledges tracked-operation cancellation through the canonical abort primitives before commit', async () => {
    const controller = new AbortController();
    const { coordinator, port, update } = createHarness({
      prepareTarget: vi.fn(async () => {
        controller.abort();
        return readyTarget();
      }),
    });

    const result = await (await coordinator.admit(baseInput)).execute({
      update,
      signal: controller.signal,
    });

    expect(result).toEqual({ kind: 'cancelled' });
    expect(port.abortTarget).toHaveBeenCalledWith({
      handoffId: 'handoff-1',
      sessionId: 'session-1',
      reason: 'action_cancelled',
    });
    expect(port.abortSource).toHaveBeenCalledWith({ handoffId: 'handoff-1', reason: 'action_cancelled' });
    expect(port.resumeTarget).not.toHaveBeenCalled();
    expect(port.commitTarget).not.toHaveBeenCalled();
  });

  it('finishes the committed handoff when cancellation arrives after the irreversible binding boundary', async () => {
    const controller = new AbortController();
    const { coordinator, port } = createHarness({
      bindTarget: vi.fn(async () => {
        controller.abort();
      }),
    });

    await expect((await coordinator.admit(baseInput)).execute({
      update: vi.fn(),
      signal: controller.signal,
    })).resolves.toMatchObject({ ok: true, result: { handoffId: 'handoff-1' } });

    expect(port.commitTarget).toHaveBeenCalledOnce();
    expect(port.cleanupSource).toHaveBeenCalledOnce();
    expect(port.abortTarget).not.toHaveBeenCalled();
    expect(port.abortSource).not.toHaveBeenCalled();
  });

  it('does not claim cancellation when a canonical abort primitive cannot confirm it', async () => {
    const controller = new AbortController();
    const { coordinator, port } = createHarness({
      prepareTarget: vi.fn(async () => {
        controller.abort();
        return readyTarget();
      }),
      abortTarget: vi.fn(async () => ({
        handoffId: 'handoff-1',
        status: { ...readyTarget().status, status: 'awaiting_recovery' as const },
        targetCleanup: { status: 'failed' as const, reason: 'failed' as const, attemptedAtMs: 1 },
      })),
    });

    await expect((await coordinator.admit(baseInput)).execute({
      update: vi.fn(),
      signal: controller.signal,
    })).resolves.toEqual({
      ok: false,
      errorCode: 'handoff_cancel_failed',
      error: 'Session handoff cancellation could not be confirmed',
    });
    expect(port.abortTarget).toHaveBeenCalledOnce();
    expect(port.abortSource).toHaveBeenCalledOnce();
    expect(port.resumeTarget).not.toHaveBeenCalled();
  });
});
