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
});
