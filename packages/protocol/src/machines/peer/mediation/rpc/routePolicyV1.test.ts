import { describe, expect, it } from 'vitest';

import { RPC_METHODS, SESSION_RPC_METHODS } from '../../../../rpc';

async function importRpcPolicy() {
  return await import('./index').catch((error: unknown) => ({ importError: error }));
}

describe('MachineRpcRoutePolicyV1', () => {
  it('classifies every deployed RPC and session RPC method exactly once', async () => {
    const protocol = await importRpcPolicy();
    expect(protocol).toHaveProperty('validateMachineRpcRoutePolicies');
    if ('importError' in protocol) throw protocol.importError;

    const result = protocol.validateMachineRpcRoutePolicies();

    expect(result.ok).toBe(true);
    expect(result.missingMethods).toEqual([]);
    expect(result.unknownMethods).toEqual([]);
    expect(result.duplicateMethods).toEqual([]);
    expect(result.policies).toHaveLength(
      Object.keys(RPC_METHODS).length + Object.keys(SESSION_RPC_METHODS).length,
    );
  });

  it('keeps durable session writes and unknown methods server-routed by default', async () => {
    const protocol = await importRpcPolicy();
    expect(protocol).toHaveProperty('resolveMachineRpcRoutePolicy');
    if ('importError' in protocol) throw protocol.importError;

    expect(protocol.resolveMachineRpcRoutePolicy(SESSION_RPC_METHODS.SESSION_USER_MESSAGE_SEND)).toMatchObject({
      routeClass: 'server_required',
      serverRequiredReason: 'durable_session_write',
      commandReceiptRequired: false,
    });
    expect(protocol.resolveMachineRpcRoutePolicy('not.registered')).toMatchObject({
      routeClass: 'server_required',
      serverRequiredReason: 'unclassified',
    });
  });

  it('marks only explicitly proven daemon-local status methods direct eligible', async () => {
    const protocol = await importRpcPolicy();
    expect(protocol).toHaveProperty('resolveMachineRpcRoutePolicy');
    if ('importError' in protocol) throw protocol.importError;

    expect(protocol.resolveMachineRpcRoutePolicy(RPC_METHODS.DAEMON_MEMORY_STATUS)).toMatchObject({
      routeClass: 'direct_ephemeral',
      rpcClassification: 'internal_only',
      commandReceiptRequired: false,
      scope: expect.objectContaining({
        machineRequired: true,
        accountRequired: true,
      }),
    });
    expect(protocol.resolveMachineRpcRoutePolicy(RPC_METHODS.SCM_COMMIT_CREATE)).toMatchObject({
      routeClass: 'server_required',
      serverRequiredReason: 'destructive_or_recovery_mutation',
    });
  });

  it('rejects direct route rows that still carry advisory governance', async () => {
    const protocol = await importRpcPolicy();
    expect(protocol).toHaveProperty('validateMachineRpcRoutePolicies');
    if ('importError' in protocol) throw protocol.importError;

    const directAdvisoryPolicy = {
      method: RPC_METHODS.DAEMON_MEMORY_STATUS,
      routeClass: 'direct_ephemeral',
      rationale: 'fixture direct route with missing A.12.0 governance',
      ownerPacket: 'PMS-5',
      rpcClassification: 'advisory_unclassified',
      commandReceiptRequired: false,
      scope: {
        accountRequired: true,
        machineRequired: true,
        sessionRequired: false,
        serverRequired: false,
      },
    } as const;

    const result = protocol.validateMachineRpcRoutePolicies([directAdvisoryPolicy]);

    expect(result.ok).toBe(false);
    expect(result.invalidMethods).toContain(RPC_METHODS.DAEMON_MEMORY_STATUS);
  });

  it('rejects direct grant scopes for direct rows without accepted governance', async () => {
    const protocol = await importRpcPolicy();
    expect(protocol).toHaveProperty('validateMachineRpcGrantAllowedMethods');
    if ('importError' in protocol) throw protocol.importError;

    const directAdvisoryPolicy = {
      method: RPC_METHODS.DAEMON_MEMORY_STATUS,
      routeClass: 'direct_ephemeral',
      rationale: 'fixture direct route with missing A.12.0 governance',
      ownerPacket: 'PMS-5',
      rpcClassification: 'advisory_unclassified',
      commandReceiptRequired: false,
      scope: {
        accountRequired: true,
        machineRequired: true,
        sessionRequired: false,
        serverRequired: false,
      },
    } as const;

    expect(protocol.validateMachineRpcGrantAllowedMethods(
      [RPC_METHODS.DAEMON_MEMORY_STATUS],
      [directAdvisoryPolicy],
    )).toEqual({
      ok: false,
      reasonCode: 'machine_rpc_requires_pms5_classification',
      method: RPC_METHODS.DAEMON_MEMORY_STATUS,
    });
  });

  it('identifies ActionSpec-backed external session RPC methods even when they stay server-routed', async () => {
    const protocol = await importRpcPolicy();
    expect(protocol).toHaveProperty('resolveMachineRpcRoutePolicy');
    if ('importError' in protocol) throw protocol.importError;

    expect(protocol.resolveMachineRpcRoutePolicy(RPC_METHODS.DAEMON_EXTERNAL_SESSION_ATTACH)).toMatchObject({
      routeClass: 'server_required',
      rpcClassification: 'action_spec_bound',
      actionSpecId: 'sessions.external.follow',
    });
    expect(protocol.resolveMachineRpcRoutePolicy(RPC_METHODS.DAEMON_EXTERNAL_SESSION_DETACH)).toMatchObject({
      routeClass: 'server_required',
      rpcClassification: 'action_spec_bound',
      actionSpecId: 'sessions.external.unfollow',
    });
  });

  it('identifies execution-run session RPC governance from A.12 ActionSpec bindings', async () => {
    const protocol = await importRpcPolicy();
    expect(protocol).toHaveProperty('resolveMachineRpcRoutePolicy');
    if ('importError' in protocol) throw protocol.importError;

    expect(protocol.resolveMachineRpcRoutePolicy(SESSION_RPC_METHODS.EXECUTION_RUN_START)).toMatchObject({
      routeClass: 'server_required',
      rpcClassification: 'action_spec_bound',
      actionSpecId: 'execution.run.start',
    });
    expect(protocol.resolveMachineRpcRoutePolicy(SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_READ)).toMatchObject({
      routeClass: 'server_required',
      rpcClassification: 'action_spec_bound',
      actionSpecId: 'execution.run.stream.read',
    });
  });

  it('identifies A.12 voice cleanup RPC governance as internal-only without making transport direct', async () => {
    const protocol = await importRpcPolicy();
    expect(protocol).toHaveProperty('resolveMachineRpcRoutePolicy');
    if ('importError' in protocol) throw protocol.importError;

    const methods = [
      RPC_METHODS.DAEMON_VOICE_INFERENCE_MODELS_INSTALL,
      RPC_METHODS.DAEMON_VOICE_INFERENCE_MODELS_WARM,
      RPC_METHODS.DAEMON_VOICE_INFERENCE_TTS_SYNTHESIZE,
      RPC_METHODS.DAEMON_VOICE_INFERENCE_TTS_CHUNK,
      RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_UPLOAD_INIT,
      RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_TRANSCRIBE,
    ];

    for (const method of methods) {
      expect(protocol.resolveMachineRpcRoutePolicy(method)).toMatchObject({
        routeClass: 'server_required',
        rpcClassification: 'internal_only',
      });
    }
  });

  it('identifies session transcript RPC governance from A.12 transcript ActionSpec bindings', async () => {
    const protocol = await importRpcPolicy();
    expect(protocol).toHaveProperty('resolveMachineRpcRoutePolicy');
    if ('importError' in protocol) throw protocol.importError;

    expect(protocol.resolveMachineRpcRoutePolicy(RPC_METHODS.SESSION_LOG_TAIL)).toMatchObject({
      routeClass: 'server_required',
      rpcClassification: 'action_spec_bound',
      actionSpecId: 'session.log.tail',
    });
    expect(protocol.resolveMachineRpcRoutePolicy(RPC_METHODS.TRANSCRIPT_PAGE)).toMatchObject({
      routeClass: 'server_required',
      rpcClassification: 'action_spec_bound',
      actionSpecId: 'transcript.page',
    });
    expect(protocol.resolveMachineRpcRoutePolicy(RPC_METHODS.TRANSCRIPT_IMPORT)).toMatchObject({
      routeClass: 'server_required',
      rpcClassification: 'action_spec_bound',
      actionSpecId: 'transcript.import',
    });
  });
});
