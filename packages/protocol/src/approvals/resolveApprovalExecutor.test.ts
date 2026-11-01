import { describe, expect, it } from 'vitest';
import { getActionSpec } from '../actions/actionSpecs.js';
import { projectApprovalRequestForPublicRead } from '../actions/actionApprovalPresentation.js';
import { API_TOKEN_FULL_GRANT_V1 } from '../auth/apiTokenGrant.js';
import { ApprovalRequestV1Schema, ApprovalRequestV2Schema } from './approvalRequestV1.js';
import { TargetActionApprovalRequestV1Schema } from './targetActionApprovalRequestV1.js';
import { resolveApprovalExecutor } from './resolveApprovalExecutor.js';

const surfaces = ['ui', 'voice', 'plugin', 'agent', 'mcp', 'cli', 'rpc', 'api'] as const;
const cases = [
  { actionId: 'launch_profiles.delete', input: { id: 'profile', expectedRevision: 1 }, expected: { kind: 'app', placement: 'account' } },
  { actionId: 'ui.find', input: { op: 'set', query: 'reviewed query' }, expected: { kind: 'app', placement: 'client' } },
  { actionId: 'paths.list_recent', input: { machineId: 'machine', limit: 10 }, expected: { kind: 'daemon', machineId: 'machine' } },
  { actionId: 'session.stop', input: { sessionId: 'session' }, expected: { kind: 'daemon', machineId: 'machine', sessionId: 'session' } },
  { actionId: 'mcp.servers.signIn.start', input: { serverId: 'oauth-server' }, expected: { kind: 'live_invocation' } },
  { actionId: 'teams.credentials.externalKeys.create', input: { resourceId: 'resource', teamMembershipId: 'membership', label: 'Reviewed key' }, expected: { kind: 'live_invocation' } },
] as const;

function requestFor(actionId: Parameters<typeof getActionSpec>[0], input: unknown, surface: typeof surfaces[number] = 'cli') {
  return ApprovalRequestV2Schema.parse({ v: 2, status: 'open', createdAtMs: 1, updatedAtMs: 1,
    createdBy: { surface: 'system' }, requestedSurface: surface, actionId,
    actionArgs: getActionSpec(actionId).inputSchema.parse(input), summary: 'Reviewed effect',
    approval: { flow: 'deferred', result: 'required' },
    executionOriginV1: { v: 1, authority: 'account_automation', surface, caller: { kind: 'host' },
      serverId: 'home', accountId: 'account', machineId: 'machine', sessionId: 'session',
      ...(surface === 'api' ? { principalId: 'principal', credentialId: 'credential' } : {}),
      actionId, requestId: 'request' } });
}

describe('resolveApprovalExecutor', () => {
  it.each(surfaces)('returns a retained bootstrap retry to its captured Machine across %s approval replay', surface => {
    const request = requestFor('machines.managed.bootstrap.retry', {
      homeId: 'home', managedId: 'retained-running-guest', expectedIntentRevision: 1,
    }, surface);
    expect(resolveApprovalExecutor(request)).toEqual({ kind: 'app', placement: 'account' });
    const targeted = ApprovalRequestV2Schema.parse({ ...request, executionOriginV1: {
      ...request.executionOriginV1, machineId: 'retained-controller', target: { kind: 'machine', machineId: 'retained-controller' },
    } });
    expect(resolveApprovalExecutor(targeted)).toEqual({ kind: 'daemon', machineId: 'retained-controller' });
    // Public approval reads omit private authorization. Location must still
    // lead to the captured controller, where ordinary admission owns replay.
    expect(resolveApprovalExecutor(ApprovalRequestV2Schema.parse(projectApprovalRequestForPublicRead(targeted))))
      .toEqual({ kind: 'daemon', machineId: 'retained-controller' });
  });

  it.each(surfaces)('routes placement and private custody independently of the %s surface', surface => {
    for (const row of cases) {
      const expected = row.expected.kind === 'live_invocation' && (surface === 'agent' || surface === 'mcp' || surface === 'rpc' || surface === 'api')
        ? { ...row.expected, daemonMachineId: 'machine' } : row.expected;
      expect(resolveApprovalExecutor(requestFor(row.actionId, row.input, surface)), row.actionId).toEqual(expected);
    }
  });

  it.each(['ui', 'cli', 'plugin'] as const)('resumes a blocking %s host closure at its original invocation', surface => {
    for (const row of cases.slice(0, 4)) {
      const request = requestFor(row.actionId, row.input, surface);
      expect(resolveApprovalExecutor({ ...request, approval: { flow: 'blocking', result: 'required' } })).toEqual({ kind: 'live_invocation' });
    }
  });

  it.each(['plugin', 'voice'] as const)('keeps an unsigned %s private result in its originating app without a daemon destination', surface => {
    const request = requestFor('mcp.servers.signIn.start', { serverId: 'oauth-server' }, surface);
    const origin = surface === 'plugin' ? { ...request.executionOriginV1, caller: {
      kind: 'plugin' as const, pluginId: 'example.oauth', contributionLocalId: 'settings',
      sourceCustody: { kind: 'development' as const, registeredRootId: 'root' },
    } } : request.executionOriginV1;
    expect(resolveApprovalExecutor(ApprovalRequestV2Schema.parse({ ...request, executionOriginV1: origin })))
      .toEqual({ kind: 'live_invocation' });
  });

  it.each(['cli', 'mcp'] as const)('delivers a signed %s live result to its captured daemon invocation', surface => {
    const request = requestFor('mcp.servers.signIn.start', { serverId: 'oauth-server' }, surface === 'mcp' ? 'agent' : surface);
    const target = { kind: 'machine' as const, machineId: 'machine' };
    const caller = { kind: 'session' as const, sessionId: 'session', starterDepth: 0, turnDepth: 0 };
    const signed = ApprovalRequestV2Schema.parse({ ...request, executionOriginV1: { ...request.executionOriginV1,
      // Session MCP ingress is retained as the admitted Agent origin.
      ...(surface === 'mcp' ? { surface: 'agent', caller, callerPermissionMode: null,
        sessionInputSource: { sourceSessionId: 'session', sourceTurnId: 'turn', via: 'action' } } : {}),
      serverIdentityId: 'stable-home', target, externalActionInputSignature: 'a'.repeat(86),
      externalActionExecutionAuthorization: { v: 1, token: 'home-signed', binding: {
        accountId: 'account', authentication: { kind: 'account', tokenEpoch: 1 },
        serverIdentityId: 'stable-home', machineId: 'machine', custodianAccountId: 'account',
        installationId: 'installation', actionId: request.actionId, requestId: 'request',
        requestEnvelopeDigest: 'a'.repeat(43), target,
        ...(surface === 'mcp' ? { sessionActionOrigin: { v: 1, caller, sourceTurnId: 'turn',
          callerPermissionMode: null, requestId: 'request' },
          sessionActionSource: { machineId: 'machine', installationId: 'installation' } } : {}),
      } } } });
    expect(resolveApprovalExecutor(signed)).toEqual({ kind: 'live_invocation', daemonMachineId: 'machine' });
  });

  it('classifies the D26B agent confidential browser request as a live invocation', () => {
    const actionId = 'browser.automation.secret.fill';
    const request = requestFor(actionId, { serverId: 'home', sessionId: 'session', machineId: 'machine',
      browserSessionId: 'browser-session', viewId: 'view', tabId: 'tab', frameId: 'frame', documentId: 'document',
      navigationGeneration: 1, origin: 'https://example.test',
      field: { fieldId: 'password', focusId: 'focus', locator: '#password' }, purpose: 'Sign in' }, 'agent');
    expect(resolveApprovalExecutor(request)).toEqual({ kind: 'live_invocation', daemonMachineId: 'machine' });
  });

  it('does not turn a signed Account request into a daemon effect', () => {
    const request = requestFor('launch_profiles.delete', { id: 'profile', expectedRevision: 1 }, 'api');
    const target = { kind: 'machine' as const, machineId: 'machine' };
    const signed = ApprovalRequestV2Schema.parse({ ...request, executionOriginV1: { ...request.executionOriginV1,
      serverIdentityId: 'stable-home', target, externalActionInputSignature: 'a'.repeat(86),
      externalActionExecutionAuthorization: { v: 1, token: 'home-signed', binding: {
        accountId: 'account', principalId: 'principal', credentialId: 'credential',
        serverIdentityId: 'stable-home', machineId: 'machine', custodianAccountId: 'account',
        installationId: 'installation', actionId: request.actionId, requestId: 'request',
        requestEnvelopeDigest: 'a'.repeat(43), target, grant: API_TOKEN_FULL_GRANT_V1,
      } } } });
    expect(resolveApprovalExecutor(signed)).toEqual({ kind: 'app', placement: 'account' });
  });

  it('keeps immediate power on its Home-admitted Machine while unsigned and deferred power remain Account-owned', () => {
    const request = requestFor('machines.managed.power.set', { homeId: 'home', managedId: 'managed',
      intent: 'stop', when: 'now', expectedRevision: 0 }, 'api');
    expect(resolveApprovalExecutor(request)).toEqual({ kind: 'app', placement: 'account' });
    const target = { kind: 'machine' as const, machineId: 'machine' };
    const signed = ApprovalRequestV2Schema.parse({ ...request, executionOriginV1: { ...request.executionOriginV1,
      serverIdentityId: 'stable-home', target, externalActionInputSignature: 'a'.repeat(86),
      externalActionExecutionAuthorization: { v: 1, token: 'home-signed', binding: {
        accountId: 'account', principalId: 'principal', credentialId: 'credential',
        serverIdentityId: 'stable-home', machineId: 'machine', custodianAccountId: 'account',
        installationId: 'installation', actionId: request.actionId, requestId: 'request',
        requestEnvelopeDigest: 'a'.repeat(43), target, grant: API_TOKEN_FULL_GRANT_V1,
      } } } });
    expect(resolveApprovalExecutor(signed)).toEqual({ kind: 'daemon', machineId: 'machine' });
    const deferred = ApprovalRequestV2Schema.parse({ ...signed,
      actionArgs: { homeId: 'home', managedId: 'managed', intent: 'stop', when: 'after-idle' } });
    expect(resolveApprovalExecutor(deferred)).toEqual({ kind: 'app', placement: 'account' });
  });

  it('routes native deployment public reads and Machine-targeted proposals to the controller while unplaced proposals stay Account-owned', () => {
    const request = requestFor('deployments.deploy', { serverId: 'stable-home', environmentId: 'environment',
      expectedRevision: 9, requestKey: 'native-deploy', targetLinkId: 'target-link', expectedTargetLinkRevision: 1,
      contentArtifactId: 'candidate', contentHeaderVersion: 3, contentBodyVersion: 3 }, 'ui');
    expect(resolveApprovalExecutor(request)).toEqual({ kind: 'app', placement: 'account' });
    const target = { kind: 'machine' as const, machineId: 'machine' };
    const signed = ApprovalRequestV2Schema.parse({ ...request, executionOriginV1: { ...request.executionOriginV1,
      serverIdentityId: 'stable-home', target, externalActionInputSignature: 'a'.repeat(86),
      externalActionExecutionAuthorization: { v: 1, token: 'home-signed', binding: {
        accountId: 'account', authentication: { kind: 'account', tokenEpoch: 1 },
        serverIdentityId: 'stable-home', machineId: 'machine', custodianAccountId: 'account',
        installationId: 'installation', actionId: request.actionId, requestId: 'request',
        requestEnvelopeDigest: 'a'.repeat(43), target,
      } } } });
    expect(resolveApprovalExecutor(signed)).toEqual({ kind: 'daemon', machineId: 'machine' });
    const publicRead = ApprovalRequestV2Schema.parse(projectApprovalRequestForPublicRead(signed));
    expect(publicRead.executionOriginV1.externalActionExecutionAuthorization).toBeUndefined();
    expect(publicRead.executionOriginV1.externalActionInputSignature).toBeUndefined();
    expect(resolveApprovalExecutor(publicRead)).toEqual({ kind: 'daemon', machineId: 'machine' });
    const caller = { kind: 'session' as const, sessionId: 'session', starterDepth: 0, turnDepth: 0 };
    const proposal = ApprovalRequestV2Schema.parse({ ...signed, requestedSurface: 'agent',
      createdBy: { surface: 'agent', sessionId: 'session' }, executionOriginV1: { ...signed.executionOriginV1,
        surface: 'agent', caller, callerPermissionMode: null,
        sessionInputSource: { sourceSessionId: 'session', sourceTurnId: 'turn', via: 'action' },
        externalActionExecutionAuthorization: { ...signed.executionOriginV1.externalActionExecutionAuthorization,
          binding: { ...signed.executionOriginV1.externalActionExecutionAuthorization!.binding,
            actionId: 'approval.request.create', sessionActionOrigin: { v: 1, caller, sourceTurnId: 'turn',
              callerPermissionMode: null, requestId: 'request' },
            sessionActionSource: { machineId: 'machine', installationId: 'installation' } } },
      } });
    expect(resolveApprovalExecutor(proposal)).toEqual({ kind: 'daemon', machineId: 'machine' });
  });

  it('returns a Machine-targeted native deployment approval to its controller without an external caller carrier', () => {
    const request = requestFor('deployments.deploy', { serverId: 'stable-home', environmentId: 'environment',
      expectedRevision: 9, requestKey: 'native-deploy', targetLinkId: 'target-link', expectedTargetLinkRevision: 1,
      contentArtifactId: 'candidate', contentHeaderVersion: 3, contentBodyVersion: 3 }, 'mcp');
    const retained = ApprovalRequestV2Schema.parse({ ...request, executionOriginV1: { ...request.executionOriginV1,
      serverIdentityId: 'stable-home', machineId: 'controller',
      target: { kind: 'machine', machineId: 'controller' },
    } });
    expect(resolveApprovalExecutor(retained)).toEqual({ kind: 'daemon', machineId: 'controller' });
  });

  it('keeps only Workflow model reservations on their captured daemon', () => {
    const request = requestFor('discussion.invite', { discussionId: 'discussion', participant: {
      kind: 'model', participantSlotId: 'workflow:run:invocation', launch: {
        executionTarget: { serverId: 'home', machineId: 'machine' },
        directory: { kind: 'path', path: '/repo' },
        agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
      },
    } }, 'agent');
    expect(resolveApprovalExecutor(request)).toEqual({ kind: 'app', placement: 'account' });
    const workflow = ApprovalRequestV2Schema.parse({ ...request, executionOriginV1: {
      ...request.executionOriginV1, caller: { kind: 'workflowRun', runId: 'run', authorization: {
        principal: { kind: 'host' }, admittedPermissionCeiling: 'default',
      } },
    } });
    expect(resolveApprovalExecutor(workflow)).toEqual({ kind: 'app', placement: 'account' });
    const reservation = ApprovalRequestV2Schema.parse({ ...workflow, executionOriginV1: {
      ...workflow.executionOriginV1, caller: { ...workflow.executionOriginV1.caller,
        discussionModelReservation: { discussionId: 'discussion', participantSlotId: 'workflow:run:invocation' },
      },
    } });
    expect(resolveApprovalExecutor(reservation)).toEqual({ kind: 'daemon', machineId: 'machine' });
  });

  it('uses input-dependent placement and refuses missing daemon placement without inventing a Machine', () => {
    const account = requestFor('providers.connections.describe', {});
    expect(resolveApprovalExecutor(account)).toEqual({ kind: 'app', placement: 'account' });
    const machine = requestFor('providers.connections.describe', { machineId: 'machine' });
    expect(resolveApprovalExecutor(machine)).toEqual({ kind: 'daemon', machineId: 'machine' });
    expect(resolveApprovalExecutor({ ...machine, executionOriginV1: { ...machine.executionOriginV1, machineId: undefined } }))
      .toEqual({ kind: 'unavailable', reason: 'missing_machine' });
    expect(resolveApprovalExecutor({ ...account, actionArgs: { scope: 'invalid' } }))
      .toEqual({ kind: 'unavailable', reason: 'invalid_input' });
  });

  it('runs a dangerous client proposal in the approving app even without a source Machine', () => {
    const request = requestFor('relay.runtime.uninstall', {}, 'agent');
    expect(resolveApprovalExecutor({ ...request, executionOriginV1: { ...request.executionOriginV1, machineId: undefined } }))
      .toEqual({ kind: 'app', placement: 'client' });
  });

  it('keeps released V1 history readable without treating it as executable', () => {
    const request = ApprovalRequestV1Schema.parse({ v: 1, status: 'open', createdAtMs: 1, updatedAtMs: 1,
      createdBy: { surface: 'system' }, actionId: 'session.stop', actionArgs: { sessionId: 'session' }, summary: 'Stop' });
    expect(resolveApprovalExecutor(request)).toEqual({ kind: 'unavailable', reason: 'legacy_request' });
  });

  it('routes contributed approvals by captured placement and preserves their private live input', () => {
    const request = TargetActionApprovalRequestV1Schema.parse({ v: 1, kind: 'plugin_target_action', status: 'open',
      createdAtMs: 1, updatedAtMs: 1, createdBy: { surface: 'system' }, requestedSurface: 'plugin',
      qualifiedActionId: 'example.plugin/actions/publish', input: {},
      sourceCustody: { kind: 'development', registeredRootId: 'root' },
      policyFingerprint: 'a'.repeat(64), subjectFingerprint: 'b'.repeat(64), summary: 'Publish',
      replayPlacement: { serverId: 'home', machineId: 'machine', defaultSessionId: 'session' } });
    expect(resolveApprovalExecutor(request)).toEqual({ kind: 'daemon', machineId: 'machine', sessionId: 'session' });
    expect(resolveApprovalExecutor({ ...request, approvalInputCustody: 'live_only' })).toEqual({ kind: 'live_invocation', daemonMachineId: 'machine' });
    expect(resolveApprovalExecutor({ ...request, replayPlacement: undefined })).toEqual({ kind: 'unavailable', reason: 'missing_machine' });
  });
});
