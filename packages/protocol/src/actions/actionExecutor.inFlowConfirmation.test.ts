import { describe, expect, it } from 'vitest';
import { createActionExecutor, type ActionExecutorContext } from './actionExecutor.js';
import { ActionsSettingsV1Schema } from './actionSettings.js';
import { computeActionInputApprovalDigestV1 } from './decisionAuthority.js';
import { MachineSetupApplyInputV1Schema, ManagedAcquireInputV1Schema } from '../machines/managed/actionsV1.js';
import { ApprovalRequestV2Schema, type ApprovalRequestV2 } from '../approvals/approvalRequestV1.js';
import { decideApprovalRequestTransition } from '../approvals/approvalRequestTransition.js';
import { getActionSpec } from './actionSpecs.js';
import { artifactHtmlBundleFromBodyV1 } from '../artifacts/artifactHtmlV1.js';
import { ExternalActionExecutionAuthorizationV1Schema } from './externalActionApi.js';
import { computeExternalActionRequestEnvelopeDigestV1 } from './externalActionExecutionAuthorization.js';
import { PluginActionContributionV2Schema } from '../plugins/actions/v2.js';
import { fingerprintPluginAccountActionConfirmation } from '../plugins/actions/invocation.js';
import { admitPresentUserConfirmationV1 } from './executor/approvalReview.js';

const actionId = 'machines.setup.apply' as const;
const input = MachineSetupApplyInputV1Schema.parse({ homeId: 'home', machineId: 'machine', targets: [{
  homeId: 'home', machineId: 'machine', desiredRevision: 1,
  sources: [{ kind: 'direct', setup: { scripts: [{ body: 'install-browser' }] } }], recipePlans: [],
}] });
const settings = ActionsSettingsV1Schema.parse({ v: 1, actions: {
  [actionId]: { approvalRequiredSurfaces: ['agent', 'mcp'] },
} });
const context: ActionExecutorContext = { surface: 'ui', authority: 'present_user',
  actionCaller: { kind: 'host' }, serverId: 'home', runtimeAccountId: 'owner', actionRequestId: 'install',
  externalActionTarget: { kind: 'machine', machineId: 'machine' }, actionsSettings: settings };

describe('one in-flow confirmation for the requested operation', () => {
  function signedVoiceContext(): ActionExecutorContext {
    const envelope = { v: 1, requestId: 'install', target: { kind: 'machine', machineId: 'machine' }, input } as const;
    // Home signature verification is upstream of this process-neutral owner;
    // retain its real parsed Account/action/request/target binding here.
    const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'home-verified-root', binding: {
      accountId: 'owner', custodianAccountId: 'owner', authentication: { kind: 'account', tokenEpoch: 1 },
      serverIdentityId: 'home', machineId: 'machine', installationId: 'installation', actionId,
      requestId: envelope.requestId, target: envelope.target, accountEncryptionMode: 'plain', admittedMachineRole: 'manage',
      requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
    } });
    return { ...context, surface: 'voice', externalActionExecutionAuthorization: authorization,
      originalActionEnvelope: envelope, presentUserConfirmation: { actionId,
        inputDigest: computeActionInputApprovalDigestV1(actionId, input), requestId: envelope.requestId,
        accountId: 'owner', serverId: 'home', target: envelope.target } };
  }

  it('admits exact Account-bound Voice confirmation before operation acceptance and consumes it once', () => {
    const confirmed = signedVoiceContext();
    expect(confirmed.operationAcceptance).toBeUndefined();
    expect(admitPresentUserConfirmationV1(actionId, input, confirmed)).toMatchObject({ actionId,
      requestId: 'install', decidingAccountId: 'owner', requestSurface: 'voice',
      inputDigest: computeActionInputApprovalDigestV1(actionId, input) });
    expect(admitPresentUserConfirmationV1(actionId, input, confirmed)).toBeNull();
  });

  it('never turns Plugin Account wrapper consent into a present-user host review', () => {
    const confirmed = signedVoiceContext();
    const wrapper = { action: { pluginId: 'acme.picker', localId: 'assign' }, input: { assignee: 'alice' } };
    const actionId = 'action.invoke';
    const plugin: ActionExecutorContext = { ...confirmed, surface: 'ui', authority: 'account_automation',
      actionCaller: { kind: 'plugin', pluginId: 'acme.picker', contributionLocalId: 'assignee' },
      externalActionExecutionAuthorization: ExternalActionExecutionAuthorizationV1Schema.parse({
        ...confirmed.externalActionExecutionAuthorization!, binding: {
          ...confirmed.externalActionExecutionAuthorization!.binding, actionId,
        },
      }),
      presentUserConfirmation: { ...confirmed.presentUserConfirmation!, actionId,
        inputDigest: computeActionInputApprovalDigestV1(actionId, wrapper) },
    };
    expect(admitPresentUserConfirmationV1(actionId, wrapper, plugin)).toBeNull();
  });

  function signedTerminalCliContext(): ActionExecutorContext {
    const confirmed = signedVoiceContext();
    const authorization = confirmed.externalActionExecutionAuthorization!;
    return { ...confirmed, surface: 'cli', externalActionExecutionAuthorization:
      ExternalActionExecutionAuthorizationV1Schema.parse({ ...authorization, binding: { ...authorization.binding,
        custodianAccountId: 'host', authentication: { kind: 'terminal', tokenEpoch: 1 },
      } }) };
  }

  it('admits the deciding human CLI confirmation under its exact paired-terminal root once', () => {
    const confirmed = signedTerminalCliContext();
    expect(admitPresentUserConfirmationV1(actionId, input, confirmed)).toMatchObject({ actionId,
      decidingAccountId: 'owner', requestSurface: 'cli' });
    expect(admitPresentUserConfirmationV1(actionId, input, confirmed)).toBeNull();
  });

  it.each(['account', 'home', 'target', 'input', 'mcp', 'automation'] as const)(
    'does not admit a paired-terminal CLI confirmation for changed %s', variant => {
      const confirmed = signedTerminalCliContext();
      const changed: ActionExecutorContext = { ...confirmed,
        ...(variant === 'account' ? { runtimeAccountId: 'other' } : {}),
        ...(variant === 'home' ? { serverId: 'other' } : {}),
        ...(variant === 'target' ? { externalActionTarget: { kind: 'machine', machineId: 'other' } } : {}),
        ...(variant === 'mcp' ? { surface: 'mcp' } : {}),
        ...(variant === 'automation' ? { authority: 'account_automation' } : {}),
      };
      expect(admitPresentUserConfirmationV1(actionId,
        variant === 'input' ? { ...input, machineId: 'other' } : input, changed)).toBeNull();
    },
  );

  it.each(['account', 'request', 'action', 'target', 'authentication', 'input'] as const)(
    'refuses an Account-bound Voice confirmation with a mismatched %s', variant => {
      const confirmed = signedVoiceContext();
      const authorization = confirmed.externalActionExecutionAuthorization!;
      const binding = authorization.binding;
      const replacement = variant === 'account' ? { ...binding, accountId: 'other' }
        : variant === 'request' ? { ...binding, requestId: 'other' }
        : variant === 'action' ? { ...binding, actionId: 'machines.setup.plan' }
        : variant === 'target' ? { ...binding, target: { kind: 'machine' as const, machineId: 'other' } }
        : variant === 'authentication' ? { ...binding, authentication: { kind: 'terminal' as const, tokenEpoch: 1 } }
        : binding;
      const changed = { ...confirmed, externalActionExecutionAuthorization: { ...authorization, binding: replacement } };
      expect(admitPresentUserConfirmationV1(actionId, variant === 'input' ? { ...input, machineId: 'other' } : input, changed)).toBeNull();
      // A refused unrelated invocation must not consume the intended confirmation.
      expect(admitPresentUserConfirmationV1(actionId, input, confirmed)).not.toBeNull();
    },
  );

  it('runs exact Account-bound Voice setup without a second card before the operation owner admits effects', async () => {
    let applied = 0;
    const executor = createActionExecutor({ machineSetupApply: async () => {
      applied++;
      return { operationId: 'install-operation' };
    } });
    expect(await executor.execute(actionId, input, signedVoiceContext())).toMatchObject({ ok: true,
      result: { operationId: 'install-operation' } });
    expect(applied).toBe(1);
  });

  it.each([false, true])('answers demanded enrollment child Ask with the person’s confirmed UI intent (%s)', async explicitAsk => {
    const actionId = 'machines.managed.acquire';
    const input = ManagedAcquireInputV1Schema.parse({
      enrollmentIdentity: { kind: 'dedicatedDaemonUser', username: 'happier', serviceMode: 'user',
        role: 'deployTarget', adminAccessAtCreation: 'preauthorized' },
      selection: { kind: 'one-off', homeId: 'home', controller: { machineId: 'machine', installationId: 'installation' },
        launch: { provider: { pluginId: 'acme.compute', localId: 'vm' }, schemaVersion: 1, name: 'guest', choices: {} },
        retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false },
    });
    let acquired = false;
    let approvals = 0;
    const executor = createActionExecutor({
      // Native acquisition and Artifact persistence are external host ports;
      // enrollment declarations and all approval policy remain real.
      managedMachineAction: async () => { acquired = true; return { managedId: 'managed' }; },
      approvalsCreate: async () => { approvals++; return { artifactId: 'explicit-child-review' }; },
    });
    const result = await executor.execute(actionId, input, { ...context,
      actionsSettings: ActionsSettingsV1Schema.parse({ v: 1, actions: explicitAsk
        ? { 'machines.setup.adminAccess.set': { approvalRequiredSurfaces: ['ui'] } } : {} }),
      presentUserConfirmation: { actionId, inputDigest: computeActionInputApprovalDigestV1(actionId, input),
        requestId: context.actionRequestId, accountId: context.runtimeAccountId,
        serverId: context.serverId, target: context.externalActionTarget },
    });
    expect(result).toMatchObject({ ok: true, result: { managedId: 'managed' } });
    expect(acquired).toBe(true);
    expect(approvals).toBe(0);
  });

  it('projects the core contextual danger for an HTML widget review rather than its safe declaration default', async () => {
    const actionId = 'widgets.definition.create';
    const input = { account: { serverId: 'home', accountId: 'owner' }, artifactId: '9616c69f-d1b1-4904-8b3c-fccf7918cb7c',
      definition: { name: 'Spoken HTML',
      body: { kind: 'html', source: artifactHtmlBundleFromBodyV1('<p>Read this back before saving.</p>') },
      inputs: { fields: [] }, inputSchema: { type: 'object', additionalProperties: false },
      sizeDeclaration: { sizes: ['medium'], defaultSize: 'medium' },
    } };
    expect(getActionSpec(actionId).safety).toBe('safe');
    getActionSpec(actionId).inputSchema.parse(input);
    const executor = createActionExecutor({ widgetAccountScope: () => ({ serverId: 'home', accountId: 'owner' }) });
    const prepared = await executor.prepare(actionId, input, { ...context, surface: 'voice',
      externalActionTarget: undefined }, { reviewOnly: true });
    expect(prepared).toMatchObject({ kind: 'ready', operation: { actionId, safety: 'danger' } });
  });

  it('prepares an unconfirmed review without creating custody, and running it still requires the ordinary Ask', async () => {
    const actionId = 'notifications.webhooks.remove';
    const input = { channelId: 'spoken-webhook-removal' };
    let removed = 0;
    let approvals = 0;
    const observed: unknown[] = [];
    const executor = createActionExecutor({
      notificationConfigurationAction: async () => { removed++; return { channelId: input.channelId }; },
      approvalsCreate: async () => { approvals++; return { artifactId: 'ordinary-review' }; },
      // The external plugin observation port must not publish an unexecuted review as settlement.
      observeActionExecution: async event => { observed.push(event); },
    });
    const prepared = await executor.prepare(actionId, input,
      { ...context, externalActionTarget: undefined }, { reviewOnly: true });
    expect(prepared).toMatchObject({ kind: 'ready', operation: { actionId,
      inputDigest: computeActionInputApprovalDigestV1(actionId, input), summary: expect.any(String) } });
    expect(approvals).toBe(0);
    expect(removed).toBe(0);
    expect(observed).toEqual([]);
    if (prepared.kind !== 'ready') throw new Error('Expected non-authorizing prepared review');
    expect(await prepared.invocation.run()).toMatchObject({ ok: true, result: {
      kind: 'approval_request_created', artifactId: 'ordinary-review', actionId,
    } });
    expect(approvals).toBe(1);
    expect(removed).toBe(0);
    expect(observed).toEqual([]);
  });

  it('exposes the safe prepared operation summary and digest without dispatching it', async () => {
    const actionId = 'notifications.webhooks.remove';
    const input = { channelId: 'spoken-webhook-removal' };
    let removed = 0;
    let approvals = 0;
    const executor = createActionExecutor({
      notificationConfigurationAction: async () => { removed++; return { channelId: input.channelId }; },
      approvalsCreate: async () => { approvals++; return { artifactId: 'unexpected-preparation-ask' }; },
    });
    const prepared = await executor.prepare(actionId, input, {
      ...context, externalActionTarget: undefined,
      presentUserConfirmation: { actionId, inputDigest: computeActionInputApprovalDigestV1(actionId, input),
        requestId: context.actionRequestId, accountId: context.runtimeAccountId, serverId: context.serverId, target: null },
    }, { reviewOnly: true });
    expect(prepared).toMatchObject({ kind: 'ready', operation: { actionId,
      inputDigest: computeActionInputApprovalDigestV1(actionId, input), summary: expect.any(String) } });
    expect(removed).toBe(0);
    expect(approvals).toBe(0);
  });

  it('answers default Ask for an irreversible Voice operation after the host read-back without an approval Artifact', async () => {
    const actionId = 'notifications.webhooks.remove';
    const input = { channelId: 'spoken-webhook-removal' };
    expect(getActionSpec(actionId).irreversible).toBe(true);
    const removed: unknown[] = [];
    const createdApprovals: unknown[] = [];
    const executor = createActionExecutor({
      // The answering notification client and Artifact persistence are external
      // ports of this process-neutral admission owner; policy/review stay real.
      notificationConfigurationAction: async ({ input }) => {
        removed.push(input);
        return { channelId: 'spoken-webhook-removal' };
      },
      approvalsCreate: async ({ request }) => {
        createdApprovals.push(request);
        return { artifactId: 'unexpected-second-confirmation' };
      },
    });
    const requestId = 'spoken-transcript-turn:remove-webhook';
    // This owner consumes the exact completed host confirmation. Voice's
    // composed producer test must separately prove read-back precedes this call.
    expect(await executor.execute(actionId, input, {
      surface: 'voice', authority: 'present_user', actionCaller: { kind: 'host' },
      serverId: 'home', runtimeAccountId: 'owner', actionRequestId: requestId,
      presentUserConfirmation: { actionId, inputDigest: computeActionInputApprovalDigestV1(actionId, input),
        requestId, accountId: 'owner', serverId: 'home', target: null },
    })).toMatchObject({ ok: true, result: { channelId: 'spoken-webhook-removal' } });
    expect(removed).toEqual([input]);
    expect(createdApprovals).toEqual([]);
  });

  it('answers explicit own-UI Ask with the designed confirmation without an approval Artifact', async () => {
    let applied = 0;
    let approvals = 0;
    const executor = createActionExecutor({
      approvalsCreate: async () => { approvals++; return { artifactId: 'explicit-install-approval' }; },
      machineSetupApply: async () => { applied++; return { operationId: 'install-operation' }; },
    });
    expect(await executor.execute(actionId, input, {
      ...context,
      actionsSettings: ActionsSettingsV1Schema.parse({ v: 1, actions: {
        [actionId]: { approvalRequiredSurfaces: ['ui'] },
      } }),
      presentUserConfirmation: { actionId, inputDigest: computeActionInputApprovalDigestV1(actionId, input),
        requestId: context.actionRequestId, accountId: context.runtimeAccountId,
        serverId: context.serverId, target: context.externalActionTarget },
    })).toMatchObject({ ok: true, result: { operationId: 'install-operation' } });
    expect(applied).toBe(1);
    expect(approvals).toBe(0);
  });

  it('folds an agent’s explicitly required internal step into the same parent approval', async () => {
    let applied = 0;
    const child = { action: 'machines.work.summary.get' as const, role: 'inspect',
      input: { serverId: 'home', machineId: 'machine' } };
    const executor = createActionExecutor({
      prepareHostReviewedChildren: async ({ actionId }) => actionId === 'machines.setup.apply' ? { children: [child] } : null,
      approvalsCreate: async () => ({ artifactId: 'explicit-step-approval' }),
      machineSetupApply: async () => { applied++; return { operationId: 'unexpected' }; },
    });
    expect(await executor.execute(actionId, input, {
      ...context, surface: 'agent', authority: 'account_automation',
      actionsSettings: ActionsSettingsV1Schema.parse({ v: 1, actions: {
        [child.action]: { approvalRequiredSurfaces: ['agent'] },
      } }),
      presentUserConfirmation: { actionId, inputDigest: computeActionInputApprovalDigestV1(actionId, input),
        requestId: context.actionRequestId, accountId: context.runtimeAccountId,
        serverId: context.serverId, target: context.externalActionTarget },
    })).toMatchObject({ ok: true, result: { kind: 'approval_request_created', artifactId: 'explicit-step-approval' } });
    expect(applied).toBe(0);
  });

  it('projects the same reviewed parent after an in-place deferred approval decision', async () => {
    let request: ApprovalRequestV2 | null = null;
    let reviewedParent: unknown;
    const executor = createActionExecutor({
      // Artifact storage and the external origin's currentness are system boundaries;
      // review admission, decision transitions and effect dispatch remain real.
      approvalsCreate: async ({ request: value }) => {
        request = ApprovalRequestV2Schema.parse(value);
        return { artifactId: 'install-approval' };
      },
      approvalsGet: async () => request,
      approvalsUpdate: async ({ request: next }) => {
        if (!request) throw new Error('Missing pending install approval');
        const transition = decideApprovalRequestTransition(request, next);
        if (!transition.ok) return transition;
        request = ApprovalRequestV2Schema.parse(next);
        return { ok: true };
      },
      isApprovalExecutionOriginCurrent: async () => true,
      machineSetupApply: async ({ context }) => {
        reviewedParent = context.hostReviewedChild?.parent;
        return { operationId: 'install-operation' };
      },
    });
    expect(await executor.execute(actionId, input, { ...context, surface: 'agent', authority: 'account_automation' }))
      .toMatchObject({ ok: true, result: { kind: 'approval_request_created', artifactId: 'install-approval' } });
    expect(await executor.execute('approval.request.decide', { artifactId: 'install-approval', decision: 'approve' }, context))
      .toMatchObject({ ok: true, result: { status: 'executed' } });
    expect(reviewedParent).toEqual({ actionId, input });
  });

  it.each(['ui', 'voice'] as const)('answers default Ask for the exact Setup operation and its reviewed child without an approval Artifact (%s)', async surface => {
    let applied = 0;
    let childReads = 0;
    const child = { action: 'machines.work.summary.get' as const, role: 'inspect',
      input: { serverId: 'home', machineId: 'machine' } };
    const executor = createActionExecutor({
      prepareHostReviewedChildren: async ({ actionId }) => actionId === 'machines.setup.apply' ? { children: [child] } : null,
      machineWorkSummaryGet: async () => { childReads++; return { kind: 'current', requesters: [] }; },
      machineSetupApply: async ({ context }) => {
        const result = await context.hostReviewedChild!.invoke(child);
        if (!result.ok) return result;
        applied++;
        return { operationId: 'install-operation' };
      },
    });
    const confirmed = { ...context, surface, presentUserConfirmation: { actionId,
      inputDigest: computeActionInputApprovalDigestV1(actionId, input), requestId: context.actionRequestId,
      accountId: context.runtimeAccountId, serverId: context.serverId, target: context.externalActionTarget } };
    expect(await executor.execute(actionId, input, confirmed)).toMatchObject({ ok: true, result: { operationId: 'install-operation' } });
    expect(applied).toBe(1);
    expect(childReads).toBe(1);
    // Reusing confirmation is not a second user intent, even for the same Action/input.
    expect(await executor.execute(actionId, input, confirmed)).toMatchObject({ ok: false, errorCode: 'approvals_not_supported' });
    expect(applied).toBe(1);
  });

  it.each(['agent', 'mcp', 'changed-input', 'changed-account', 'changed-home', 'changed-request', 'changed-target'] as const)(
    'retains Ask for %s instead of applying an unrelated confirmation', async variant => {
      let applied = 0;
      const executor = createActionExecutor({ machineSetupApply: async () => { applied++; return { operationId: 'unexpected' }; } });
      const confirmed = { ...context, presentUserConfirmation: { actionId,
        inputDigest: computeActionInputApprovalDigestV1(actionId, input), requestId: context.actionRequestId,
        accountId: context.runtimeAccountId, serverId: context.serverId, target: context.externalActionTarget } };
      const changedContext = variant === 'agent' || variant === 'mcp'
        ? { ...confirmed, surface: variant, authority: 'account_automation' as const }
        : variant === 'changed-account' ? { ...confirmed, runtimeAccountId: 'other' }
        : variant === 'changed-home' ? { ...confirmed, serverId: 'other' }
        : variant === 'changed-request' ? { ...confirmed, actionRequestId: 'other' }
        : variant === 'changed-target' ? { ...confirmed, externalActionTarget: { kind: 'machine' as const, machineId: 'other' } }
        : confirmed;
      const operand = variant === 'changed-input' ? { ...input, machineId: 'other' } : input;
      expect(await executor.execute(actionId, operand, changedContext)).toMatchObject({ ok: false, errorCode: 'approvals_not_supported' });
      expect(applied).toBe(0);
    },
  );
});


describe('portable Account Action consent binding', () => {
  const declaration = PluginActionContributionV2Schema.parse({ id: 'assign', title: 'Assign', scopes: ['global'],
    surfaces: ['ui', 'plugin'], placementBindings: ['detailsPanel'], dangerLevel: 'writesRemote',
    execution: { target: 'account', account: { artifactId: 'portable', exportName: 'activate' } },
    confirmation: { title: 'Assign', body: 'Assign this issue?', confirmLabel: 'Assign' } });
  const requested = { pluginId: 'acme.picker', pluginVersion: '1.2.3', declaration,
    input: { action: { pluginId: 'acme.picker', localId: 'assign' }, input: { assignee: 'alice' } } };
  it('retains bundled consent across host build roots while binding the whole declaration', () => {
    const browser = fingerprintPluginAccountActionConfirmation({ ...requested,
      sourceCustody: { kind: 'bundled_first_party', packagedRuntime: { kind: 'source_declaration', packageName: '@acme/picker' } } });
    const daemon = { ...requested, sourceCustody: { kind: 'bundled_first_party' as const,
      packagedRuntime: { kind: 'cli_version_root' as const, versionRootId: 'another-build-root' } } };
    expect(browser).not.toBeNull();
    expect(fingerprintPluginAccountActionConfirmation(daemon)).toBe(browser);
    expect(fingerprintPluginAccountActionConfirmation({ ...daemon,
      declaration: PluginActionContributionV2Schema.parse({ ...declaration,
        confirmation: { ...declaration.confirmation, title: 'Review different effect' } }) })).not.toBe(browser);
    expect(fingerprintPluginAccountActionConfirmation({ ...daemon, declaration: undefined })).toBeNull();
  });
});
