import { describe, expect, it } from 'vitest';
import { createActionExecutor } from './actionExecutor.js';
import type { ActionExecutorContext, ActionExecutorDeps } from './executor/types.js';
import { API_TOKEN_FULL_GRANT_V1 } from '../auth/apiTokenGrant.js';
import { ExternalActionExecutionAuthorizationV1Schema } from './externalActionApi.js';
import { ActionsSettingsV1Schema } from './actionSettings.js';
import { DeploymentTargetRoleInputSchemasV1 } from '../plugins/contributions/deploymentTargetRolesV1.js';
import { createHostReviewedChildPortV1, invokeHostReviewedChildV1, readHostAdmittedReviewedChildV1, readHostReviewedChildOperationV1 } from './executor/deploymentRoleChild.js';
import { DeploymentReceiptAcceptedResultV1Schema } from '../deployments/deploymentReceiptResultV1.js';
import { isDeploymentChildRootActionIdV1 } from '../deployments/deploymentActionIdsV1.js';

const input = { serverId: 'home-identity', environmentId: 'environment', expectedRevision: 3, requestKey: 'deploy-request',
  targetLinkId: 'link', expectedTargetLinkRevision: 4, contentArtifactId: 'definition', contentHeaderVersion: 1, contentBodyVersion: 1 };
const credentialRef = { service: { pluginId: 'acme.fixture', localId: 'service' }, accountId: 'provider-account' };
const roleInput = DeploymentTargetRoleInputSchemasV1.deploy.parse({ v: 1 as const, serverId: 'home-identity', environmentId: 'environment', expectedRevision: 4,
  targetLinkId: 'link', expectedTargetLinkRevision: 4, deploymentId: 'receipt', expectedDeploymentRevision: 1,
  actionOperationId: 'operation', credentialRef,
  credentialPrincipal: { kind: 'account' as const, accountId: 'owner',
    purpose: { consumer: { pluginId: 'acme.fixture', localId: 'target' }, purpose: 'deploy' },
    target: { kind: 'account' as const, account: credentialRef } },
  providerIdentity: { providerAccountId: 'provider-account', providerResourceId: 'resource', providerEnvironment: 'production' },
  providerEnvironment: { kind: 'production' as const }, sourceMethod: 'gitIntegration' as const,
  sourceIntent: { kind: 'repository' as const, projectSourceId: 'source', sourceRevision: 1, sha: 'a'.repeat(40),
    compose: { path: 'compose.yaml', profiles: [], services: [] } } });
const request = { action: { pluginId: 'acme.fixture', localId: 'deploy' }, role: 'deploy' as const, input: roleInput };

function context(): ActionExecutorContext {
  const grant = { ...API_TOKEN_FULL_GRANT_V1, actions: { families: [], ids: ['deployments.deploy'] },
    targets: { sessions: [], machines: [], environments: ['environment'] } };
  const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'fixture-root', binding: {
    serverIdentityId: 'home-identity', accountId: 'owner', principalId: 'principal', credentialId: 'deployment-token', grant,
    custodianAccountId: 'owner', machineId: 'controller', installationId: 'installation', actionId: 'deployments.deploy',
    ...(isDeploymentChildRootActionIdV1('deployments.deploy') ? { deploymentChildRoot: true } : {}),
    environmentId: 'environment', requestId: 'deploy-request', requestEnvelopeDigest: 'A'.repeat(43),
    target: { kind: 'machine', machineId: 'controller' },
  } });
  return { surface: 'api', authority: 'account_automation', actionCaller: { kind: 'host' }, serverId: 'home-identity',
    serverIdentityId: 'home-identity', runtimeAccountId: 'owner', actionRequestId: 'deploy-request',
    externalActionCredential: { accountId: 'owner', principalId: 'principal', credentialId: 'deployment-token', grant },
    externalActionExecutionAuthorization: authorization, externalActionTarget: authorization.binding.target,
    actionsSettings: ActionsSettingsV1Schema.parse({ v: 1,
      approvalWaivedSurfaces: { 'deployments.deploy': ['api'] } }) };
}

describe('deployment role host-child scope', () => {
  it('retains the exact configure admission for the reviewed preview backup child', async () => {
    const root = context();
    const authorization = root.externalActionExecutionAuthorization!;
    const child = { action: 'deployments.backups.configure' as const, role: 'preview.backup',
      input: { serverId: 'home-identity', environmentId: 'environment', expectedRevision: 3, intent: 'markNotNeeded' } };
    const result = await invokeHostReviewedChildV1({
      parent: { actionId: 'deployments.environments.create', input: { serverId: 'home-identity' } },
      child,
      context: { ...root, externalActionExecutionAuthorization: { ...authorization,
        binding: { ...authorization.binding, actionId: 'deployments.environments.create' } } },
      admittedReview: { action: child.action, role: child.role, surface: 'api' },
      execute: async (_input, childContext) => ({ ok: true, result: readHostAdmittedReviewedChildV1(childContext) }),
    });
    expect(result).toMatchObject({ ok: true, result: { actionId: child.action, role: child.role,
      deploymentNativeAdmission: { kind: 'backupConfigure', actionId: child.action,
        environmentId: 'environment', expectedRevision: 3, intent: 'markNotNeeded', inputDigest: expect.any(String) } } });
  });

  it('retains the configure admission across the preview backup binding child', async () => {
    const root = context();
    const authorization = root.externalActionExecutionAuthorization!;
    const configure = { action: 'deployments.backups.configure' as const, role: 'preview.backup',
      input: { serverId: 'home-identity', environmentId: 'environment', expectedRevision: 3, intent: 'save',
        configuration: { configRevision: 1, destinationRef: { pluginId: 'happier.backup.local', localId: 'open' },
          occurrenceId: 'destination', config: { path: '/private/repository' }, credentialBindings: [],
          sources: [{ kind: 'dump', sourceId: 'database', service: 'postgres', consistency: 'logical' }],
          ownership: { environmentId: 'environment', prefix: '' }, retention: { kind: 'keepEverything' } } } };
    const binding = { action: 'deployments.bindings.set' as const, role: 'backup.bindings',
      input: { serverId: 'home-identity', environmentId: 'environment', expectedRevision: 4, set: [], remove: [] } };
    const result = await invokeHostReviewedChildV1({
      parent: { actionId: 'deployments.environments.create', input: { serverId: 'home-identity' } }, child: configure,
      context: { ...root, externalActionExecutionAuthorization: { ...authorization,
        binding: { ...authorization.binding, actionId: 'deployments.environments.create' } } },
      admittedReview: { action: configure.action, role: configure.role, surface: 'api' },
      execute: async (_input, configureContext) => invokeHostReviewedChildV1({
        parent: { actionId: configure.action, input: configure.input }, child: binding, context: configureContext,
        admittedReview: { action: binding.action, role: binding.role, surface: 'api' },
        execute: async (_input, bindingContext) => ({ ok: true, result: readHostAdmittedReviewedChildV1(bindingContext) }),
      }),
    });
    expect(result).toMatchObject({ ok: true, result: { actionId: binding.action, role: binding.role,
      deploymentNativeAdmission: { kind: 'backupConfigure', actionId: configure.action,
        environmentId: 'environment', expectedRevision: 3, intent: 'save' } } });
  });

  it('lends invocation-private connector custody only to the admitted child and its active parent', async () => {
    const lifetime = new AbortController();
    const deploymentResult = DeploymentReceiptAcceptedResultV1Schema.parse({ ok: true, environmentId: 'environment',
      revision: 4, kind: 'pending', actionOperationId: 'operation' });
    const bytes = new TextEncoder().encode('connector-token-never-in-action-input');
    const subject = { provider: { kind: 'builtin' as const, id: 'cloudflareNamed' }, connectorId: 'connector' };
    const grants = [
      { machineId: 'member-a', installationId: 'installation-a', grantRef: 'opaque-member-a-grant' },
      { machineId: 'member-b', installationId: 'installation-b', grantRef: 'opaque-member-b-grant' },
    ];
    const invocationServices = { machineConnectorSecrets: { write: async (value: Readonly<{
      token: Uint8Array; subject: typeof subject;
    }>) => {
      expect(value.subject).toEqual(subject);
      expect(value.token).toEqual(bytes);
      return { grants };
    } } };
    const childRequest = { ...request, invocationServices };
    let parentPort: ActionExecutorContext['hostReviewedChild'];
    let executed = 0;
    const publicOperands: unknown[] = [];
    const executor = createActionExecutor({
      resolveEnvironmentApprovalScope: async () => ({ scope: { kind: 'environment', environmentId: 'environment' } }),
      prepareDeploymentAction: async () => ({ input, preview: { sourceMethod: 'gitIntegration' },
        hostReviewedChildren: { children: [{ action: request.action, role: request.role }] } }),
      deploymentAction: async (_id, _input, admittedContext) => {
        parentPort = admittedContext.hostReviewedChild;
        if (!parentPort) throw new Error('Missing admitted reviewed-child port');
        const result = await parentPort.invoke(childRequest);
        if (!result.ok) return result;
        expect(result).toEqual({ ok: true, result: { grants } });
        publicOperands.push(result);
        expect(await parentPort.invoke(request)).toEqual({ ok: true, result: { connectorSink: 'absent' } });
        return deploymentResult;
      },
      // The contributed runtime is the Protocol package's host adapter boundary.
      // Its actual Action admission, reviewed-child issuer and cancellation remain real.
      invokeContributedAction: async ({ input: childInput, context: childContext }) => {
        executed++;
        publicOperands.push(childInput);
        expect(childInput).toEqual(roleInput);
        expect(childContext.signal).toBe(lifetime.signal);
        expect(readHostReviewedChildOperationV1(childContext, 'action.invoke', {
          action: request.action, input: childInput,
        })?.parent).toEqual({ actionId: 'deployments.deploy', input });
        const services: unknown = Reflect.get(childContext, 'invocationServices');
        if (executed === 2) {
          expect(services).toBeUndefined();
          return { ok: true, result: { connectorSink: 'absent' } };
        }
        if (!services || typeof services !== 'object' || !('machineConnectorSecrets' in services)) {
          throw new Error('Missing invocation-private connector custody');
        }
        const sink = services.machineConnectorSecrets;
        if (!sink || typeof sink !== 'object' || !('write' in sink) || typeof sink.write !== 'function') {
          throw new Error('Missing invocation-private connector writer');
        }
        const result: unknown = await sink.write({ token: bytes, subject });
        return { ok: true, result };
      },
    } satisfies Partial<ActionExecutorDeps>);
    try {
      const rootContext = { ...context(), signal: lifetime.signal,
        invocationServices: { machineConnectorSecrets: { write: async () => { throw new Error('Inherited custody is not this child'); } } } };
      const result = await executor.execute('deployments.deploy', input, rootContext);
      expect(result).toEqual({ ok: true, result: deploymentResult });
      expect(executed).toBe(2);
      expect(JSON.stringify({ input, publicOperands, result })).not.toContain('invocationServices');
      expect(JSON.stringify({ input, publicOperands, result })).not.toContain(new TextDecoder().decode(bytes));
      lifetime.abort();
      if (!parentPort) throw new Error('Missing captured reviewed-child port');
      expect(await parentPort.invoke(childRequest)).toMatchObject({ ok: false, errorCode: 'credential_scope_denied' });
      expect(executed).toBe(2);
    } finally { bytes.fill(0); }
  });

  it('invokes the declared deployment role through the common reviewed-child port after receipt admission', async () => {
    let reservations = 0;
    const executor = createActionExecutor({
      resolveEnvironmentApprovalScope: async () => ({ scope: { kind: 'environment', environmentId: 'environment' } }),
      prepareDeploymentAction: async () => ({ input, preview: { sourceMethod: 'gitIntegration' },
        hostReviewedChildren: { children: [{ action: request.action, role: request.role }] } }),
      deploymentAction: async (_id, _input, context) => {
        reservations++;
        if (!context.hostReviewedChild) return { ok: false, errorCode: 'credential_scope_denied', error: 'credential_scope_denied' };
        const result = await context.hostReviewedChild.invoke({ action: request.action, role: request.role, input: roleInput });
        return result.ok ? { ok: false, errorCode: 'unexpected_runtime', error: 'unexpected_runtime' } : result;
      },
    });
    expect(await executor.execute('deployments.deploy', input, context()))
      .toMatchObject({ ok: false, errorCode: 'contributed_action_unavailable' });
    expect(reservations).toBe(1);
  });

  it.each(['action.invoke', 'acme.fixture/actions/deploy'] as const)('admits explicit %s review before entering the receipt owner', async requiredActionId => {
    let reserved = false;
    const executor = createActionExecutor({
      resolveEnvironmentApprovalScope: async () => ({ scope: { kind: 'environment', environmentId: 'environment' } }),
      prepareDeploymentAction: async () => ({ input, preview: { sourceMethod: 'gitIntegration' },
        hostReviewedChildren: { children: [{ action: request.action, role: request.role }] } }),
      deploymentAction: async (_id, _input, context) => {
        reserved = true;
        const result = await context.hostReviewedChild!.invoke(request);
        return result.ok ? { ok: false, errorCode: 'unexpected_runtime', error: 'unexpected_runtime' } : result;
      },
    } satisfies Partial<ActionExecutorDeps>);
    const outcome = await executor.execute('deployments.deploy', input, { ...context(),
      interactivePresentation: 'unavailable', bypassApprovals: true,
      actionsSettings: ActionsSettingsV1Schema.parse({ v: 1,
        approvalWaivedSurfaces: { 'deployments.deploy': ['api'] },
        actions: { [requiredActionId]: { approvalRequiredSurfaces: ['api'] } } }) });
    expect(outcome).toMatchObject({ ok: false, errorCode: 'action_interactive_review_required' });
    expect(reserved).toBe(false);
  });

  it('uses the same scoped preference precedence during root preparation', async () => {
    const executor = createActionExecutor({
      resolveEnvironmentApprovalScope: async () => ({ scope: { kind: 'environment', environmentId: 'environment' } }),
      prepareDeploymentAction: async () => ({ input, preview: { sourceMethod: 'gitIntegration' },
        hostReviewedChildren: { children: [{ action: request.action, role: request.role }] } }),
      deploymentAction: async (_id, _input, context) => {
        const result = await context.hostReviewedChild!.invoke(request);
        return result.ok ? { ok: false, errorCode: 'unexpected_runtime', error: 'unexpected_runtime' } : result;
      },
    } satisfies Partial<ActionExecutorDeps>);
    expect(await executor.execute('deployments.deploy', input, { ...context(),
      actionsSettings: ActionsSettingsV1Schema.parse({ v: 1,
        approvalWaivedSurfaces: { 'deployments.deploy': ['api'] },
        actions: { 'action.invoke': { approvalRequiredSurfaces: ['api'] } },
        scopedApprovalPreferences: [{ actionId: 'action.invoke', scope: { kind: 'environment', environmentId: 'environment' },
          approvalRequiredSurfaces: [], approvalWaivedSurfaces: ['api'] }] }) }))
      .toMatchObject({ ok: false, errorCode: 'contributed_action_unavailable' });
  });

  it('consumes the captured role policy instead of opening a second approval after receipt admission', async () => {
    const executor = createActionExecutor({
      resolveEnvironmentApprovalScope: async () => ({ scope: { kind: 'environment', environmentId: 'environment' } }),
      prepareDeploymentAction: async () => ({ input, preview: { sourceMethod: 'gitIntegration' },
        hostReviewedChildren: { children: [{ action: request.action, role: request.role }] } }),
      deploymentAction: async (_id, _input, admittedContext) => {
        // Storage is the effect boundary. A later settings change belongs to
        // the next natural operation admission, not a new child proposal here.
        if (!admittedContext.actionsSettings) throw new Error('Missing admitted Account policy');
        admittedContext.actionsSettings.actions = ActionsSettingsV1Schema.parse({ v: 1,
          actions: { 'action.invoke': { approvalRequiredSurfaces: ['api'] } } }).actions;
        const result = await admittedContext.hostReviewedChild!.invoke(request);
        return result.ok ? { ok: false, errorCode: 'unexpected_runtime', error: 'unexpected_runtime' } : result;
      },
    } satisfies Partial<ActionExecutorDeps>);
    expect(await executor.execute('deployments.deploy', input, { ...context(), interactivePresentation: 'unavailable' }))
      .toMatchObject({ ok: false, errorCode: 'contributed_action_unavailable' });
  });

  it('refuses a declared role before reservation when its original-holder policy is unavailable', async () => {
    let reserved = false;
    const executor = createActionExecutor({
      resolveEnvironmentApprovalScope: async () => ({ scope: { kind: 'environment', environmentId: 'environment' } }),
      prepareDeploymentAction: async () => ({ input, preview: { sourceMethod: 'gitIntegration' },
        hostReviewedChildren: { children: [{ action: request.action, role: request.role }] } }),
      deploymentAction: async () => {
        reserved = true;
        return { ok: false, errorCode: 'unexpected_reservation', error: 'unexpected_reservation' };
      },
    } satisfies Partial<ActionExecutorDeps>);
    expect(await executor.execute('deployments.deploy', input, { ...context(), actionsSettings: null }))
      .toMatchObject({ ok: false, errorCode: 'admission_unavailable' });
    expect(reserved).toBe(false);
  });

  it('lets only the admitted exact role spend the deployment-only grant through its host port', async () => {
    // No contributed runtime is installed: the observable boundary proves grant
    // admission reaches the unavailable runtime, without mocking internal policy.
    const executor = createActionExecutor({
      resolveEnvironmentApprovalScope: async () => ({ scope: { kind: 'environment', environmentId: 'environment' } }),
      prepareDeploymentAction: async () => ({ input, preview: { sourceMethod: 'gitIntegration' },
        hostReviewedChildren: { children: [{ action: request.action, role: request.role }] } }),
      deploymentAction: async (_id, _input, context) => {
        const result = await context.hostReviewedChild!.invoke(request);
        return result.ok ? { ok: false, errorCode: 'unexpected_runtime', error: 'unexpected_runtime' } : result;
      },
    } satisfies Partial<ActionExecutorDeps>);
    expect(await executor.execute('deployments.deploy', input, context()))
      .toMatchObject({ ok: false, errorCode: 'contributed_action_unavailable' });
    expect(await executor.execute('action.invoke', { action: request.action, input: roleInput }, context()))
      .toMatchObject({ ok: false, errorCode: 'credential_scope_denied' });
  });

});


it.each(['issuer_binding', 'issuer_target', 'aborted', 'child_mismatch', 'no_plan'] as const)(
  'retains a closed reviewed-child refusal for %s before execution', async reason => {
    const root: ActionExecutorContext = { ...context(),
      ...(reason === 'issuer_binding' ? { runtimeAccountId: 'other-account' } : {}),
      ...(reason === 'issuer_target' ? { externalActionTarget: { kind: 'machine', machineId: 'other-machine' } as const } : {}),
      ...(reason === 'aborted' ? { signal: AbortSignal.abort() } : {}),
    };
    let executions = 0;
    const execute = async () => { executions++; return { ok: true as const, result: null }; };
    const parent = { actionId: 'deployments.deploy', input };
    const result = reason === 'no_plan' || reason === 'child_mismatch'
      ? await createHostReviewedChildPortV1({ ...parent, context: root, execute,
          ...(reason === 'child_mismatch' ? { plan: { children: [request] } } : {}),
        }).invoke({ ...request, ...(reason === 'child_mismatch' ? { role: 'other-role' } : {}) })
      : await invokeHostReviewedChildV1({ parent, child: request, context: root, execute });
    expect(result).toMatchObject({ ok: false, errorCode: 'credential_scope_denied',
      failureCause: { phase: 'deployment.reviewed_child', errorClass: 'Error', errorCode: reason, httpStatus: null } });
    expect(executions).toBe(0);
    expect(JSON.stringify(result)).not.toMatch(/fixture-root|other-account|other-machine|provider-account/);
  });
