import { describe, expect, it } from 'vitest';

import { RPC_METHODS, SESSION_RPC_METHODS } from '../../../../rpc/index.js';

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

  it('keeps quota recovery, connected-service auth, and terminal composer controls server-routed', async () => {
    const protocol = await importRpcPolicy();
    expect(protocol).toHaveProperty('resolveMachineRpcRoutePolicy');
    if ('importError' in protocol) throw protocol.importError;

    for (const method of [
      SESSION_RPC_METHODS.SESSION_CONNECTED_SERVICE_AUTH_APPLY_GENERATION,
      SESSION_RPC_METHODS.SESSION_CONNECTED_SERVICE_AUTH_READ_RUNTIME_IDENTITY,
    ]) {
      expect(protocol.resolveMachineRpcRoutePolicy(method)).toMatchObject({
        routeClass: 'server_required',
        serverRequiredReason: 'auth',
        commandReceiptRequired: false,
        scope: expect.objectContaining({
          sessionRequired: true,
          serverRequired: true,
        }),
      });
    }

    for (const method of [
      RPC_METHODS.DAEMON_SESSION_USAGE_LIMIT_CONSUME_RESET_CREDIT,
      SESSION_RPC_METHODS.SESSION_USAGE_LIMIT_CONSUME_RESET_CREDIT,
    ]) {
      expect(protocol.resolveMachineRpcRoutePolicy(method)).toMatchObject({
        routeClass: 'server_required',
        serverRequiredReason: 'billing',
        commandReceiptRequired: false,
        scope: expect.objectContaining({
          sessionRequired: true,
          serverRequired: true,
        }),
      });
    }

    expect(protocol.resolveMachineRpcRoutePolicy(SESSION_RPC_METHODS.SESSION_TERMINAL_COMPOSER_CLEAR)).toMatchObject({
      routeClass: 'server_required',
      serverRequiredReason: 'destructive_or_recovery_mutation',
      rpcClassification: 'action_spec_bound',
      actionSpecId: 'session.terminalComposer.clear',
      commandReceiptRequired: false,
      scope: expect.objectContaining({
        sessionRequired: true,
        serverRequired: true,
      }),
    });

    expect(protocol.resolveMachineRpcRoutePolicy(
      RPC_METHODS.DAEMON_CONNECTED_SERVICE_QUOTA_RECOVERY_CREDIT_CONSUME,
    )).toMatchObject({
      routeClass: 'server_required',
      serverRequiredReason: 'billing',
      commandReceiptRequired: false,
      scope: expect.objectContaining({
        sessionRequired: false,
        serverRequired: true,
      }),
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

  it('classifies plugin artifact and simulator preview RPCs as direct internal daemon transports', async () => {
    const protocol = await importRpcPolicy();
    expect(protocol).toHaveProperty('resolveMachineRpcRoutePolicy');
    if ('importError' in protocol) throw protocol.importError;

    for (const method of [
      RPC_METHODS.DAEMON_PLUGIN_UI_ARTIFACT_BYTES_READ,
      RPC_METHODS.DAEMON_BROWSER_DIAGNOSTICS_SNAPSHOT,
      RPC_METHODS.DAEMON_BROWSER_RECORDING_START,
      RPC_METHODS.DAEMON_BROWSER_RECORDING_STOP,
      RPC_METHODS.DAEMON_BROWSER_RECORDING_CANCEL,
      RPC_METHODS.DAEMON_BROWSER_RECORDING_STATUS,
      RPC_METHODS.DAEMON_BROWSER_RECORDING_LIST,
      RPC_METHODS.DAEMON_BROWSER_RECORDING_CLEANUP,
      RPC_METHODS.DAEMON_SIMULATOR_PREVIEW_SNAPSHOT,
      RPC_METHODS.DAEMON_SIMULATOR_PREVIEW_ACTION,
    ]) {
      expect(protocol.resolveMachineRpcRoutePolicy(method)).toMatchObject({
        routeClass: 'direct_ephemeral',
        rpcClassification: 'internal_only',
        commandReceiptRequired: false,
        scope: expect.objectContaining({
          accountRequired: true,
          machineRequired: true,
          sessionRequired: false,
          serverRequired: false,
        }),
      });
    }
  });

  it('keeps browser context dispatch direct internal and command-receipted', async () => {
    const protocol = await importRpcPolicy();
    expect(protocol).toHaveProperty('resolveMachineRpcRoutePolicy');
    if ('importError' in protocol) throw protocol.importError;

    expect(protocol.resolveMachineRpcRoutePolicy(RPC_METHODS.DAEMON_BROWSER_CONTEXT_DISPATCH)).toMatchObject({
      routeClass: 'direct_medium_risk_receipted',
      rpcClassification: 'internal_only',
      commandReceiptRequired: true,
      scope: expect.objectContaining({
        accountRequired: true,
        machineRequired: true,
        sessionRequired: false,
        serverRequired: false,
      }),
    });
  });

  it('routes daemon-local plugin settings reads directly and receipts settings writes', async () => {
    const protocol = await importRpcPolicy();
    expect(protocol).toHaveProperty('resolveMachineRpcRoutePolicy');
    if ('importError' in protocol) throw protocol.importError;

    expect(protocol.resolveMachineRpcRoutePolicy(RPC_METHODS.DAEMON_PLUGIN_SETTINGS_GET)).toMatchObject({
      routeClass: 'direct_ephemeral',
      rpcClassification: 'internal_only',
      commandReceiptRequired: false,
      scope: expect.objectContaining({
        accountRequired: true,
        machineRequired: true,
        sessionRequired: false,
        serverRequired: false,
      }),
    });
    expect(protocol.resolveMachineRpcRoutePolicy(RPC_METHODS.DAEMON_PLUGIN_SETTINGS_SET)).toMatchObject({
      routeClass: 'direct_medium_risk_receipted',
      rpcClassification: 'internal_only',
      commandReceiptRequired: true,
      scope: expect.objectContaining({
        accountRequired: true,
        machineRequired: true,
        sessionRequired: false,
        serverRequired: false,
      }),
    });
  });

  it('routes signed live-stream relay start directly only with a command receipt', async () => {
    const protocol = await importRpcPolicy();
    expect(protocol).toHaveProperty('resolveMachineRpcRoutePolicy');
    if ('importError' in protocol) throw protocol.importError;

    expect(protocol.resolveMachineRpcRoutePolicy(RPC_METHODS.DAEMON_LIVE_STREAM_RELAY_START)).toMatchObject({
      routeClass: 'direct_medium_risk_receipted',
      rpcClassification: 'internal_only',
      commandReceiptRequired: true,
      scope: expect.objectContaining({
        accountRequired: true,
        machineRequired: true,
        sessionRequired: false,
        serverRequired: false,
      }),
    });
  });

  it('keeps per-session runner restart on the server route because authorization depends on session access', async () => {
    const protocol = await importRpcPolicy();
    expect(protocol).toHaveProperty('resolveMachineRpcRoutePolicy');
    if ('importError' in protocol) throw protocol.importError;

    expect(protocol.resolveMachineRpcRoutePolicy(RPC_METHODS.DAEMON_SESSION_RUNNER_RESTART)).toMatchObject({
      routeClass: 'server_required',
      rpcClassification: 'internal_only',
      commandReceiptRequired: false,
      scope: expect.objectContaining({
        accountRequired: true,
        machineRequired: true,
        sessionRequired: true,
        serverRequired: true,
      }),
    });
  });

  it('keeps Local Services reads ephemeral and launcher/action execution command-receipted', async () => {
    const protocol = await importRpcPolicy();
    expect(protocol).toHaveProperty('resolveMachineRpcRoutePolicy');
    if ('importError' in protocol) throw protocol.importError;

    for (const method of [
      RPC_METHODS.DAEMON_LOCAL_SERVICES_INVENTORY_SNAPSHOT,
      RPC_METHODS.DAEMON_LOCAL_SERVICES_INVENTORY_REFRESH,
      RPC_METHODS.DAEMON_LOCAL_SERVICES_LAUNCHER_SNAPSHOT,
      RPC_METHODS.DAEMON_LOCAL_SERVICES_MANAGED_SNAPSHOT,
      RPC_METHODS.DAEMON_LOCAL_SERVICES_PREVIEW_SNAPSHOT,
      RPC_METHODS.DAEMON_LOCAL_SERVICES_PUBLIC_PREVIEW_STATUS,
      RPC_METHODS.DAEMON_LOCAL_SERVICES_PUBLIC_PREVIEW_COPY_URL,
    ]) {
      expect(protocol.resolveMachineRpcRoutePolicy(method)).toMatchObject({
        routeClass: 'direct_ephemeral',
        rpcClassification: 'internal_only',
        commandReceiptRequired: false,
      });
    }

    expect(protocol.resolveMachineRpcRoutePolicy(
      RPC_METHODS.DAEMON_LOCAL_SERVICES_ACTIONS_EXECUTE,
    )).toMatchObject({
      routeClass: 'direct_medium_risk_receipted',
      rpcClassification: 'internal_only',
      commandReceiptRequired: true,
      scope: expect.objectContaining({
        accountRequired: true,
        machineRequired: true,
        serverRequired: false,
      }),
    });

    for (const method of [
      RPC_METHODS.DAEMON_LOCAL_SERVICES_LAUNCHER_START,
      RPC_METHODS.DAEMON_LOCAL_SERVICES_LAUNCHER_OPEN_PREVIEW,
      RPC_METHODS.DAEMON_LOCAL_SERVICES_LAUNCHER_REGISTER_PREVIEW,
      RPC_METHODS.DAEMON_LOCAL_SERVICES_LAUNCHER_HISTORY_CLEAR,
      RPC_METHODS.DAEMON_LOCAL_SERVICES_PUBLIC_PREVIEW_CREATE,
      RPC_METHODS.DAEMON_LOCAL_SERVICES_PUBLIC_PREVIEW_REVOKE,
    ]) {
      expect(protocol.resolveMachineRpcRoutePolicy(method)).toMatchObject({
        routeClass: 'direct_medium_risk_receipted',
        rpcClassification: 'internal_only',
        commandReceiptRequired: true,
        scope: expect.objectContaining({
          accountRequired: true,
          machineRequired: true,
          serverRequired: false,
        }),
      });
    }
  });

  it('keeps private preview lifecycle mutations direct internal and command-receipted', async () => {
    const protocol = await importRpcPolicy();
    expect(protocol).toHaveProperty('resolveMachineRpcRoutePolicy');
    if ('importError' in protocol) throw protocol.importError;

    for (const method of [
      RPC_METHODS.DAEMON_LOCAL_SERVICES_PREVIEW_OPEN_OR_CREATE,
      RPC_METHODS.DAEMON_LOCAL_SERVICES_PREVIEW_REVOKE,
    ]) {
      expect(protocol.resolveMachineRpcRoutePolicy(method)).toMatchObject({
        routeClass: 'direct_medium_risk_receipted',
        rpcClassification: 'internal_only',
        commandReceiptRequired: true,
        scope: expect.objectContaining({
          accountRequired: true,
          machineRequired: true,
          sessionRequired: false,
          serverRequired: false,
        }),
      });
    }
  });

  it('keeps React Native crash report submission server-routed as an internal local mutation', async () => {
    const protocol = await importRpcPolicy();
    expect(protocol).toHaveProperty('resolveMachineRpcRoutePolicy');
    if ('importError' in protocol) throw protocol.importError;

    expect(protocol.resolveMachineRpcRoutePolicy(
      RPC_METHODS.DAEMON_PLUGIN_UI_REACT_NATIVE_CRASH_REPORT_SUBMIT,
    )).toMatchObject({
      routeClass: 'server_required',
      rpcClassification: 'internal_only',
      serverRequiredReason: 'destructive_or_recovery_mutation',
      commandReceiptRequired: false,
      scope: expect.objectContaining({
        accountRequired: true,
        machineRequired: true,
        sessionRequired: false,
        serverRequired: true,
      }),
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
      RPC_METHODS.DAEMON_VOICE_INFERENCE_TTS_ABORT,
      RPC_METHODS.DAEMON_VOICE_INFERENCE_TTS_CANCEL,
      RPC_METHODS.DAEMON_VOICE_INFERENCE_TTS_STREAM_ACK,
      RPC_METHODS.DAEMON_VOICE_INFERENCE_TTS_STREAM_CANCEL,
      RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_UPLOAD_ABORT,
      RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_CANCEL,
      RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_STREAM_CANCEL,
    ];

    for (const method of methods) {
      expect(protocol.resolveMachineRpcRoutePolicy(method)).toMatchObject({
        routeClass: 'server_required',
        rpcClassification: 'internal_only',
      });
    }
  });

  it('promotes safe heavy daemon voice audio operations only as direct receipted routes with relay caps metadata', async () => {
    const protocol = await importRpcPolicy();
    expect(protocol).toHaveProperty('resolveMachineRpcRoutePolicy');
    if ('importError' in protocol) throw protocol.importError;

    const methods = [
      RPC_METHODS.DAEMON_VOICE_INFERENCE_TTS_SYNTHESIZE,
      RPC_METHODS.DAEMON_VOICE_INFERENCE_TTS_CHUNK,
      RPC_METHODS.DAEMON_VOICE_INFERENCE_TTS_FINALIZE,
      RPC_METHODS.DAEMON_VOICE_INFERENCE_TTS_STREAM_START,
      RPC_METHODS.DAEMON_VOICE_INFERENCE_TTS_STREAM_NEXT,
      RPC_METHODS.DAEMON_VOICE_INFERENCE_TTS_STREAM_STATUS,
      RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_UPLOAD_INIT,
      RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_UPLOAD_CHUNK,
      RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_UPLOAD_FINALIZE,
      RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_TRANSCRIBE,
      RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_STREAM_START,
      RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_STREAM_CHUNK,
      RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_STREAM_FINISH,
      RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_STREAM_STATUS,
    ];

    for (const method of methods) {
      expect(protocol.resolveMachineRpcRoutePolicy(method)).toMatchObject({
        routeClass: 'direct_medium_risk_receipted',
        rpcClassification: 'internal_only',
        commandReceiptRequired: true,
        scope: expect.objectContaining({
          accountRequired: true,
          machineRequired: true,
          sessionRequired: false,
          serverRequired: false,
        }),
        relayFallback: {
          flowKind: 'daemon_voice_audio',
          defaultSharedServerMode: 'disabled',
          authorizationRequired: true,
          relayCapsRequired: true,
          meteringRequired: true,
          lifecycleReceiptRequired: true,
          capProfile: 'machine_live_stream_relay_caps_v1',
        },
      });
    }
  });

  it('keeps daemon-owned voice credentials direct while receipting secret and auth mutations', async () => {
    const protocol = await importRpcPolicy();
    expect(protocol).toHaveProperty('resolveMachineRpcRoutePolicy');
    if ('importError' in protocol) throw protocol.importError;

    for (const method of [
      RPC_METHODS.DAEMON_VOICE_CREDENTIAL_STATUS,
      RPC_METHODS.DAEMON_VOICE_CREDENTIAL_PROVIDER_CATALOG,
      RPC_METHODS.DAEMON_VOICE_OPENAI_COMPAT_MODELS_LIST,
    ]) {
      expect(protocol.resolveMachineRpcRoutePolicy(method)).toMatchObject({
        routeClass: 'direct_ephemeral',
        rpcClassification: 'internal_only',
        commandReceiptRequired: false,
        scope: expect.objectContaining({
          accountRequired: true,
          machineRequired: true,
          sessionRequired: false,
          serverRequired: false,
        }),
      });
    }

    for (const method of [
      RPC_METHODS.DAEMON_VOICE_CREDENTIAL_STORE,
      RPC_METHODS.DAEMON_VOICE_CREDENTIAL_DELETE,
      RPC_METHODS.DAEMON_VOICE_CREDENTIAL_MINT_CLIENT_AUTH,
      RPC_METHODS.DAEMON_VOICE_OPENAI_COMPAT_CHAT,
    ]) {
      expect(protocol.resolveMachineRpcRoutePolicy(method)).toMatchObject({
        routeClass: 'direct_medium_risk_receipted',
        rpcClassification: 'internal_only',
        commandReceiptRequired: true,
        scope: expect.objectContaining({
          accountRequired: true,
          machineRequired: true,
          sessionRequired: false,
          serverRequired: false,
        }),
      });
    }
  });

  it('routes bounded OpenAI-compatible audio transfers like the canonical daemon voice transfer family', async () => {
    const protocol = await importRpcPolicy();
    expect(protocol).toHaveProperty('resolveMachineRpcRoutePolicy');
    if ('importError' in protocol) throw protocol.importError;

    for (const method of [
      RPC_METHODS.DAEMON_VOICE_OPENAI_COMPAT_TRANSCRIBE_UPLOAD_INIT,
      RPC_METHODS.DAEMON_VOICE_OPENAI_COMPAT_TRANSCRIBE_UPLOAD_CHUNK,
      RPC_METHODS.DAEMON_VOICE_OPENAI_COMPAT_TRANSCRIBE_UPLOAD_FINALIZE,
      RPC_METHODS.DAEMON_VOICE_OPENAI_COMPAT_TRANSCRIBE,
      RPC_METHODS.DAEMON_VOICE_OPENAI_COMPAT_SYNTHESIZE,
      RPC_METHODS.DAEMON_VOICE_OPENAI_COMPAT_DOWNLOAD_CHUNK,
      RPC_METHODS.DAEMON_VOICE_OPENAI_COMPAT_DOWNLOAD_FINALIZE,
    ]) {
      expect(protocol.resolveMachineRpcRoutePolicy(method)).toMatchObject({
        routeClass: 'direct_medium_risk_receipted',
        rpcClassification: 'internal_only',
        commandReceiptRequired: true,
        relayFallback: expect.objectContaining({
          flowKind: 'daemon_voice_audio',
          defaultSharedServerMode: 'disabled',
          relayCapsRequired: true,
        }),
      });
    }

    for (const method of [
      RPC_METHODS.DAEMON_VOICE_OPENAI_COMPAT_TRANSCRIBE_UPLOAD_ABORT,
      RPC_METHODS.DAEMON_VOICE_OPENAI_COMPAT_DOWNLOAD_ABORT,
      RPC_METHODS.DAEMON_VOICE_OPENAI_COMPAT_REQUEST_CANCEL,
    ]) {
      expect(protocol.resolveMachineRpcRoutePolicy(method)).toMatchObject({
        routeClass: 'server_required',
        rpcClassification: 'internal_only',
        serverRequiredReason: 'destructive_or_recovery_mutation',
      });
    }
  });

  it('routes bounded Google audio transfers like the canonical daemon voice transfer family', async () => {
    const protocol = await importRpcPolicy();
    expect(protocol).toHaveProperty('resolveMachineRpcRoutePolicy');
    if ('importError' in protocol) throw protocol.importError;

    for (const method of [
      RPC_METHODS.DAEMON_VOICE_GOOGLE_TRANSCRIBE_UPLOAD_INIT,
      RPC_METHODS.DAEMON_VOICE_GOOGLE_TRANSCRIBE_UPLOAD_CHUNK,
      RPC_METHODS.DAEMON_VOICE_GOOGLE_TRANSCRIBE_UPLOAD_FINALIZE,
      RPC_METHODS.DAEMON_VOICE_GOOGLE_TRANSCRIBE,
      RPC_METHODS.DAEMON_VOICE_GOOGLE_SYNTHESIZE,
      RPC_METHODS.DAEMON_VOICE_GOOGLE_DOWNLOAD_CHUNK,
      RPC_METHODS.DAEMON_VOICE_GOOGLE_DOWNLOAD_FINALIZE,
    ]) {
      expect(protocol.resolveMachineRpcRoutePolicy(method)).toMatchObject({
        routeClass: 'direct_medium_risk_receipted',
        rpcClassification: 'internal_only',
        commandReceiptRequired: true,
        relayFallback: expect.objectContaining({
          flowKind: 'daemon_voice_audio',
          defaultSharedServerMode: 'disabled',
          relayCapsRequired: true,
        }),
      });
    }

    for (const method of [
      RPC_METHODS.DAEMON_VOICE_GOOGLE_TRANSCRIBE_UPLOAD_ABORT,
      RPC_METHODS.DAEMON_VOICE_GOOGLE_DOWNLOAD_ABORT,
    ]) {
      expect(protocol.resolveMachineRpcRoutePolicy(method)).toMatchObject({
        routeClass: 'server_required',
        rpcClassification: 'internal_only',
        serverRequiredReason: 'destructive_or_recovery_mutation',
      });
    }
  });

  it('keeps provider configuration and external voice provisioning server-routed', async () => {
    const protocol = await importRpcPolicy();
    expect(protocol).toHaveProperty('resolveMachineRpcRoutePolicy');
    if ('importError' in protocol) throw protocol.importError;

    for (const method of [
      RPC_METHODS.DAEMON_PROVIDERS_PROBE,
      RPC_METHODS.DAEMON_PROVIDERS_MODELS,
      RPC_METHODS.DAEMON_PROVIDERS_MODEL_LOAD,
      RPC_METHODS.DAEMON_PROVIDERS_CONNECTIONS_DESCRIBE,
      RPC_METHODS.DAEMON_PROVIDERS_MODEL_PROJECTION,
      RPC_METHODS.DAEMON_PROVIDERS_BINDING_STATUS,
      RPC_METHODS.DAEMON_PROVIDERS_PROFILE_MIGRATION_PREVIEW,
    ]) {
      expect(protocol.resolveMachineRpcRoutePolicy(method)).toMatchObject({
        routeClass: 'server_required',
        serverRequiredReason: 'ambiguous',
      });
    }

    for (const method of [
      RPC_METHODS.DAEMON_PROVIDERS_CONNECTION_MUTATE,
      RPC_METHODS.DAEMON_PROVIDERS_MODEL_SETTINGS_MUTATE,
      RPC_METHODS.DAEMON_PROVIDERS_PROFILE_MIGRATION_CONFIRM,
      RPC_METHODS.DAEMON_PROVIDERS_PROFILE_MIGRATION_CONFLICT_CONFIRM,
      RPC_METHODS.DAEMON_VOICE_ELEVENLABS_PROVISION,
    ]) {
      expect(protocol.resolveMachineRpcRoutePolicy(method)).toMatchObject({
        routeClass: 'server_required',
        serverRequiredReason: 'destructive_or_recovery_mutation',
      });
    }
  });

  it('keeps daemon voice relay fallback disabled until an operator enables it with valid caps', async () => {
    const protocol = await importRpcPolicy();
    expect(protocol).toHaveProperty('resolveMachineRpcRoutePolicy');
    expect(protocol).toHaveProperty('resolveMachineRpcRelayFallbackDecision');
    if ('importError' in protocol) throw protocol.importError;

    const policy = protocol.resolveMachineRpcRoutePolicy(RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_STREAM_CHUNK);
    const caps = {
      maxBitrateBps: 128_000,
      maxFramesPerSecond: 50,
      maxFrameBytes: 8_192,
      maxDurationMs: 60_000,
      maxTotalBytes: 960_000,
      maxConcurrentStreamsPerAccount: 2,
      maxConcurrentStreamsPerSocket: 1,
      maxConcurrentStreamsPerMachine: 2,
    };

    expect(protocol.resolveMachineRpcRelayFallbackDecision({
      policy,
      deploymentKind: 'shared_server',
      relayEnabled: false,
    })).toEqual({
      ok: false,
      routeKind: 'server_relay',
      reasonCode: 'relay_disabled_by_policy',
    });
    expect(protocol.resolveMachineRpcRelayFallbackDecision({
      policy,
      deploymentKind: 'self_hosted',
      relayEnabled: true,
    })).toEqual({
      ok: false,
      routeKind: 'server_relay',
      reasonCode: 'relay_caps_required',
    });
    expect(protocol.resolveMachineRpcRelayFallbackDecision({
      policy,
      deploymentKind: 'shared_server',
      relayEnabled: true,
      caps,
    })).toEqual({
      ok: true,
      routeKind: 'server_relay',
      caps,
      policy: policy.relayFallback,
    });
  });

  it('exposes canonical daemon voice STT relay tunnel identifiers for tunnel policy consumers', async () => {
    const protocol = await importRpcPolicy();
    expect(protocol).toHaveProperty('createDaemonVoiceSttRelayTunnelId');
    expect(protocol).toHaveProperty('isDaemonVoiceSttRelayTunnelId');
    if ('importError' in protocol) throw protocol.importError;

    const tunnelId = protocol.createDaemonVoiceSttRelayTunnelId({
      machineId: 'machine-1',
      requestId: 'request-1',
    });

    expect(tunnelId).toBe('voice-stt:machine-1:request-1');
    expect(protocol.isDaemonVoiceSttRelayTunnelId(tunnelId)).toBe(true);
    expect(protocol.isDaemonVoiceSttRelayTunnelId('tun_generic')).toBe(false);
    expect(protocol.DAEMON_VOICE_AUDIO_RELAY_CAP_PROFILE_ID).toBe('machine_live_stream_relay_caps_v1');
  });

  it('rejects direct voice relay fallback rows that do not require authorization, caps, metering, and lifecycle receipts', async () => {
    const protocol = await importRpcPolicy();
    expect(protocol).toHaveProperty('validateMachineRpcRoutePolicies');
    if ('importError' in protocol) throw protocol.importError;

    const unsafeVoiceRelayPolicy = {
      method: RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_STREAM_CHUNK,
      routeClass: 'direct_medium_risk_receipted',
      rationale: 'fixture unsafe voice relay row',
      ownerPacket: 'PMS-5',
      rpcClassification: 'internal_only',
      commandReceiptRequired: true,
      scope: {
        accountRequired: true,
        machineRequired: true,
        sessionRequired: false,
        serverRequired: false,
      },
      relayFallback: {
        flowKind: 'daemon_voice_audio',
        defaultSharedServerMode: 'enabled',
        authorizationRequired: false,
        relayCapsRequired: false,
        meteringRequired: false,
        lifecycleReceiptRequired: false,
        capProfile: 'machine_live_stream_relay_caps_v1',
      },
    } as const;

    const result = protocol.validateMachineRpcRoutePolicies([unsafeVoiceRelayPolicy]);

    expect(result.ok).toBe(false);
    expect(result.invalidMethods).toContain(RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_STREAM_CHUNK);
  });

  it('rejects daemon voice relay fallback metadata on non-voice direct methods', async () => {
    const protocol = await importRpcPolicy();
    expect(protocol).toHaveProperty('validateMachineRpcRoutePolicies');
    if ('importError' in protocol) throw protocol.importError;

    const nonVoiceRelayPolicy = {
      method: RPC_METHODS.DAEMON_LOCAL_SERVICES_LAUNCHER_START,
      routeClass: 'direct_medium_risk_receipted',
      rationale: 'fixture non-voice direct method with daemon voice relay metadata',
      ownerPacket: 'PMS-5',
      rpcClassification: 'internal_only',
      commandReceiptRequired: true,
      scope: {
        accountRequired: true,
        machineRequired: true,
        sessionRequired: false,
        serverRequired: false,
      },
      relayFallback: {
        flowKind: 'daemon_voice_audio',
        defaultSharedServerMode: 'disabled',
        authorizationRequired: true,
        relayCapsRequired: true,
        meteringRequired: true,
        lifecycleReceiptRequired: true,
        capProfile: 'machine_live_stream_relay_caps_v1',
      },
    } as const;

    const result = protocol.validateMachineRpcRoutePolicies([nonVoiceRelayPolicy]);

    expect(result.ok).toBe(false);
    expect(result.invalidMethods).toContain(RPC_METHODS.DAEMON_LOCAL_SERVICES_LAUNCHER_START);
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
