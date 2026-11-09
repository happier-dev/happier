import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPluginReloadController } from '@/plugins/runtime/reload/controller';
import { describe, expect, it } from 'vitest';
import { defineProtocolJsonValue } from '@happier-dev/plugin-sdk/protocol';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { createTargetActionApprovalDecision } from '@happier-dev/protocol/actions/targetActionApprovalDecision';
import { admitTargetActionApprovalTransition } from '@happier-dev/protocol/approvals/targetActionApprovalRequestTransition';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import { formatQualifiedPluginActionId } from '@happier-dev/protocol/plugins/actions/qualifiedActionId';
import { recordPresentUserApprovalV1 } from '@happier-dev/protocol/actions/executor/approvalReview';
import { TargetActionApprovalRequestV1Schema, type TargetActionApprovalRequestV1 } from '@happier-dev/protocol/approvals/targetActionApprovalRequestV1';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { createCommittedContributedActionInvoker } from '@/plugins/runtime/invocation/actions/createCommittedContributedActionDeps';
import { createAdmittedTargetedOperationExecutionHandle, createPluginInvocationActionsService, projectContributedActionExecuteResult, type InvokeContributedAction } from '@/plugins/runtime/invocation/services/actions';
import { createPluginActionCallerMaterializationFixture } from '@/plugins/runtime/invocation/services/actionCaller.testkit';
import { createTargetActionCurrentIntentAdapter } from '@/session/actions/approvals/targetActionCurrentIntent';
import { createExternalActionRuntime, publishAccountExternalActionRuntime } from './externalActionRuntime.testkit';

describe('Account relay consent at a contributed child admission', () => {
  it.each(['safe', 'writesRemote'] as const)('admits a different %s child under its own policy and consent', async dangerLevel => {
    let effects = 0;
    let approvals = 0;
    let stored: TargetActionApprovalRequestV1 | null = null;
    const runtime = createExternalActionRuntime('global', 'acme.child', () => { effects++; },
      () => null, () => null, undefined, undefined, dangerLevel, undefined, { surfaces: ['plugin'], executionTarget: 'account',
        sourceCustody: { kind: 'account_release', pluginId: 'acme.child', version: '1.0.0', archiveDigestSha256: `sha256:${'a'.repeat(64)}` } });
    const published = await publishAccountExternalActionRuntime(runtime);
    const parentRuntime = createExternalActionRuntime('global', 'acme.parent', undefined, undefined, undefined, undefined, undefined, 'safe', undefined, { localId: 'assign' });
    const parentHome = await mkdtemp(join(tmpdir(), 'account-relay-parent-'));
    const parentController = createPluginReloadController({ happyHomeDir: parentHome });
    const parentLease = await parentController.acquireRuntimeRegistry({ resolveRuntimeRegistry: async () => parentRuntime });
    await parentLease.release();
    const parentOccurrence = parentController.readCurrentPluginOccurrenceId!('acme.parent');
    if (!parentOccurrence) throw new Error('Expected the published parent occurrence');
    const lifetime = new AbortController();
    const artifactId = 'child-own-consent';
    let ready!: () => void;
    const created = new Promise<void>(resolve => { ready = resolve; });
    const read = async () => stored;
    const update = async ({ request }: { request: TargetActionApprovalRequestV1 }) => {
      if (!stored) throw new Error('Expected the child approval');
      const admitted = admitTargetActionApprovalTransition(stored, request);
      if (admitted.ok) stored = TargetActionApprovalRequestV1Schema.parse(request);
      return admitted;
    };
    const invoke = createCommittedContributedActionInvoker({ acquireRuntimeRegistryLease: published.acquire,
      requestCurrentIntent: createTargetActionCurrentIntentAdapter({
        // Only Artifact storage/change delivery is supplied. The original live
        // waiter and authenticated decision Action owner remain real.
        create: async request => { approvals++; stored = request; return { artifactId, request }; },
        read, update, subscribeChanges: () => { ready(); return { dispose() {} }; },
      }) });
    const invokeContributedAction: InvokeContributedAction = async request => projectContributedActionExecuteResult(await invoke({
      action: request.action, input: request.input, signal: request.signal,
      context: { ...request.approvalContext, surface: request.surface, authority: 'account_automation', actionCaller: request.initiatingActionCaller },
    }));
    const childOccurrence = runtime.readPluginOccurrenceId!('acme.child')!;
    const operation = createAdmittedTargetedOperationExecutionHandle({
      action: { pluginId: 'acme.child', localId: 'inspect' }, targetOccurrenceId: parentOccurrence,
      identity: { target: { pluginId: 'acme.parent' },
        point: { pointId: 'sources', protocol: { id: 'acme.parent/inspect', version: 1 } },
        contributor: { pluginId: 'acme.child', contributionId: 'primary', occurrenceId: childOccurrence,
          sourceCustody: { kind: 'account_release', pluginId: 'acme.child', version: '1.0.0', archiveDigestSha256: `sha256:${'a'.repeat(64)}` } }, role: 'inspect' },
      targetProtocol: { role: 'inspect', input: { kind: 'contributorDefined' }, resultSchema: defineProtocolJsonValue() },
    });
    const parentInput = { action: { pluginId: 'acme.parent', localId: 'assign' }, input: { issue: 'ISSUE-42' } };
    const approval = recordPresentUserApprovalV1({ actionId: 'action.invoke', input: parentInput,
      requestId: 'parent-request', decidingAccountId: 'alice', requestSurface: 'ui' });
    const service = createPluginInvocationActionsService({
      seed: { plugin: { id: 'acme.parent', version: '1.0.0' }, contribution: { id: 'assign', qualifiedId: 'acme.parent/actions/assign' },
        occurrenceId: parentOccurrence, sourceCustody: { kind: 'development', registeredRootId: 'parent-root' },
        resolveCurrentPluginMaterializationRef: createPluginActionCallerMaterializationFixture('acme.parent').resolveCurrentPluginMaterializationRef,
        surface: 'plugin', signal: lifetime.signal, isOccurrenceCurrent: () => parentController.isPluginOccurrenceCurrent!('acme.parent', parentOccurrence),
        approvalContext: { surface: 'ui', authority: 'account_automation', actionRequestId: 'parent-request', runtimeAccountId: 'alice',
          actionsSettings: ActionsSettingsV1Schema.parse({ v: 1, actions: dangerLevel === 'writesRemote'
            ? { [formatQualifiedPluginActionId({ pluginId: 'acme.child', localId: 'inspect' })]: { approvalRequiredSurfaces: ['plugin'] } } : {} }),
          serverId: 'parent-home', expectedContributedActionOccurrenceId: parentOccurrence, presentUserApproval: approval,
          presentUserConfirmation: { actionId: 'action.invoke', requestId: 'parent-request', accountId: 'alice',
            serverId: 'parent-home', inputDigest: approval.inputDigest } },
      },
      actionExecutor: createActionExecutor(createUnavailableActionTransportDeps()), invokeContributedAction,
    });
    try {
      const pending = service.executeAdmittedTargetedOperation(operation, {});
      void pending.catch(() => undefined);
      if (dangerLevel === 'writesRemote') {
        await Promise.race([created, pending.then(() => { throw new Error('Child executed before its own consent'); })]);
        expect({ effects, approvals }).toEqual({ effects: 0, approvals: 1 });
        expect(stored).toMatchObject({ status: 'open', qualifiedActionId: formatQualifiedPluginActionId({ pluginId: 'acme.child', localId: 'inspect' }) });
        const decider = createActionExecutor({ ...createUnavailableActionTransportDeps(),
          targetActionApprovalReplay: createTargetActionApprovalDecision({ read, update }) });
        expect(await decider.execute('approval.request.decide', { artifactId, decision: 'approve' },
          { surface: 'ui', authority: 'present_user', runtimeAccountId: 'alice' })).toMatchObject({ ok: true });
      }
      await expect(pending).resolves.toMatchObject({ surface: 'plugin' });
      expect({ effects, approvals }).toEqual({ effects: 1, approvals: dangerLevel === 'safe' ? 0 : 1 });
      if (dangerLevel === 'writesRemote') expect(stored).toMatchObject({ status: 'executed', execution: { ok: true } });
    } finally { lifetime.abort(); await published.dispose(); await parentController.shutdown(); await rm(parentHome, { recursive: true, force: true }); }
  });
});
