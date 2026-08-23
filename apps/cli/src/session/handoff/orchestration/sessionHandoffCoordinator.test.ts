import { describe, expect, it, vi } from 'vitest';

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
