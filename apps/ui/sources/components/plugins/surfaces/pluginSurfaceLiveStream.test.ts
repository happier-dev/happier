import { buildApprovalRequestArtifactHeaderV1 } from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';
import type { DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createActionExecutor} from '@happier-dev/protocol/actions/actionExecutor';

import { normalizeActionsSettingsV1} from '@happier-dev/protocol/actions/actionSettings';
import {
    type ActionExecutorDeps} from '@happier-dev/protocol/actions/executor/types';
import { type ApprovalRequest } from '@happier-dev/protocol/approvals/approvalRequestV1';
import type { PluginUiHostApiRequestEnvelopeV1, PluginUiSurfaceContextV1, PluginLiveStreamReferenceV1 } from '@happier-dev/protocol/plugins/ui';
import { createPluginSurfaceActionHostApi } from './pluginSurfaceActionDispatch';
import { createPluginSurfaceLiveStreamOwner } from './pluginSurfaceLiveStream';

// Only daemon network and native modal boundaries are substituted; admission and Action owners remain real.
const rpc = vi.hoisted(() => vi.fn());
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({ machineRpcWithServerScope: rpc }));
vi.mock('@/modal', async () => { const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal'); return createModalModuleMock().module; });
const source = { sourceId: 'host-screen', sourceOccurrenceId: 'screen-1', streamFamily: 'screen', supportedCodecs: ['image.mjpeg'], requiresApproval: true };
const surface: PluginUiSurfaceContextV1 = { pluginId: 'acme.viewer', contributionId: 'viewer', surfaceId: 'surface-1',
    placement: 'appSurface', platform: 'web', channel: 'internal', resourceScope: [], diagnostics: [] };
function request(reference: PluginLiveStreamReferenceV1, subscriptionId = 'view-1'): PluginUiHostApiRequestEnvelopeV1 {
    return { version: 1, requestId: subscriptionId, surface, method: 'watchLiveStream', payload: { reference, subscriptionId } };
}
function owner(decision: 'approve' | 'reject' = 'reject', pendingDecision?: Promise<'approve' | 'reject'>) {
    let approval: ApprovalRequest | undefined;
    const requests: ApprovalRequest[] = [];
    const admissions: unknown[] = [];
    const deps = {
        approvalsCreate: async (input) => { approval = input.request; requests.push(approval); return { artifactId: `approval-${requests.length}` }; },
        approvalsUpdate: async (input) => { approval = input.request; return { ok: true as const }; },
        approvalsWaitForDecision: async () => ({ decision: pendingDecision ? await pendingDecision : decision, request: approval! }),
        isApprovalExecutionOriginCurrent: async () => true,
        readActionsSettings: () => normalizeActionsSettingsV1({ v: 1 }),
    } satisfies Partial<ActionExecutorDeps>;
    // Boundary fixture supplies only approval storage/decision ports; unrelated Session ports are not exercised.
    const executor = createActionExecutor(deps as unknown as ActionExecutorDeps);
    const actionHost = createPluginSurfaceActionHostApi({ surfaceContext: surface,
        callerSourceCustody: { kind: 'development', registeredRootId: 'viewer-root' },
        callerBinding: { pluginId: surface.pluginId, contributionLocalId: 'viewer', occurrenceId: 'viewer-1',
            materializationRef: { pluginId: surface.pluginId, machineId: 'machine-1', materializationId: 'viewer-materialization' } },
        // The mounted controller stamps this from its admitted daemon binding.
        hostAction: { execute: executor.execute, context: { serverId: 'home-1', runtimeAccountId: 'account-1',
            executionRunTargetMachineId: 'machine-1' } },
    });
    const lifetime = new AbortController();
    const viewing = createPluginSurfaceLiveStreamOwner({ pluginId: surface.pluginId, occurrenceId: 'viewer-1',
        machineId: 'machine-1', serverId: 'home-1', lifetimeSignal: lifetime.signal, isCurrent: () => !lifetime.signal.aborted,
        scope: { serverId: 'home-1', accountId: 'account-1' },
        fetchArtifact: async (artifactId: string): Promise<DecryptedArtifact | null> => {
            if (!approval) return null;
            const answer = pendingDecision ? await pendingDecision : decision;
            const settled: ApprovalRequest = answer === 'approve' ? { ...approval, status: 'executed',
                decision: { kind: 'approve', decidedAtMs: 2 },
                execution: { executedAtMs: 2, ok: true, result: { admitted: true, sourceId: source.sourceId, sourceOccurrenceId: source.sourceOccurrenceId } } }
                : { ...approval, status: 'rejected', decision: { kind: 'reject', decidedAtMs: 2 } };
            return { id: artifactId, title: null, header: buildApprovalRequestArtifactHeaderV1(settled), body: JSON.stringify(settled),
                headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 2, isDecrypted: true };
        },
        executeAction: async (request, options) => {
            const admission = await actionHost.handleRequest(request, options);
            admissions.push(admission);
            return admission;
        } });
    return { viewing, lifetime, requests, admissions };
}
beforeEach(() => { rpc.mockReset().mockResolvedValue({ ok: true, source }); });
describe('mounted live stream viewing', () => {
    it.each(['mount', 'resource'] as const)('does not admit a viewing when its %s retires while Action approval is pending', async mode => {
        let answer: ((decision: 'approve' | 'reject') => void) | undefined;
        const { viewing, lifetime, requests } = owner('approve', new Promise(resolve => { answer = resolve; }));
        const pending = viewing.watchLiveStream(request({ kind: 'host', sourceId: source.sourceId }));
        await vi.waitFor(() => expect(requests).toHaveLength(1));
        if (mode === 'mount') lifetime.abort();
        else viewing.disposeHostResource({ ...request({ kind: 'host', sourceId: source.sourceId }), method: 'disposeHostResource', payload: { subscriptionId: 'view-1' } });
        answer?.('approve');
        expect(await pending).toMatchObject({ code: 'unavailable' });
        expect(viewing.readViewing('view-1')).toBeNull();
    });
    it('resolves another plugin producer without host approval and refuses rejected host viewing', async () => {
        const { viewing, requests } = owner();
        rpc.mockResolvedValueOnce({ ok: true, source: { ...source, requiresApproval: false } });
        expect(await viewing.watchLiveStream(request({ kind: 'plugin', source: { pluginId: 'acme.foreign', localId: 'screen' } }, 'foreign'))).toEqual({ kind: 'ready', subscriptionId: 'foreign' });
        expect(viewing.readViewing('foreign')).toMatchObject({ sourceId: source.sourceId });
        expect(requests).toHaveLength(0);
        expect(await viewing.watchLiveStream(request({ kind: 'host', sourceId: source.sourceId }))).toMatchObject({ code: 'unavailable' });
        expect(viewing.readViewing('view-1')).toBeNull();
        expect(requests).toHaveLength(1);
        viewing.dispose();
    });
    it('approves each host viewing separately while owned plugin capture needs no extra approval', async () => {
        const { viewing, requests, admissions } = owner('approve');
        for (const id of ['view-1', 'view-2']) {
            const result = await viewing.watchLiveStream(request({ kind: 'host', sourceId: source.sourceId }, id));
            expect(result, JSON.stringify(admissions)).toEqual({ kind: 'ready', subscriptionId: id });
        }
        expect(requests).toHaveLength(2);
        rpc.mockResolvedValue({ ok: true, source: { ...source, requiresApproval: false } });
        expect(await viewing.watchLiveStream(request({ kind: 'plugin', source: { pluginId: surface.pluginId, localId: 'screen' } }, 'owned'))).toEqual({ kind: 'ready', subscriptionId: 'owned' });
        expect(requests).toHaveLength(2);
        viewing.disposeHostResource({ ...request({ kind: 'host', sourceId: source.sourceId }), method: 'disposeHostResource', payload: { subscriptionId: 'view-1' } });
        expect(viewing.readViewing('view-1')).toBeNull();
        viewing.dispose();
    });
    it('cancels pending descriptor disclosure on resource disposal and mount retirement', async () => {
        const { viewing, lifetime } = owner('approve');
        let deliver: ((value: unknown) => void) | undefined;
        rpc.mockImplementation(() => new Promise(resolve => { deliver = resolve; }));
        const pending = viewing.watchLiveStream(request({ kind: 'host', sourceId: source.sourceId }));
        viewing.disposeHostResource({ ...request({ kind: 'host', sourceId: source.sourceId }), method: 'disposeHostResource', payload: { subscriptionId: 'view-1' } });
        deliver?.({ ok: true, source });
        expect(await pending).toMatchObject({ code: 'unavailable' });
        expect(viewing.readViewing('view-1')).toBeNull();
        lifetime.abort();
        expect(await viewing.watchLiveStream(request({ kind: 'host', sourceId: source.sourceId }))).toMatchObject({ code: 'unavailable' });
    });
});
