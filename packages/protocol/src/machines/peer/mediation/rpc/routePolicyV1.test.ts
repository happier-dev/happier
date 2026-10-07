import { describe, expect, it } from 'vitest';

import { EXTERNAL_ACTION_DAEMON_RPC_METHOD_V1 } from '../../../../actions/externalActionApi.js';
import { HOST_PRIVATE_PLUGIN_INSTALL_DECISION_RPC_METHOD } from '../../../../marketplace/internal.js';
import {
  RPC_METHODS,
  SESSION_RPC_METHODS,
  resolveEphemeralRunnerMachineRpcAuthority as resolveEphemeralRunnerMachineRpcAuthorityFromRpcSubpath,
} from '../../../../rpc/index.js';
import { PeerFlowKindV1Schema } from '../flowKind.js';
import { resolveMachineRpcGovernance } from './governanceV1.js';

async function importRpcPolicy() {
  return await import('./index').catch((error: unknown) => ({ importError: error }));
}

describe('MachineRpcRoutePolicyV1', () => {
  it('keeps session role, notes and runtime mutations on the exact Session server route without granting Runner Machine access', async () => {
    const protocol = await importRpcPolicy();
    if ('importError' in protocol) throw protocol.importError;
    for (const method of [
      SESSION_RPC_METHODS.SESSION_ROLE_SET,
      SESSION_RPC_METHODS.SESSION_ROLES_CONFIGURATION_SET,
      SESSION_RPC_METHODS.SESSION_ROLES_OVERRIDE_SET,
      SESSION_RPC_METHODS.SESSION_ROLES_OVERRIDE_CLEAR,
      SESSION_RPC_METHODS.SESSION_ROLES_ADD,
      SESSION_RPC_METHODS.SESSION_ROLES_REMOVE,
      SESSION_RPC_METHODS.SESSION_NOTES_SET,
      SESSION_RPC_METHODS.SESSION_ROLES_APPLY_TO_REPORTS,
      SESSION_RPC_METHODS.SESSION_WORKFLOW_STEP_WITHDRAW,
      SESSION_RPC_METHODS.SESSION_PROVIDER_CLI_ATTACH_PREPARE,
    ]) {
      expect(protocol.resolveMachineRpcRoutePolicy(method)).toMatchObject({
        routeClass: 'server_required', serverRequiredReason: 'durable_session_write',
        scope: { accountRequired: true, machineRequired: true, sessionRequired: true, serverRequired: true },
      });
      expect(protocol.resolveEphemeralRunnerMachineRpcAuthority(method)).toBeNull();
    }
  });

  it('binds SCM comparison operations to their existing Action authority without opening direct or Runner routes', async () => {
    const protocol = await importRpcPolicy();
    if ('importError' in protocol) throw protocol.importError;
    const methods = [
      [RPC_METHODS.SCM_DIFF_SUMMARY_CAPTURE, 'scm.diffSummary.capture'],
      [RPC_METHODS.SCM_DIFF_SUMMARY_RESULT_EDIT, 'scm.diffSummary.result.edit'],
      [RPC_METHODS.SCM_DIFF_SUMMARY_RESULT_UNDO, 'scm.diffSummary.result.undo'],
      [RPC_METHODS.SCM_DIFF_SUMMARY_RESULT_DELETE, 'scm.diffSummary.result.delete'],
      [RPC_METHODS.SCM_DIFF_SUMMARY_RESULT_CLEAR, 'scm.diffSummary.result.clear'],
      [RPC_METHODS.SCM_DIFF_SUMMARY_REFINE, 'scm.diffSummary.refine'],
      [RPC_METHODS.SCM_DIFF_SUMMARY_ADD_OUTPUTS, 'scm.diffSummary.addOutputs'],
      [RPC_METHODS.SCM_DIFF_SUMMARY_DISCUSS, 'scm.diffSummary.discuss'],
      [RPC_METHODS.SCM_DIFF_SUMMARY_REVIEWED_MARK, 'scm.diffSummary.reviewed.mark'],
      [RPC_METHODS.SCM_DIFF_SUMMARY_REVIEWED_UNMARK, 'scm.diffSummary.reviewed.unmark'],
      [RPC_METHODS.SCM_COMMIT_RESOLVE_OUTCOME, 'scm.commit.resolveOutcome'],
      [RPC_METHODS.SCM_COMMIT_UNDO_LAST, 'scm.commit.undoLast'],
    ] as const;
    for (const [method, actionSpecId] of methods) {
      expect(protocol.resolveMachineRpcRoutePolicy(method)).toMatchObject({
        routeClass: 'server_required', rpcClassification: 'action_spec_bound', actionSpecId,
      });
      expect(protocol.resolveEphemeralRunnerMachineRpcAuthority(method)).toBeNull();
    }
  });
  it('keeps explicit machine log reads on the classified Account and Machine server route', async () => {
    const protocol = await importRpcPolicy();
    if ('importError' in protocol) throw protocol.importError;
    expect(protocol.resolveMachineRpcRoutePolicy('daemon.session.log.tail')).toMatchObject({
      routeClass: 'server_required', serverRequiredReason: 'ambiguous',
      scope: { accountRequired: true, machineRequired: true, serverRequired: true },
    });
    expect(protocol.resolveEphemeralRunnerMachineRpcAuthority('daemon.session.log.tail')).toBeNull();
  });

  it('admits session-filtered browser view discovery through exact-machine internal transport', async () => {
    const protocol = await importRpcPolicy();
    if ('importError' in protocol) throw protocol.importError;
    expect(resolveMachineRpcGovernance(RPC_METHODS.DAEMON_BROWSER_VIEW_LIST)).toEqual({ rpcClassification: 'internal_only' });
    expect(protocol.resolveMachineRpcRoutePolicy(RPC_METHODS.DAEMON_BROWSER_VIEW_LIST)).toMatchObject({
      routeClass: 'direct_ephemeral', rpcClassification: 'internal_only', commandReceiptRequired: false,
      scope: { accountRequired: true, machineRequired: true, sessionRequired: false, serverRequired: false },
    });
  });
  it('keeps daemon_voice_audio as an RPC fallback classification outside peer media flows', () => {
    expect(PeerFlowKindV1Schema.safeParse('daemon_voice_audio').success).toBe(false);
    expect(PeerFlowKindV1Schema.safeParse('voice_media').success).toBe(true);
  });

  it('classifies every deployed RPC and session RPC method exactly once', async () => {
    const protocol = await importRpcPolicy();
    expect(protocol).toHaveProperty('validateMachineRpcRoutePolicies');
    if ('importError' in protocol) throw protocol.importError;

    const result = protocol.validateMachineRpcRoutePolicies();

    expect(result.missingMethods).toEqual([]);
    expect(result.unknownMethods).toEqual([]);
    expect(result.duplicateMethods).toEqual([]);
    expect(result.invalidMethods).toEqual([]);
    expect(result.ok).toBe(true);
    // Two classified methods are owned outside the two method literal maps:
    // the host-private plugin install decision and the closed server-origin
    // public Action dispatch.
    expect(result.policies).toHaveLength(
      Object.keys(RPC_METHODS).length + Object.keys(SESSION_RPC_METHODS).length + 2,
    );
  });

  it('keeps workspace content search on the Account and Machine server route with its read Action authority', async () => {
    const protocol = await importRpcPolicy();
    if ('importError' in protocol) throw protocol.importError;
    expect(resolveMachineRpcGovernance(RPC_METHODS.DAEMON_WORKSPACE_FILES_SEARCH)).toEqual({
      rpcClassification: 'action_spec_bound', actionSpecId: 'workspace.files.search',
    });
    expect(protocol.resolveMachineRpcRoutePolicy(RPC_METHODS.DAEMON_WORKSPACE_FILES_SEARCH)).toMatchObject({
      routeClass: 'server_required', serverRequiredReason: 'ambiguous',
      rpcClassification: 'action_spec_bound', actionSpecId: 'workspace.files.search',
      scope: { accountRequired: true, machineRequired: true, serverRequired: true },
    });
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
    for (const method of [
      RPC_METHODS.SPAWN_HAPPY_SESSION_PROVIDER_SAFE,
      RPC_METHODS.SESSION_FORK_PROVIDER_SAFE,
    ]) {
      expect(protocol.resolveMachineRpcRoutePolicy(method)).toMatchObject({
        routeClass: 'server_required',
        serverRequiredReason: 'durable_session_write',
        commandReceiptRequired: false,
      });
    }
    expect(protocol.resolveMachineRpcRoutePolicy('not.registered')).toMatchObject({
      routeClass: 'server_required',
      serverRequiredReason: 'unclassified',
    });
  });

  it('routes approved Artifact replay through authenticated server authority to its exact daemon', async () => {
    const protocol = await importRpcPolicy();
    if ('importError' in protocol) throw protocol.importError;

    expect(protocol.resolveMachineRpcRoutePolicy(
      RPC_METHODS.APPROVAL_REQUEST_REPLAY_APPROVED,
    )).toMatchObject({
      routeClass: 'server_required',
      serverRequiredReason: 'auth',
      rpcClassification: 'internal_only',
      commandReceiptRequired: false,
      scope: {
        accountRequired: true,
        machineRequired: true,
        sessionRequired: false,
        serverRequired: true,
      },
    });
  });

  it('keeps pending-message Composer admission on the exact Session server route', async () => {
    const protocol = await importRpcPolicy();
    if ('importError' in protocol) throw protocol.importError;

    for (const method of [
      SESSION_RPC_METHODS.SESSION_PENDING_MESSAGE_COMPOSER_ADMISSION_PREPARE_V1,
      SESSION_RPC_METHODS.SESSION_PENDING_MESSAGE_COMPOSER_ADMISSION_ACCEPTED_V1,
    ]) {
      expect(protocol.resolveMachineRpcRoutePolicy(method)).toMatchObject({
        routeClass: 'server_required',
        serverRequiredReason: 'durable_session_write',
        commandReceiptRequired: false,
        scope: expect.objectContaining({
          accountRequired: true,
          machineRequired: true,
          sessionRequired: true,
          serverRequired: true,
        }),
      });
    }
  });

  it('keeps Team credential broker reads behind the Account server route', async () => {
    const protocol = await importRpcPolicy();
    if ('importError' in protocol) throw protocol.importError;

    for (const method of [
      RPC_METHODS.DAEMON_PROVIDERS_TEAM_CREDENTIAL_REQUEST_POLICY_SUPPORT,
      RPC_METHODS.DAEMON_PROVIDERS_TEAM_CREDENTIAL_RESOURCE_TEST_CANDIDATE,
      RPC_METHODS.DAEMON_PROVIDERS_TEAM_CREDENTIAL_BROKER_ELIGIBILITY,
    ]) {
      expect(protocol.resolveMachineRpcRoutePolicy(method)).toMatchObject({
        routeClass: 'server_required',
        serverRequiredReason: 'ambiguous',
        rpcClassification: 'internal_only',
        commandReceiptRequired: false,
        scope: {
          accountRequired: true,
          machineRequired: true,
          sessionRequired: false,
          serverRequired: true,
        },
      });
    }
  });

  it('keeps daemon Voice settings Actions on the authenticated local-mutation route', async () => {
    const protocol = await importRpcPolicy();
    if ('importError' in protocol) throw protocol.importError;

    expect(protocol.resolveMachineRpcRoutePolicy(
      RPC_METHODS.DAEMON_VOICE_SPEECH_SETTINGS_ACTION_EXECUTE,
    )).toMatchObject({
      routeClass: 'server_required',
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

  it('keeps detached Execution Run permission responses on the authenticated exact-Machine server route', async () => {
    const protocol = await importRpcPolicy();
    if ('importError' in protocol) throw protocol.importError;

    expect(protocol.resolveMachineRpcRoutePolicy(
      RPC_METHODS.DAEMON_EXECUTION_RUN_PERMISSION_RESPOND,
    )).toMatchObject({
      routeClass: 'server_required',
      serverRequiredReason: 'destructive_or_recovery_mutation',
      commandReceiptRequired: false,
      scope: {
        accountRequired: true,
        machineRequired: true,
        sessionRequired: false,
        serverRequired: true,
      },
    });
  });

  it('keeps live Execution Run broker-currentness resolution on the authenticated Session-owner route', async () => {
    const protocol = await importRpcPolicy();
    if ('importError' in protocol) throw protocol.importError;

    expect(protocol.resolveMachineRpcRoutePolicy(
      SESSION_RPC_METHODS.EXECUTION_RUN_BROKER_AUTHORITY_RESOLVE_V1,
    )).toMatchObject({
      routeClass: 'server_required',
      serverRequiredReason: 'auth',
      commandReceiptRequired: false,
      scope: {
        accountRequired: true,
        machineRequired: true,
        sessionRequired: true,
        serverRequired: true,
      },
    });
  });

  it('classifies private Session spawn lifecycle transports as internal-only', async () => {
    const protocol = await importRpcPolicy();
    if ('importError' in protocol) throw protocol.importError;

    for (const method of [
      RPC_METHODS.SPAWN_HAPPY_SESSION,
      RPC_METHODS.SPAWN_HAPPY_SESSION_PROVIDER_SAFE,
    ]) {
      expect(resolveMachineRpcGovernance(method)).toEqual({
        rpcClassification: 'internal_only',
      });
      expect(protocol.resolveMachineRpcRoutePolicy(method)).toMatchObject({
        rpcClassification: 'internal_only',
      });
    }
  });

  it('classifies the public Session creation Action as a server-routed ActionSpec method', async () => {
    const protocol = await importRpcPolicy();
    if ('importError' in protocol) throw protocol.importError;

    expect(resolveMachineRpcGovernance(RPC_METHODS.SESSION_SPAWN_NEW)).toEqual({
      rpcClassification: 'action_spec_bound',
      actionSpecId: 'session.spawn_new',
    });
    expect(protocol.resolveMachineRpcRoutePolicy(RPC_METHODS.SESSION_SPAWN_NEW)).toMatchObject({
      routeClass: 'server_required',
      serverRequiredReason: 'durable_session_write',
      rpcClassification: 'action_spec_bound',
      actionSpecId: 'session.spawn_new',
      commandReceiptRequired: false,
    });
  });

  it('keeps route-independent direct import abort authenticated through the server control plane', async () => {
    const protocol = await importRpcPolicy();
    expect(protocol).toHaveProperty('resolveMachineRpcRoutePolicy');
    if ('importError' in protocol) throw protocol.importError;

    expect(protocol.resolveMachineRpcRoutePolicy(
      RPC_METHODS.DAEMON_DIRECT_TRANSFER_IMPORT_ABORT,
    )).toMatchObject({
      routeClass: 'server_required',
      serverRequiredReason: 'server_persistence',
      commandReceiptRequired: false,
      scope: expect.objectContaining({
        accountRequired: true,
        machineRequired: true,
        serverRequired: true,
      }),
    });
  });

  it('keeps Composer media capability negotiation, custody claim, and completed release on the server transfer-control route', async () => {
    const protocol = await importRpcPolicy();
    expect(protocol).toHaveProperty('resolveMachineRpcRoutePolicy');
    if ('importError' in protocol) throw protocol.importError;

    for (const method of [
      RPC_METHODS.DAEMON_TRANSFER_COMPOSER_MEDIA_CAPABILITY_GET_V1,
      RPC_METHODS.DAEMON_TRANSFER_COMPOSER_MEDIA_CLAIM,
      RPC_METHODS.DAEMON_TRANSFER_COMPOSER_MEDIA_RELEASE,
    ]) {
      expect(protocol.resolveMachineRpcRoutePolicy(method)).toMatchObject({
        routeClass: 'server_required',
        serverRequiredReason: 'server_persistence',
        commandReceiptRequired: false,
        scope: expect.objectContaining({
          accountRequired: true,
          machineRequired: true,
          serverRequired: true,
        }),
      });
    }
  });

  it('publishes the exact Session authority for the reusable Runner Machine service surface', async () => {
    const protocol = await importRpcPolicy();
    if ('importError' in protocol) throw protocol.importError;

    for (const method of [
      RPC_METHODS.READ_FILE,
      RPC_METHODS.LIST_DIRECTORY,
      RPC_METHODS.GET_DIRECTORY_TREE,
      RPC_METHODS.DAEMON_FILESYSTEM_LIST_ROOTS,
      RPC_METHODS.DAEMON_FILESYSTEM_LIST_DIRECTORY,
      RPC_METHODS.STAT_FILE,
      RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_INIT,
      RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_CHUNK,
      RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_FINALIZE,
      RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_ABORT,
      RPC_METHODS.DAEMON_DIRECT_TRANSFER_EXPORT_PREPARE,
      RPC_METHODS.DAEMON_DIRECT_TRANSFER_EXPORT_RELEASE,
      RPC_METHODS.DAEMON_LOCAL_SERVICES_INVENTORY_SNAPSHOT,
      RPC_METHODS.DAEMON_LOCAL_SERVICES_INVENTORY_WATCH,
      RPC_METHODS.DAEMON_LOCAL_SERVICES_LAUNCHER_SNAPSHOT,
      RPC_METHODS.DAEMON_LOCAL_SERVICES_PREVIEW_SNAPSHOT,
      RPC_METHODS.DAEMON_LOCAL_SERVICES_PUBLIC_PREVIEW_STATUS,
      RPC_METHODS.DAEMON_LOCAL_SERVICES_PUBLIC_PREVIEW_COPY_URL,
      RPC_METHODS.DAEMON_TERMINAL_STREAM_READ,
      RPC_METHODS.DAEMON_TERMINAL_LIST,
      RPC_METHODS.DAEMON_TERMINAL_STREAM_READ_BYTES,
      RPC_METHODS.DAEMON_TERMINAL_STREAM_ACK,
    ]) {
      expect(protocol.resolveEphemeralRunnerMachineRpcAuthority(method)).toBe('readTranscript');
    }
    for (const method of [
      RPC_METHODS.WRITE_FILE,
      RPC_METHODS.CREATE_DIRECTORY,
      RPC_METHODS.RENAME_PATH,
      RPC_METHODS.DELETE_PATH,
      RPC_METHODS.DAEMON_TRANSFER_UPLOAD_INIT,
      RPC_METHODS.DAEMON_TRANSFER_UPLOAD_CHUNK,
      RPC_METHODS.DAEMON_TRANSFER_UPLOAD_FINALIZE,
      RPC_METHODS.DAEMON_TRANSFER_UPLOAD_ABORT,
      RPC_METHODS.DAEMON_DIRECT_TRANSFER_IMPORT_PREPARE,
      RPC_METHODS.DAEMON_DIRECT_TRANSFER_IMPORT_ABORT,
      RPC_METHODS.DAEMON_LOCAL_SERVICES_INVENTORY_REFRESH,
      RPC_METHODS.DAEMON_LOCAL_SERVICES_PREVIEW_OPEN_OR_CREATE,
      RPC_METHODS.DAEMON_LOCAL_SERVICES_PREVIEW_REVOKE,
      RPC_METHODS.DAEMON_TERMINAL_ENSURE,
      RPC_METHODS.DAEMON_TERMINAL_STREAM_INPUT,
      RPC_METHODS.DAEMON_TERMINAL_INPUT,
      RPC_METHODS.DAEMON_TERMINAL_RESIZE,
      RPC_METHODS.DAEMON_TERMINAL_CLOSE,
      RPC_METHODS.DAEMON_TERMINAL_RESTART,
    ]) {
      expect(protocol.resolveEphemeralRunnerMachineRpcAuthority(method)).toBe('submitAgentInput');
    }
    expect(protocol.resolveEphemeralRunnerMachineRpcAuthority(
      RPC_METHODS.DAEMON_SESSION_FOLLOW_SOURCE_KEY_PREPARE,
    )).toBe('followSourceKeyPreparation');
    expect(protocol.resolveEphemeralRunnerMachineRpcAuthority(RPC_METHODS.STOP_SESSION)).toBe('stopSession');
    for (const method of [
      RPC_METHODS.DAEMON_LOCAL_SERVICES_PUBLIC_PREVIEW_CREATE,
      RPC_METHODS.DAEMON_LOCAL_SERVICES_PUBLIC_PREVIEW_REVOKE,
    ]) {
      expect(protocol.resolveEphemeralRunnerMachineRpcAuthority(method)).toBe('manageAccess');
    }
    expect(protocol.resolveEphemeralRunnerMachineRpcAuthority(RPC_METHODS.STOP_DAEMON)).toBeNull();
    expect(protocol.resolveEphemeralRunnerMachineRpcAuthority('unknown.method')).toBeNull();
    expect(resolveEphemeralRunnerMachineRpcAuthorityFromRpcSubpath(RPC_METHODS.READ_FILE))
      .toBe('readTranscript');
  });

  it('derives every restricted Runner authority from the canonical route policy rows', async () => {
    const protocol = await importRpcPolicy();
    if ('importError' in protocol) throw protocol.importError;

    // `routePolicyV1` is the sole classifier: a method is Runner-reachable
    // because its own policy row says so, never because a second map lists it.
    const classified = protocol.MACHINE_RPC_ROUTE_POLICIES
      .filter((policy) => policy.ephemeralRunnerAuthority !== undefined);
    expect(classified.length).toBeGreaterThan(0);
    for (const policy of protocol.MACHINE_RPC_ROUTE_POLICIES) {
      expect(protocol.resolveEphemeralRunnerMachineRpcAuthority(policy.method))
        .toBe(policy.ephemeralRunnerAuthority ?? null);
    }
  });

  it('keeps quota recovery, connected-service auth, and terminal composer controls server-routed', async () => {
    const protocol = await importRpcPolicy();
    expect(protocol).toHaveProperty('resolveMachineRpcRoutePolicy');
    if ('importError' in protocol) throw protocol.importError;

    for (const method of [
      SESSION_RPC_METHODS.SESSION_CONNECTED_SERVICE_AUTH_APPLY_GENERATION,
      SESSION_RPC_METHODS.SESSION_CONNECTED_SERVICE_AUTH_READ_RUNTIME_IDENTITY,
      SESSION_RPC_METHODS.SESSION_PROVIDER_INPUT_ADMISSION,
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
      SESSION_RPC_METHODS.SESSION_PENDING_INPUT_INTERRUPT_AND_RUN,
    )).toMatchObject({
      routeClass: 'server_required',
      serverRequiredReason: 'destructive_or_recovery_mutation',
      rpcClassification: 'action_spec_bound',
      actionSpecId: 'session.pendingInput.interruptAndRun',
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

  it('classifies plugin artifact, composer-input, and simulator preview RPCs as direct internal daemon transports', async () => {
    const protocol = await importRpcPolicy();
    expect(protocol).toHaveProperty('resolveMachineRpcRoutePolicy');
    if ('importError' in protocol) throw protocol.importError;

    for (const method of [
      RPC_METHODS.DAEMON_PLUGIN_UI_ARTIFACT_BYTES_READ,
      RPC_METHODS.DAEMON_PLUGIN_COMPOSER_REFERENCE_SEARCH,
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

  it('routes transient connected-account form option reads directly without advertising account authority', async () => {
    const protocol = await importRpcPolicy();
    if ('importError' in protocol) throw protocol.importError;

    expect(resolveMachineRpcGovernance(
      RPC_METHODS.DAEMON_PLUGIN_ACTION_FORM_CONNECTED_ACCOUNT_OPTIONS_RESOLVE,
    )).toEqual({ rpcClassification: 'internal_only' });
    expect(protocol.resolveMachineRpcRoutePolicy(
      RPC_METHODS.DAEMON_PLUGIN_ACTION_FORM_CONNECTED_ACCOUNT_OPTIONS_RESOLVE,
    )).toMatchObject({
      routeClass: 'direct_ephemeral',
      rpcClassification: 'internal_only',
      commandReceiptRequired: false,
      scope: {
        accountRequired: true,
        machineRequired: true,
        sessionRequired: false,
        serverRequired: false,
      },
    });
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

  it('routes daemon-local plugin settings reads and revision watches directly and receipts settings writes', async () => {
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
    expect(protocol.resolveMachineRpcRoutePolicy(RPC_METHODS.DAEMON_PLUGIN_SETTINGS_WATCH)).toMatchObject({
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
    expect(protocol.resolveMachineRpcRoutePolicy(
      RPC_METHODS.DAEMON_PLUGIN_COLLECTION_CANDIDATE_PREPARATION_EXECUTE,
    )).toMatchObject({
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
    expect(protocol.resolveMachineRpcRoutePolicy(RPC_METHODS.DAEMON_PLUGIN_SECRET_STATUS)).toMatchObject({
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
    expect(protocol.resolveMachineRpcRoutePolicy(RPC_METHODS.DAEMON_PLUGIN_SECRET_SET)).toMatchObject({
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
    expect(protocol.resolveMachineRpcRoutePolicy(RPC_METHODS.DAEMON_PLUGIN_SECRET_DELETE)).toMatchObject({
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

  it('routes exact-machine plugin invocation log reads directly with no server persistence', async () => {
    const protocol = await importRpcPolicy();
    expect(protocol).toHaveProperty('resolveMachineRpcRoutePolicy');
    if ('importError' in protocol) throw protocol.importError;

    expect(resolveMachineRpcGovernance(
      RPC_METHODS.DAEMON_PLUGIN_INVOCATION_LOGS_READ,
    )).toEqual({ rpcClassification: 'internal_only' });
    expect(protocol.resolveMachineRpcRoutePolicy(
      RPC_METHODS.DAEMON_PLUGIN_INVOCATION_LOGS_READ,
    )).toMatchObject({
      routeClass: 'direct_ephemeral',
      rpcClassification: 'internal_only',
      commandReceiptRequired: false,
      scope: {
        accountRequired: true,
        machineRequired: true,
        sessionRequired: false,
        serverRequired: false,
      },
    });
  });

  it('routes the host-private plugin install decision directly without advertising it in the public RPC catalog', async () => {
    expect(Object.values(RPC_METHODS)).not.toContain('daemon.plugins.install.review.decide');

    const protocol = await importRpcPolicy();
    expect(protocol).toHaveProperty('resolveMachineRpcRoutePolicy');
    if ('importError' in protocol) throw protocol.importError;

    expect(protocol.resolveMachineRpcRoutePolicy(
      HOST_PRIVATE_PLUGIN_INSTALL_DECISION_RPC_METHOD,
    )).toMatchObject({
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

  it('routes daemon-local plugin discovery and rendering reads directly while receipting mutations and actions', async () => {
    const protocol = await importRpcPolicy();
    expect(protocol).toHaveProperty('resolveMachineRpcRoutePolicy');
    if ('importError' in protocol) throw protocol.importError;

    for (const method of [
      RPC_METHODS.DAEMON_MARKETPLACE_INDEX_QUERY,
      RPC_METHODS.DAEMON_NPM_REGISTRY_PROFILES_GET,
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
      RPC_METHODS.DAEMON_NPM_REGISTRY_PROFILES_MUTATE,
      RPC_METHODS.DAEMON_PLUGIN_STRUCTURED_MESSAGE_ACTION_EXECUTE,
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

  it('routes exact-machine Voice diagnostics reads directly and receipts local policy, deletion, and export lifecycle mutations', async () => {
    const protocol = await importRpcPolicy();
    expect(protocol).toHaveProperty('resolveMachineRpcRoutePolicy');
    if ('importError' in protocol) throw protocol.importError;

    for (const method of [
      RPC_METHODS.DAEMON_VOICE_DIAGNOSTICS_STATUS,
      RPC_METHODS.DAEMON_VOICE_DIAGNOSTICS_ARTIFACT_DOWNLOAD_CHUNK,
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
      RPC_METHODS.DAEMON_VOICE_DIAGNOSTICS_CONFIGURE,
      RPC_METHODS.DAEMON_VOICE_DIAGNOSTICS_DELETE_ALL,
      RPC_METHODS.DAEMON_VOICE_DIAGNOSTICS_REVOKE_CAPTURE,
      RPC_METHODS.DAEMON_VOICE_DIAGNOSTICS_ARTIFACT_DOWNLOAD_INIT,
      RPC_METHODS.DAEMON_VOICE_DIAGNOSTICS_ARTIFACT_DOWNLOAD_FINALIZE,
      RPC_METHODS.DAEMON_VOICE_DIAGNOSTICS_ARTIFACT_DOWNLOAD_ABORT,
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

  it('keeps verdict-free Pending wake discovery and publication on the authenticated exact-session route', async () => {
    const protocol = await importRpcPolicy();
    expect(protocol).toHaveProperty('resolveMachineRpcRoutePolicy');
    if ('importError' in protocol) throw protocol.importError;

    for (const method of [
      SESSION_RPC_METHODS.SESSION_PENDING_QUEUE_WAKE_CAPABILITY_GET_V1,
      SESSION_RPC_METHODS.SESSION_PENDING_QUEUE_WAKE_V1,
    ]) {
      expect(protocol.resolveMachineRpcRoutePolicy(method)).toMatchObject({
        routeClass: 'server_required',
        serverRequiredReason: 'pending_queue',
        commandReceiptRequired: false,
        scope: expect.objectContaining({
          accountRequired: true,
          machineRequired: true,
          sessionRequired: true,
          serverRequired: true,
        }),
      });
    }
  });

  it('keeps managed-service endpoint reads on the authenticated exact-session route', async () => {
    const protocol = await importRpcPolicy();
    expect(protocol).toHaveProperty('resolveMachineRpcRoutePolicy');
    if ('importError' in protocol) throw protocol.importError;

    for (const method of [
      SESSION_RPC_METHODS.SESSION_MANAGED_SERVICE_ENDPOINT_READ_OPEN_V1,
      SESSION_RPC_METHODS.SESSION_MANAGED_SERVICE_ENDPOINT_READ_NEXT_V1,
      SESSION_RPC_METHODS.SESSION_MANAGED_SERVICE_ENDPOINT_READ_CANCEL_V1,
    ]) {
      expect(protocol.resolveMachineRpcRoutePolicy(method)).toMatchObject({
        routeClass: 'server_required',
        serverRequiredReason: 'auth',
        rpcClassification: 'internal_only',
        commandReceiptRequired: false,
        scope: expect.objectContaining({
          accountRequired: true,
          machineRequired: true,
          sessionRequired: true,
          serverRequired: true,
        }),
      });
    }
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
      RPC_METHODS.DAEMON_LOCAL_SERVICES_INVENTORY_WATCH,
      RPC_METHODS.DAEMON_LOCAL_SERVICES_LAUNCHER_SNAPSHOT,
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

    // The released `daemon.directSessions.candidate.delete` spelling dispatches
    // the same canonical Action through the ActionSpec alias, so mediation must
    // classify it identically to canonical delete. Left unmapped it degrades to
    // `advisory_unclassified`/`unclassified`, which loses the Action binding the
    // destructive mutation is governed by and makes the released method the one
    // external-session row this table cannot classify.
    for (const method of [
      RPC_METHODS.DAEMON_EXTERNAL_SESSION_CANDIDATE_DELETE,
      RPC_METHODS.DAEMON_DIRECT_SESSION_CANDIDATE_DELETE_LEGACY,
    ]) {
      expect(resolveMachineRpcGovernance(method)).toEqual({
        rpcClassification: 'action_spec_bound',
        actionSpecId: 'sessions.external.candidate.delete',
      });
      expect(protocol.resolveMachineRpcRoutePolicy(method)).toMatchObject({
        routeClass: 'server_required',
        serverRequiredReason: 'destructive_or_recovery_mutation',
        rpcClassification: 'action_spec_bound',
        actionSpecId: 'sessions.external.candidate.delete',
        commandReceiptRequired: false,
      });
    }

    const operationActions = [
      [RPC_METHODS.DAEMON_EXTERNAL_SESSION_MATERIALIZE_START, 'sessions.external.materialize.start'],
      [RPC_METHODS.DAEMON_EXTERNAL_SESSION_TAKEOVER_START, 'sessions.external.takeover.start'],
      [RPC_METHODS.DAEMON_EXTERNAL_SESSION_OPERATION_STATUS_GET, 'sessions.external.operation.status.get'],
      [RPC_METHODS.DAEMON_EXTERNAL_SESSION_OPERATION_CANCEL, 'sessions.external.operation.cancel'],
      [RPC_METHODS.DAEMON_EXTERNAL_SESSION_OPERATION_RESUME, 'sessions.external.operation.resume'],
      [RPC_METHODS.DAEMON_EXTERNAL_SESSION_OPERATION_RETRY, 'sessions.external.operation.retry'],
      [RPC_METHODS.DAEMON_EXTERNAL_SESSION_OPERATION_DISCARD, 'sessions.external.operation.discard'],
    ] as const;
    for (const [rpcMethod, actionSpecId] of operationActions) {
      expect(protocol.resolveMachineRpcRoutePolicy(rpcMethod)).toMatchObject({
        routeClass: 'server_required',
        rpcClassification: 'action_spec_bound',
        actionSpecId,
      });
    }
    expect(protocol.resolveMachineRpcRoutePolicy(
      RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_RESUME_V3,
    )).toMatchObject({
      routeClass: 'server_required',
      rpcClassification: 'action_spec_bound',
      actionSpecId: 'session.handoff.prepare_target.resume',
    });
    for (const [method, actionSpecId] of [
      [RPC_METHODS.DAEMON_SESSION_HANDOFF_START_V3, 'session.handoff'],
      [RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_V3, 'session.handoff.prepare_target'],
      [RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_RESULT_GET_V3, 'session.handoff.prepare_target_result.get'],
      [RPC_METHODS.DAEMON_SESSION_HANDOFF_COMMIT_V3, 'session.handoff.commit'],
      [RPC_METHODS.DAEMON_SESSION_HANDOFF_ABORT_V3, 'session.handoff.abort'],
      [RPC_METHODS.DAEMON_SESSION_HANDOFF_STATUS_GET_V3, 'session.handoff.status.get'],
    ] as const) {
      expect(protocol.resolveMachineRpcRoutePolicy(method)).toMatchObject({
        routeClass: 'server_required',
        rpcClassification: 'action_spec_bound',
        actionSpecId,
      });
    }
  });

  it('keeps predecessor V2 session handoff routes on their canonical server-scoped policies', async () => {
    const protocol = await importRpcPolicy();
    expect(protocol).toHaveProperty('resolveMachineRpcRoutePolicy');
    if ('importError' in protocol) throw protocol.importError;

    const canonicalCounterparts = [
      [RPC_METHODS.DAEMON_SESSION_HANDOFF_CAPABILITY_V2_GET, RPC_METHODS.DAEMON_SESSION_HANDOFF_STATUS_GET],
      [RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_V2, RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET],
      [RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_RESULT_GET_V2, RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_RESULT_GET],
      [RPC_METHODS.DAEMON_SESSION_HANDOFF_TARGET_RESUME_V2, RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_RESUME_V3],
      [RPC_METHODS.DAEMON_SESSION_HANDOFF_TARGET_CONFIRM_V2, RPC_METHODS.DAEMON_SESSION_HANDOFF_COMMIT],
      [RPC_METHODS.DAEMON_SESSION_HANDOFF_COMMIT_V2, RPC_METHODS.DAEMON_SESSION_HANDOFF_COMMIT],
      [RPC_METHODS.DAEMON_SESSION_HANDOFF_ABORT_V2, RPC_METHODS.DAEMON_SESSION_HANDOFF_ABORT],
    ] as const;

    for (const [compatibilityMethod, canonicalMethod] of canonicalCounterparts) {
      const canonicalPolicy = protocol.resolveMachineRpcRoutePolicy(canonicalMethod);
      expect(protocol.resolveMachineRpcRoutePolicy(compatibilityMethod)).toMatchObject({
        routeClass: canonicalPolicy.routeClass,
        serverRequiredReason: canonicalPolicy.serverRequiredReason,
        commandReceiptRequired: canonicalPolicy.commandReceiptRequired,
        scope: canonicalPolicy.scope,
      });
    }
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
    expect(protocol.resolveMachineRpcRoutePolicy(
      SESSION_RPC_METHODS.EXECUTION_RUN_ENSURE_OR_START_PROVIDER_SAFE_V1,
    )).toMatchObject({
      routeClass: 'server_required',
      rpcClassification: 'action_spec_bound',
      actionSpecId: 'execution.run.ensure_or_start',
    });
    expect(protocol.resolveMachineRpcRoutePolicy(SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_READ)).toMatchObject({
      routeClass: 'server_required',
      rpcClassification: 'action_spec_bound',
      actionSpecId: 'execution.run.stream.read',
    });
    expect(protocol.resolveMachineRpcRoutePolicy(SESSION_RPC_METHODS.EXECUTION_RUN_WAIT)).toMatchObject({
      routeClass: 'server_required',
      rpcClassification: 'action_spec_bound',
      actionSpecId: 'execution.run.wait',
      serverRequiredReason: 'durable_session_write',
      scope: expect.objectContaining({
        accountRequired: true,
        machineRequired: true,
        sessionRequired: true,
        serverRequired: true,
      }),
    });
  });

  it('identifies A.12 voice cleanup RPC governance as internal-only without making transport direct', async () => {
    const protocol = await importRpcPolicy();
    expect(protocol).toHaveProperty('resolveMachineRpcRoutePolicy');
    if ('importError' in protocol) throw protocol.importError;

    const methods = [
      RPC_METHODS.DAEMON_VOICE_INFERENCE_MODELS_INSTALL,
      RPC_METHODS.DAEMON_VOICE_INFERENCE_MODELS_LICENSE_ACCEPT,
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

  it('routes bounded Google audio transfers like the canonical daemon voice transfer family', async () => {
    const protocol = await importRpcPolicy();
    expect(protocol).toHaveProperty('resolveMachineRpcRoutePolicy');
    if ('importError' in protocol) throw protocol.importError;

    for (const method of [
      RPC_METHODS.DAEMON_VOICE_SPEECH_TRANSCRIBE_UPLOAD_INIT,
      RPC_METHODS.DAEMON_VOICE_SPEECH_TRANSCRIBE_UPLOAD_CHUNK,
      RPC_METHODS.DAEMON_VOICE_SPEECH_TRANSCRIBE_UPLOAD_FINALIZE,
      RPC_METHODS.DAEMON_VOICE_SPEECH_TRANSCRIBE,
      RPC_METHODS.DAEMON_VOICE_SPEECH_SYNTHESIZE,
      RPC_METHODS.DAEMON_VOICE_SPEECH_DOWNLOAD_CHUNK,
      RPC_METHODS.DAEMON_VOICE_SPEECH_DOWNLOAD_FINALIZE,
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
      RPC_METHODS.DAEMON_VOICE_SPEECH_TRANSCRIBE_UPLOAD_ABORT,
      RPC_METHODS.DAEMON_VOICE_SPEECH_DOWNLOAD_ABORT,
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
    expect(protocol).toHaveProperty('createVoiceMediaRelayTunnelId');
    expect(protocol).toHaveProperty('isVoiceMediaRelayTunnelId');
    if ('importError' in protocol) throw protocol.importError;

    const tunnelId = protocol.createVoiceMediaRelayTunnelId({
      machineId: 'machine-1',
      requestId: 'request-1',
    });

    expect(tunnelId).toBe('voice-media:machine-1:request-1');
    expect(protocol.isVoiceMediaRelayTunnelId(tunnelId)).toBe(true);
    expect(protocol.isVoiceMediaRelayTunnelId('tun_generic')).toBe(false);
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

  it('classifies the closed server-origin Action dispatch as Runner-reachable on its own row', async () => {
    const protocol = await importRpcPolicy();
    expect(protocol).toHaveProperty('resolveMachineRpcRoutePolicy');
    if ('importError' in protocol) throw protocol.importError;

    expect(protocol.resolveMachineRpcRoutePolicy(EXTERNAL_ACTION_DAEMON_RPC_METHOD_V1)).toMatchObject({
      routeClass: 'server_required',
      serverRequiredReason: 'auth',
      ephemeralRunnerAuthority: 'externalActionDispatch',
    });
    expect(protocol.resolveEphemeralRunnerMachineRpcAuthority(EXTERNAL_ACTION_DAEMON_RPC_METHOD_V1))
      .toBe('externalActionDispatch');
    expect(resolveEphemeralRunnerMachineRpcAuthorityFromRpcSubpath(EXTERNAL_ACTION_DAEMON_RPC_METHOD_V1))
      .toBe('externalActionDispatch');
    expect(protocol.validateMachineRpcRoutePolicies().ok).toBe(true);
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
    // The follow lease and its release are one lifecycle: whatever route class serves
    // `transcript.follow` must also serve `transcript.unfollow`, or the lease is created on one
    // route and released on another. `transcript.unfollow` is additionally a `write`
    // (`actionSpecs.ts` `sideEffectClass`), so it is not eligible for a receipt-free direct class.
    for (const [method, actionSpecId] of [
      [RPC_METHODS.TRANSCRIPT_FOLLOW, 'transcript.follow'],
      [RPC_METHODS.TRANSCRIPT_UNFOLLOW, 'transcript.unfollow'],
    ] as const) {
      expect(protocol.resolveMachineRpcRoutePolicy(method)).toMatchObject({
        routeClass: 'server_required',
        serverRequiredReason: 'ambiguous',
        rpcClassification: 'action_spec_bound',
        actionSpecId,
        commandReceiptRequired: false,
      });
    }
  });
});
