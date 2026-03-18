import { describe, expect, it } from 'vitest';

async function loadHandoffModule() {
  return await import(new URL('./handoffRpc.js', import.meta.url).href).catch((error) => ({ error } as const));
}

describe('session handoff schemas', () => {
  it('exports the handoff schema surface', async () => {
    const mod = await loadHandoffModule();
    expect(mod).not.toHaveProperty('error');
    if ('error' in mod) return;

    expect(typeof mod.SessionHandoffStartRequestSchema).toBe('object');
    expect(typeof mod.SessionHandoffPrepareTargetRequestSchema).toBe('object');
    expect(typeof mod.SessionHandoffStatusSchema).toBe('object');
    expect(typeof mod.SessionHandoffProviderBundleSchema).toBe('object');
    expect(typeof mod.SessionHandoffWorkspaceBundleSchema).toBe('object');
    expect(typeof mod.TransferEndpointCandidateSchema).toBe('object');
    expect(typeof mod.TransferStreamEnvelopeSchema).toBe('object');
    expect(typeof mod.SessionHandoffWorkspaceTransferSchema).toBe('object');
  });

  it('validates start, status, and transfer payloads', async () => {
    const mod = await loadHandoffModule();
    expect(mod).not.toHaveProperty('error');
    if ('error' in mod) return;

    const startParsed = mod.SessionHandoffStartRequestSchema.safeParse({
      sessionId: 'sess_1',
      sourceMachineId: 'machine_source',
      targetMachineId: 'machine_target',
      sessionStorageMode: 'persisted',
      preferredTransportStrategies: ['direct_peer', 'server_routed_stream'],
      workspaceTransfer: {
        enabled: true,
        conflictPolicy: 'create_sibling_copy',
        includeIgnoredMode: 'include_selected',
        ignoredIncludeGlobs: ['dist/**'],
      },
    });
    expect(startParsed.success).toBe(true);
    if (!startParsed.success) return;
    expect(startParsed.data.workspaceTransfer).toEqual({
      enabled: true,
      strategy: 'transfer_snapshot',
      conflictPolicy: 'create_sibling_copy',
      includeIgnoredMode: 'include_selected',
      ignoredIncludeGlobs: ['dist/**'],
    });

    expect(
      mod.SessionHandoffStatusSchema.safeParse({
        handoffId: 'handoff_1',
        status: 'pending',
        phase: 'preparing',
        recoveryActions: [],
      }).success,
    ).toBe(true);

    expect(
      mod.SessionHandoffPrepareTargetRequestSchema.safeParse({
        handoffId: 'handoff_1',
        sourceMachineId: 'machine_source',
        targetMachineId: 'machine_target',
        negotiatedTransportStrategy: 'direct_peer',
        sourceSessionStorageMode: 'persisted',
        targetPath: '/repo',
        endpointCandidates: [
          {
            kind: 'http',
            url: 'http://127.0.0.1:46001/session-handoffs/direct-transfer/handoff_1?token=test-token',
            authorizationToken: 'test-token',
            expiresAt: 1,
          },
        ],
      }).success,
    ).toBe(true);

    expect(
      mod.SessionHandoffProviderBundleSchema.safeParse({
        providerId: 'claude',
        remoteSessionId: 'claude_session_1',
        transcriptBase64: 'e30K',
      }).success,
    ).toBe(true);

    expect(
      mod.SessionHandoffWorkspaceBundleSchema.safeParse({
        entries: [
          {
            relativePath: 'README.md',
            contentBase64: 'aGVsbG8K',
          },
        ],
      }).success,
    ).toBe(true);

    expect(
      mod.TransferStreamEnvelopeSchema.safeParse({
        transferId: 'transfer_1',
        kind: 'chunk',
        sequence: 0,
        payloadBase64: 'aGVsbG8=',
      }).success,
    ).toBe(true);
  });

  it('accepts absolute transfer endpoint URLs with matching schemes', async () => {
    const mod = await loadHandoffModule();
    expect(mod).not.toHaveProperty('error');
    if ('error' in mod) return;

    expect(
      mod.TransferEndpointCandidateSchema.safeParse({
        kind: 'http',
        url: 'http://127.0.0.1:46001/session-handoffs/direct-transfer/handoff_1',
        authorizationToken: 'token',
        expiresAt: 1,
      }).success,
    ).toBe(true);

    expect(
      mod.TransferEndpointCandidateSchema.safeParse({
        kind: 'https',
        url: 'http://127.0.0.1:46001/session-handoffs/direct-transfer/handoff_1',
        expiresAt: 1,
      }).success,
    ).toBe(false);
  });
});
