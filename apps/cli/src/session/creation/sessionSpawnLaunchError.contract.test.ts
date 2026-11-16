import { describe, expect, it, vi } from 'vitest';
import fastify from 'fastify';
import { serializerCompiler } from 'fastify-type-provider-zod';
import { normalizeSpawnSessionErrorDetail } from '@happier-dev/protocol/spawnSession';
import { SessionSpawnNewResultV1Schema } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewResultV1';
import { SpawnSessionControlErrorResponseSchema, projectSpawnSessionControlErrorResponse } from '@/session/shared/spawnSessionContract';
import { projectSessionSpawnFailure } from './projectSessionSpawnFailure';
import { AccountEncryptionCurrentnessUnavailableError } from '@/api/client/accountEncryptionCurrentness';
import { readSessionCreationTerminalSpawnErrorDetail } from '@/api/session/sessionCreationTerminalSpawnErrorDetail';
import { buildSessionCreationTerminalSpawnErrorResult } from '@/daemon/sessions/onHappySessionWebhook';
import { createProviderErrorV1 } from '@happier-dev/protocol/providers/errors';
import { buildProviderSpawnErrorResult } from '@/daemon/spawn/buildProviderSpawnErrorResult';
import { buildConnectedServiceCredentialRefreshSpawnErrorResult } from '@/daemon/connectedServices/diagnostics/buildConnectedServiceDiagnosticSpawnErrorResult';
import { createHostActionOperationRuntime } from '@/daemon/actionOperations/createHostActionOperationRuntime';
import { PluginError } from '@happier-dev/plugin-sdk';
import { ApiMachineClient } from '@/api/apiMachine';
import { prepareDaemonAgentIsolationIdentity } from '@/daemon/spawn/prepareDaemonAgentIsolationIdentity';
import { createAgentIsolationMemberPreparationBoundary } from '@/daemon/agentIsolation/agentIsolationEffects.testkit';
import { SessionSpawnNewActionResultV1Schema, projectSessionSpawnNewActionResultV1 } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewResultV1';
import { createSessionAgentIsolationMemberPreparation } from '@/daemon/agentIsolation/sessionPreparation';
import { projectRunnerDaemonPluginServicesFailure, createRunnerDaemonPluginServicesPreparationError } from '@/daemon/agentRuntime/runnerDaemonPluginServicesHost';
import { AgentRuntimeDaemonServiceResponseV1Schema } from '@/agent/runtime/session/process/agentRuntimeDaemonServiceProtocol';
import { projectAgentIsolationLaunchMaterialFailure } from '@/daemon/agentIsolation/agentIsolationLaunchMaterialFailure';
import { classifyPrimarySessionRuntimeIssue } from '@/agent/runtime/session/errors/classifyPrimarySessionRuntimeIssue';
import { reportSessionRunnerFailure } from '@/cli/resolveSessionRunnerFailureExitCode';
import { appendBoundedChildStderr, buildChildExitBeforeWebhookFailure } from '@/daemon/spawn/childStderrDiagnostic';
import { logger } from '@/ui/logger';

describe('Session launch cause transport', () => {
  it.each(['session_launch_material_missing', 'managed_binary_missing', 'session_mcp_context_missing'] as const)(
    'retains %s through runner dispatch, daemon control and the strict Action result', cause => {
      const source = new PluginError({ code: 'agent_isolation_unavailable', message: 'PRIVATE_MESSAGE', retryable: false,
        details: { cause, phase: 'native_execution_preparation', token: 'PRIVATE_TOKEN', path: '/PRIVATE_HOME' } });
      const dispatched = AgentRuntimeDaemonServiceResponseV1Schema.parse({ ok: false,
        error: projectRunnerDaemonPluginServicesFailure(source) });
      expect(dispatched).toMatchObject({ ok: false, error: { code: 'agent_isolation_unavailable',
        cause: { code: cause, stage: 'dispatch' }, failureCause: { phase: 'agent_isolation.native_execution_preparation', errorCode: cause } } });
      const wrapped = createRunnerDaemonPluginServicesPreparationError(source, 'invocation_context');
      for (const error of [source, wrapped]) {
        let captured: ReturnType<typeof appendBoundedChildStderr> = { head: '', tail: '' };
        const output = vi.spyOn(console, 'error').mockImplementation((...values: unknown[]) => {
          captured = appendBoundedChildStderr(captured, `${values.join(' ')}\n`);
        });
        const info = vi.spyOn(logger, 'infoFile').mockImplementation(() => {});
        const fatal = vi.spyOn(logger, 'fatal').mockImplementation(() => {});
        try { expect(reportSessionRunnerFailure(error)).toBe(1); }
        finally { output.mockRestore(); info.mockRestore(); fatal.mockRestore(); }
        expect(captured.failureCause).toMatchObject({ code: cause, phase: 'client_start' });
        expect(classifyPrimarySessionRuntimeIssue({ cause: 'session_error', startupPhase: 'client_start', error }))
          .toMatchObject({ failureCause: { code: cause, phase: 'client_start' } });
        const childFailure = buildChildExitBeforeWebhookFailure({ pid: 5154, code: 1, signal: null,
          stderrTail: captured.tail, failureCause: captured.failureCause });
        expect(projectSessionSpawnFailure({ errorCode: childFailure.errorCode,
          errorMessage: childFailure.errorMessage, errorDetail: childFailure.errorDetail }))
          .toMatchObject({ type: 'error', code: 'spawn_failed', launchError: { code: cause, failureCause: { code: cause } } });
        const launchError = projectAgentIsolationLaunchMaterialFailure(error);
        expect(launchError).toMatchObject({ kind: 'launch_error', code: cause, failureCause: { code: cause, phase: 'client_start' } });
        const response = SpawnSessionControlErrorResponseSchema.parse(projectSpawnSessionControlErrorResponse({
          errorCode: 'SPAWN_FAILED', errorMessage: 'Launch refused', errorDetail: launchError,
        }));
        const result = SessionSpawnNewActionResultV1Schema.parse(projectSessionSpawnNewActionResultV1(projectSessionSpawnFailure({
          errorCode: response.errorCode!, errorMessage: response.error, errorDetail: response.errorDetail,
        })));
        expect(result).toMatchObject({ type: 'error', code: 'spawn_failed', retryable: false, launchError: { code: cause } });
        expect(classifyPrimarySessionRuntimeIssue({ cause: 'session_error', error: {
          code: launchError?.code, failureCause: launchError?.failureCause,
        } })).toMatchObject({ code: cause, failureCause: { code: cause, phase: 'client_start' } });
        expect(JSON.stringify({ response, result, dispatched })).not.toContain('PRIVATE_');
      }
    });
  it.each(['use', 'manage'] as const)('offers only the admitted %s requester’s available setup remedy', async role => {
    const client = new ApiMachineClient('token', { id: 'member-refusal', encryptionMode: 'plain', metadataVersion: 1,
      daemonStateVersion: 1, metadata: { host: 'fixture', platform: 'linux', happyCliVersion: '0.3',
        homeDir: '/home/happier', happyHomeDir: '/home/happier/.happier' }, daemonState: { status: 'running' } });
    const attribution = { serverId: 'saved-home', machineId: 'member-refusal', installationId: 'installation', accountId: 'member' };
    try {
      const prepare = createSessionAgentIsolationMemberPreparation({ machineId: attribution.machineId, custodianAccountId: 'owner',
        resolveCurrentMachineExecutionOriginContext: async () => ({ machineId: attribution.machineId, serverIdentityId: 'canonical-home' }),
        agentIsolation: { read: () => ({ enabled: true, memberProvisioning: 'linuxUsersV1', workspaceRoots: [], status: { kind: 'disabled' } }),
          prepareMember: input => client.prepareAgentIsolationMember(input) },
      })({ bootstrap: { attribution, homeServerIdentityId: 'canonical-home', savedSecretOperationContext: {
        machineAdmission: { actorAccountId: 'member', custodianAccountId: 'owner', role },
      } } }, new AbortController().signal);
      const prepared = await prepareDaemonAgentIsolationIdentity({ hasAgentRuntime: true,
        requesterWorkAttributionV1: attribution, prepareAgentIsolationMember: prepare });
      if (prepared.ok) throw new Error('Expected member setup refusal');
      const response = SpawnSessionControlErrorResponseSchema.parse(projectSpawnSessionControlErrorResponse(prepared.result));
      const result = SessionSpawnNewActionResultV1Schema.parse(projectSessionSpawnNewActionResultV1(projectSessionSpawnFailure({
        errorCode: response.errorCode!, errorMessage: response.error, errorDetail: response.errorDetail,
      })));
      expect(result).toMatchObject({ type: 'error', code: 'spawn_failed', retryable: false, launchError: {
        agentIsolationRefusal: { reason: 'member_setup_required', phase: 'native_execution_preparation', remedy: role === 'manage'
          ? { kind: 'open_machine_security', target: { serverId: 'saved-home', machineId: 'member-refusal' } }
          : { kind: 'ask_machine_manager' } },
      } });
      if (role === 'manage' && result.type === 'error' && result.code === 'spawn_failed')
        expect(result.launchError?.message).not.toMatch(/ask.*owner/iu);
    } finally { await client.shutdown(); }
  });
  it.each(['producer', 'owner-unavailable', 'unknown-detail', 'native-check', 'operation-unavailable'] as const)('keeps the observed member setup cause through the %s Session launch path', async source => {
    const client = new ApiMachineClient('token', { id: 'member-refusal', encryptionMode: 'plain', metadataVersion: 1,
      daemonStateVersion: 1, metadata: { host: 'fixture', platform: 'linux', happyCliVersion: '0.3',
        homeDir: '/home/happier', happyHomeDir: '/home/happier/.happier' }, daemonState: { status: 'running' } });
    const attribution = { serverId: 'saved-home', machineId: 'member-refusal', installationId: 'installation', accountId: 'member' };
    const requesterIdentity = { kind: 'isolated' as const, separationRequired: true, requester: attribution, homeServerIdentityId: 'canonical-home' };
    const native = createAgentIsolationMemberPreparationBoundary({ activeServerDir: '/unused-member-refusal', requesterIdentity,
      custodianAccountId: 'owner', encryptionMode: 'plain', uid: 2401,
      ...(source === 'native-check' ? { observeNativeStep: async (step: { id: string }) => ({ stepId: step.id,
        status: 'unavailable' as const, reason: 'required_fact_unavailable' as const,
        facts: { requiredFact: 'PRIVATE_NATIVE_FACT', remedy: 'PRIVATE_NATIVE_REMEDY' } }) } : {}),
      ...(source === 'operation-unavailable' ? { resolveAccountId: async () => null } : {}),
    });
    // Platform support is an OS fact; real member operations produce the refusal.
    if (source === 'producer') Reflect.set(native.effects, 'platform', 'win32');
    if (source !== 'owner-unavailable') Reflect.set(client, 'agentIsolationMemberOperations', native.members);
    const prepareMember = source !== 'unknown-detail'
      ? async () => (await client.prepareAgentIsolationMember({ requesterIdentity })).identity
      : async () => { throw new PluginError({ code: 'agent_isolation_unavailable', message: 'PRIVATE_MESSAGE', retryable: false,
        details: { reason: 'member_setup_required', phase: 'native_execution_preparation', outcome: 'not_applied',
          reasonCode: 'denied', token: 'PRIVATE_TOKEN', remedy: 'PRIVATE_REMEDY', path: '/PRIVATE_HOME',
          nativeFailure: { kind: 'native_effect_failed', reason: 'required_fact_unavailable', phase: 'apply',
            requiredFact: 'PRIVATE_FACT', remedy: 'PRIVATE_NATIVE_REMEDY' } } }); };
    try {
      const prepared = await prepareDaemonAgentIsolationIdentity({ hasAgentRuntime: true,
        requesterWorkAttributionV1: attribution,
        prepareAgentIsolationMember: prepareMember,
      });
      expect(prepared.ok).toBe(false);
      if (prepared.ok) throw new Error('Expected member setup refusal');
      const response = SpawnSessionControlErrorResponseSchema.parse(projectSpawnSessionControlErrorResponse(prepared.result));
      const result = SessionSpawnNewActionResultV1Schema.parse(projectSessionSpawnNewActionResultV1(projectSessionSpawnFailure({
        errorCode: response.errorCode!, errorMessage: response.error, errorDetail: response.errorDetail,
      })));
      expect(result).toMatchObject({ retryable: false });
      expect(result).toMatchObject({ type: 'error', code: 'spawn_failed', launchError: {
        code: 'agent_isolation_unavailable', agentIsolationRefusal: { reason: 'member_setup_required',
          phase: 'native_execution_preparation', ...(source !== 'owner-unavailable'
            ? { reasonCode: source === 'producer' ? 'platform_unsupported' : source === 'native-check'
              ? 'native_check_unavailable' : 'denied' } : {}),
          ...(source === 'native-check' ? { nativeFailure: { kind: 'native_check_unavailable', reason: 'required_fact_unavailable' } } : {}),
          ...(source === 'unknown-detail' ? { nativeFailure: { kind: 'native_effect_failed', reason: 'required_fact_unavailable', phase: 'apply' } } : {}),
          ...(source === 'operation-unavailable' ? { operationErrorCode: 'machine_setup_operation_unavailable' } : {}),
        },
      } });
      expect(JSON.stringify({ response, result })).not.toContain('PRIVATE_');
      if (result.type !== 'error' || result.code !== 'spawn_failed') throw new Error('Expected public launch refusal');
      if (source === 'unknown-detail') expect(result.launchError?.agentIsolationRefusal).not.toHaveProperty('remedy');
      else expect(result.launchError?.agentIsolationRefusal?.remedy).toEqual({ kind: 'ask_machine_manager' });
      for (const invalid of [
        { ...result.launchError?.agentIsolationRefusal, token: 'PRIVATE_TOKEN' },
        { ...result.launchError?.agentIsolationRefusal, reasonCode: 'PRIVATE_REASON' },
        { ...result.launchError?.agentIsolationRefusal, phase: 'PRIVATE_PHASE' },
        { ...result.launchError?.agentIsolationRefusal, remedy: { kind: 'PRIVATE_REMEDY' } },
      ]) {
        expect(SessionSpawnNewActionResultV1Schema.safeParse({ ...result,
          launchError: { ...result.launchError, agentIsolationRefusal: invalid } }).success).toBe(false);
      }
    } finally { await client.shutdown(); }
  });
  it('accepts an existing source-runtime refusal without the optional diagnostic subtype', () => {
    const legacyCause = { kind: 'launch_error' as const, code: 'SOURCE_RUNTIME_RELOAD_REQUIRED',
      message: 'Reload the Stack from current source.' };
    const response = SpawnSessionControlErrorResponseSchema.parse(projectSpawnSessionControlErrorResponse({
      errorCode: 'SPAWN_FAILED', errorMessage: legacyCause.message, errorDetail: legacyCause,
    }));
    expect(SessionSpawnNewResultV1Schema.parse(projectSessionSpawnFailure({
      errorCode: response.errorCode!, errorMessage: response.error, errorDetail: response.errorDetail,
    }))).toMatchObject({ type: 'error', launchError: legacyCause });
    expect(response.errorDetail).not.toHaveProperty('subtype');
  });
  it.each(['no_closure', 'closure_changed', 'writer_active', 'check_failed'] as const)(
    'requires manual runtime repair for a retained %s spawn refusal', async (subtype) => {
      const launchError = { kind: 'launch_error' as const, code: 'SOURCE_RUNTIME_RELOAD_REQUIRED', subtype,
        message: 'Source runtime dependencies changed or are unavailable. Reload the Stack from current source.' };
      const response = SpawnSessionControlErrorResponseSchema.parse(projectSpawnSessionControlErrorResponse({
        errorCode: 'SPAWN_FAILED', errorMessage: launchError.message, errorDetail: launchError,
      }));
      const result = SessionSpawnNewResultV1Schema.parse(projectSessionSpawnFailure({
        errorCode: response.errorCode!, errorMessage: response.error, errorDetail: response.errorDetail,
      }));
      const operations = createHostActionOperationRuntime({ machineId: 'source-worker',
        resolveAccountId: async () => 'source-owner', generateOperationId: () => 'source-refusal' });
      await operations.observeExecution({ actionId: 'session.spawn_new',
        input: { creationKey: 'source-refusal', executionTarget: { serverId: 'fixture-home', machineId: 'source-worker' },
          directory: { kind: 'managed' }, agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } } },
        execute: async () => ({ ok: true, result }),
      });
      expect(await operations.handlers.getV2({ operationId: 'source-refusal', waitForTerminal: true }))
        .toMatchObject({ kind: 'found', operation: { state: 'failed', result: {
          type: 'error', code: 'spawn_failed', retryable: false, launchError,
        } } });
    });
  it.each(['broker_unavailable', 'team_credential_provider_binding_unavailable',
    'team_credential_model_selection_required', 'provider_catalog_unavailable',
    'provider_compatibility_unverified', 'resource_forbidden', 'update_required', 'connected_service_credential_reconnect_required'])(
    'preserves the closed %s preflight and late causes through strict daemon and Action results', async (code) => {
      const response = SpawnSessionControlErrorResponseSchema.parse(projectSpawnSessionControlErrorResponse({
        errorCode: 'SPAWN_VALIDATION_FAILED', errorMessage: code,
      }));
      const result = SessionSpawnNewResultV1Schema.parse(projectSessionSpawnFailure({
        errorCode: response.errorCode!, errorMessage: response.error, errorDetail: response.errorDetail,
      }));
      expect(result).toMatchObject({ type: 'error', code: 'spawn_failed', launchError: { code } });
      if (result.type !== 'error') throw new Error('Expected spawn failure');
      if (code === 'team_credential_model_selection_required' || code === 'connected_service_credential_reconnect_required'
        || code === 'provider_compatibility_unverified' || code === 'update_required') {
        expect(result).toMatchObject({ retryable: false });
      }
      const lateResponse = SpawnSessionControlErrorResponseSchema.parse(projectSpawnSessionControlErrorResponse({
        errorCode: 'SPAWN_FAILED', errorMessage: 'Native startup refused',
        errorDetail: { kind: 'launch_error', code, message: 'Native startup refused' },
      }));
      const lateResult = SessionSpawnNewResultV1Schema.parse(projectSessionSpawnFailure({
        errorCode: lateResponse.errorCode!, errorMessage: lateResponse.error, errorDetail: lateResponse.errorDetail,
      }));
      expect(lateResult).toMatchObject({ type: 'error', code: 'spawn_failed',
        retryable: result.retryable, launchError: { code } });
      const operations = createHostActionOperationRuntime({ machineId: 'broker-worker',
        resolveAccountId: async () => 'recipient', generateOperationId: () => 'broker-refusal' });
      await operations.observeExecution({ actionId: 'session.spawn_new',
        input: { creationKey: 'broker-refusal', executionTarget: { serverId: 'fixture-home', machineId: 'broker-worker' },
          directory: { kind: 'managed' }, agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } } },
        execute: async () => ({ ok: true, result: lateResult }),
      });
      expect(await operations.handlers.getV2({ operationId: 'broker-refusal', waitForTerminal: true }))
        .toMatchObject({ kind: 'found', operation: { state: 'failed', result: {
          type: 'error', retryable: result.retryable, launchError: { code },
        } } });
      expect(projectSessionSpawnFailure({ errorCode: 'SPAWN_VALIDATION_FAILED',
        errorMessage: `${code}: private upstream detail` })).not.toMatchObject({ launchError: { code } });
    },
  );
  it('carries the currentness timeout through the serialized daemon refusal and strict Action result', async () => {
    const detail = readSessionCreationTerminalSpawnErrorDetail(new AccountEncryptionCurrentnessUnavailableError(
      undefined, undefined, { cause: Object.assign(new Error('Request timed out'), { code: 'ECONNABORTED' }) },
    ));
    if (!detail) throw new Error('Expected currentness refusal');
    const failure = buildSessionCreationTerminalSpawnErrorResult(detail);
    const app = fastify().setSerializerCompiler(serializerCompiler);
    app.post('/spawn-session', { schema: { response: { 500: SpawnSessionControlErrorResponseSchema } } },
      (_request, reply) => reply.code(500).send(projectSpawnSessionControlErrorResponse(failure)));
    try {
      const serialized = await app.inject({ method: 'POST', url: '/spawn-session' });
      const response = SpawnSessionControlErrorResponseSchema.parse(serialized.json());
      expect(serialized.statusCode).toBe(500);
      expect(response.errorDetail).toEqual(detail);
      expect(SessionSpawnNewResultV1Schema.parse(projectSessionSpawnFailure({
        errorCode: response.errorCode!, errorMessage: response.error, errorDetail: response.errorDetail,
      }))).toMatchObject({ type: 'error', retryable: true, launchError: { code: 'currentness_unavailable',
        currentnessFailure: { reason: 'timeout', retryable: true } } });
    } finally { await app.close(); }
  });
  it('retains a transient lease cause through strict transport without disclosing attached secrets', () => {
    const secret = 'sk-private-refresh-reason';
    const failure = buildConnectedServiceCredentialRefreshSpawnErrorResult({ agentId: 'claude', error: {
      name: 'ConnectedServiceSpawnCredentialRefreshError', kind: 'transient_refresh_failed',
      serviceId: 'acme.agent/account', profileId: 'waiting',
      reason: `connected_account_refresh_lease_not_acquired; accessToken=${secret}`,
    } });
    if (!failure) throw new Error('Expected lease refusal');
    const response = SpawnSessionControlErrorResponseSchema.parse(projectSpawnSessionControlErrorResponse(failure));
    const result = SessionSpawnNewResultV1Schema.parse(projectSessionSpawnFailure({
      errorCode: response.errorCode!, errorMessage: response.error, errorDetail: response.errorDetail,
    }));
    expect(result).toMatchObject({ code: 'spawn_failed', retryable: true, launchError: {
      code: 'connected_service_credential_refresh_unavailable',
      message: expect.stringContaining('connected_account_refresh_lease_not_acquired'),
    } });
    expect(JSON.stringify({ response, result })).not.toContain(secret);
  });

  it('keeps a rejected connected account actionable through the strict Action result', () => {
    const failure = buildConnectedServiceCredentialRefreshSpawnErrorResult({ agentId: 'claude', error: {
      name: 'ConnectedServiceSpawnCredentialRefreshError', kind: 'reconnect_required',
      serviceId: 'acme.agent/account', profileId: 'revoked',
    } });
    if (!failure) throw new Error('Expected credential failure');
    const response = SpawnSessionControlErrorResponseSchema.parse(projectSpawnSessionControlErrorResponse(failure));
    const result = SessionSpawnNewResultV1Schema.parse(projectSessionSpawnFailure({
      errorCode: response.errorCode!, errorMessage: response.error, errorDetail: response.errorDetail,
    }));
    expect(result).toMatchObject({ code: 'spawn_failed', retryable: false, launchError: {
      code: 'connected_service_credential_reconnect_required',
      message: expect.stringMatching(/reconnect/i),
      uxDiagnostic: { code: 'connected_service_credential_reconnect_required',
        serviceId: 'acme.agent/account', profileId: 'revoked', retryable: false },
    } });
  });
  it.each(['provider_connection_invalid', 'model_selection_required'] as const)('preserves the typed %s refusal through daemon control and public launch projection', async code => {
    const failure = buildProviderSpawnErrorResult(createProviderErrorV1(code, {
      connectionId: 'pc_gateway', machineId: 'machine-a',
    }));
    const response = SpawnSessionControlErrorResponseSchema.parse(projectSpawnSessionControlErrorResponse(failure));
    expect(response.errorDetail).toEqual(failure.errorDetail);
    expect(normalizeSpawnSessionErrorDetail(response.errorDetail)).toEqual(failure.errorDetail);
    expect(SessionSpawnNewResultV1Schema.parse(projectSessionSpawnFailure({
      errorCode: response.errorCode!, errorMessage: response.error, errorDetail: response.errorDetail,
    }))).toMatchObject({ type: 'error', code: 'spawn_failed', retryable: false,
      launchError: { kind: 'launch_error', code } });
    expect(SpawnSessionControlErrorResponseSchema.safeParse({
      ...response,
      errorDetail: { ...failure.errorDetail, secret: 'must-not-cross-control-transport' },
    }).success).toBe(false);
    const app = fastify().setSerializerCompiler(serializerCompiler);
    app.post('/spawn-session', { schema: { response: { 500: SpawnSessionControlErrorResponseSchema } } },
      (_request, reply) => reply.code(500).send(projectSpawnSessionControlErrorResponse(failure)));
    try {
      const serialized = await app.inject({ method: 'POST', url: '/spawn-session' });
      expect(serialized.statusCode).toBe(500);
      expect(serialized.json()).toEqual(response);
    } finally {
      await app.close();
    }
  });

  it('preserves a typed launch cause through the daemon response and strict public creation result', () => {
    const cause = normalizeSpawnSessionErrorDetail({ kind: 'launch_error', code: 'ACP_CATALOG_UNAVAILABLE',
      message: 'Configured ACP catalog is unavailable: definition-required' });
    expect(cause).toEqual({ kind: 'launch_error', code: 'ACP_CATALOG_UNAVAILABLE',
      message: 'Configured ACP catalog is unavailable: definition-required' });
    const response = SpawnSessionControlErrorResponseSchema.parse(projectSpawnSessionControlErrorResponse({
      errorCode: 'SPAWN_FAILED', errorMessage: 'Failed to spawn session', errorDetail: cause,
    }));
    expect(response.errorDetail).toEqual(cause);
    expect(SessionSpawnNewResultV1Schema.parse(projectSessionSpawnFailure({
      errorCode: response.errorCode!, errorMessage: response.error, errorDetail: response.errorDetail,
    }))).toMatchObject({ launchError: cause });
  });

  it('keeps missing Agents typed and gives uncoded failures an explicit cause', () => {
    expect(SessionSpawnNewResultV1Schema.parse(projectSessionSpawnFailure({ errorCode: 'agent_cli_missing',
      errorMessage: 'Install the selected Agent', agentId: 'custom-acp' }))).toEqual({
      type: 'error', code: 'agent_cli_missing', agentId: 'custom-acp', retryable: false });
    expect(SessionSpawnNewResultV1Schema.parse(projectSessionSpawnFailure({ errorCode: '', errorMessage: 'Launch refused' })))
      .toMatchObject({ code: 'spawn_failed', launchError: { code: 'SPAWN_FAILED', message: 'Launch refused' } });
    expect(SessionSpawnNewResultV1Schema.safeParse({ type: 'error', code: 'agent_cli_missing',
      agentId: 'custom-acp', retryable: false, launchError: { kind: 'launch_error', code: 'ENOENT', message: 'Missing' } }).success).toBe(false);
  });

  it('gives a signed-out Agent safe profile recovery through the strict creation result', () => {
    const result = SessionSpawnNewResultV1Schema.parse(projectSessionSpawnFailure({
      errorCode: 'agent_signed_out', agentId: 'custom-agent',
      errorMessage: 'upstream-private-auth-diagnostic',
    }));
    expect(result).toMatchObject({ type: 'error', code: 'agent_signed_out', agentId: 'custom-agent',
      retryable: false, launchError: { kind: 'launch_error', code: 'agent_signed_out',
        failureCause: { phase: 'authentication', failureReason: 'authentication_required' } } });
    if (result.type !== 'error' || result.code !== 'agent_signed_out') throw new Error('Expected signed-out refusal');
    expect(result.launchError?.message).toMatch(/sign in/i);
    expect(result.launchError?.message).toMatch(/select.*connected account profile/i);
    expect(result.launchError?.message).toMatch(/configure.*default profile/i);
    expect(JSON.stringify(result)).not.toContain('upstream-private-auth-diagnostic');
  });
});
