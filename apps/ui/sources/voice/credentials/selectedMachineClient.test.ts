import { describe, expect, it, vi } from 'vitest';

import {
  createSelectedVoiceMachineClient,
  type VoiceCredentialMachineRpc,
} from './selectedMachineClient';

/**
 * Test double for the machine-RPC system boundary. The real transport is
 * generic over its response type, which a fixture cannot infer, so the
 * recorded reply is asserted as that type parameter here and nowhere else.
 */
function createRecordingMachineRpc(reply: unknown): Readonly<{
  machineRpc: VoiceCredentialMachineRpc;
  dispatchedMachineIds: readonly string[];
}> {
  const dispatchedMachineIds: string[] = [];
  const machineRpc = (async <R,>(
    params: Readonly<{ machineId: string }>,
  ): Promise<R> => {
    dispatchedMachineIds.push(params.machineId);
    return reply as R;
  }) as VoiceCredentialMachineRpc;
  return { machineRpc, dispatchedMachineIds };
}

describe('selected Voice machine client', () => {
  it('fails closed when no Voice execution machine is resolvable', async () => {
    const { machineRpc, dispatchedMachineIds } = createRecordingMachineRpc({ ok: true });
    const client = createSelectedVoiceMachineClient({
      resolveMachineId: () => null,
      machineRpc,
    });

    await expect(client.invoke('daemon.voice.probe', {})).rejects.toMatchObject({
      code: 'machine_unavailable',
    });
    expect(dispatchedMachineIds).toEqual([]);
  });

  it('keeps the answer from the machine it dispatched to when auto selection reorders mid-call', async () => {
    // The automatic Voice target is re-derived from mutable ordering (recent
    // machine paths, liveness) on every read, so with more than one online
    // machine it can differ between two reads seconds apart with no user
    // action. Re-resolving after the call threw away a credential the
    // dispatched machine had already materialized, turning a local ordering
    // change into `credential_unavailable` at the Voice surface.
    const resolveMachineId = vi.fn<() => string | null>()
      .mockReturnValueOnce('machine-a')
      .mockReturnValue('machine-b');
    const { machineRpc, dispatchedMachineIds } = createRecordingMachineRpc({ ok: true });
    const client = createSelectedVoiceMachineClient({ resolveMachineId, machineRpc });

    await expect(client.invoke('daemon.voice.probe', { v: 1 })).resolves.toEqual({ ok: true });
    expect(dispatchedMachineIds).toEqual(['machine-a']);
    expect(resolveMachineId).toHaveBeenCalledTimes(1);
  });

  it('keeps every phase of one bound operation on the machine it started on', async () => {
    // A composite STT/TTS operation names daemon-side state (`uploadId`,
    // `downloadId`) that only the initiating machine holds. Re-resolving the
    // mutable automatic target between phases sends `chunk` to a machine that
    // never saw `init` — `transfer_not_found` — and strands the real temporary
    // state on the initiating machine until its TTL expires.
    const resolveMachineId = vi.fn<(override?: unknown) => string | null>()
      .mockReturnValueOnce('machine-a')
      .mockReturnValue('machine-b');
    const { machineRpc, dispatchedMachineIds } = createRecordingMachineRpc({ ok: true });
    const client = createSelectedVoiceMachineClient({ resolveMachineId, machineRpc });

    const operation = client.bindOperation();
    await operation.invoke('daemon.voice.speech.transcribeUpload.init', {});
    await operation.invoke('daemon.voice.speech.transcribeUpload.chunk', {});
    await operation.invoke('daemon.voice.speech.transcribeUpload.finalize', {});
    await operation.invoke('daemon.voice.speech.transcribe', {});

    expect(operation.machineId).toBe('machine-a');
    expect(dispatchedMachineIds).toEqual(['machine-a', 'machine-a', 'machine-a', 'machine-a']);
    expect(resolveMachineId).toHaveBeenCalledTimes(1);
  });

  it('replays a captured origin machine through the resolver so replacement and reachability still decide', async () => {
    // The dictation attempt captured its target when capture was admitted. The
    // bound operation asks the same resolver for that origin rather than
    // trusting the raw id, so a replaced machine is followed.
    const resolveMachineId = vi.fn<(override?: unknown) => string | null>(() => 'machine-replacement');
    const { machineRpc, dispatchedMachineIds } = createRecordingMachineRpc({ ok: true });
    const client = createSelectedVoiceMachineClient({ resolveMachineId, machineRpc });

    const operation = client.bindOperation('  machine-origin  ');
    await operation.invoke('daemon.voice.speech.transcribeUpload.init', {});

    expect(resolveMachineId).toHaveBeenCalledWith({ machineId: 'machine-origin' });
    expect(dispatchedMachineIds).toEqual(['machine-replacement']);
  });

  it('fails closed before the operation starts when the captured origin is unreachable', async () => {
    const { machineRpc, dispatchedMachineIds } = createRecordingMachineRpc({ ok: true });
    const client = createSelectedVoiceMachineClient({ resolveMachineId: () => null, machineRpc });

    expect(() => client.bindOperation('machine-origin')).toThrow(
      expect.objectContaining({ code: 'machine_unavailable' }),
    );
    expect(dispatchedMachineIds).toEqual([]);
  });
});
