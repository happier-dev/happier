import { describe, expect, it } from 'vitest';
import { createActionExecutor} from '@happier-dev/protocol/actions/actionExecutor';
import { normalizeActionsSettingsV1 } from '@happier-dev/protocol/actions/actionSettings';
import { createHomeHubArtifactPortV1 } from '@happier-dev/protocol/home';
import { createWidgetActionInputResolverV1 } from '@happier-dev/protocol/widgets';
import { createWorkBoardArtifactBoundary } from '@/dev/testkit/harness/workBoardArtifactBoundary';
import { createActionExecutorBoundaryFixture } from '@/dev/testkit/fixtures/actionExecutorBoundary';
import { createHomeHubAccountStore } from './homeHubAccountStore';
import { executeHomeHubLayoutIntent } from './homeHubActionWriter';
import { createActionApprovalContinuationObserver } from '@/components/approvals/actionApprovalContinuation';

// The ACK/recovery cases run under the user's persisted waiver, not an unwired
// policy hook that must fail closed before reaching the Artifact transport.
const actionsSettings = normalizeActionsSettingsV1({ v: 1,
    approvalWaivedSurfaces: { 'widgets.item.size.set': ['ui'] },
});

describe('Home mounted size Action adapter', () => {
    it('retains a validated size acknowledgement when the subsequent Home layout read is unavailable without replaying it', async () => {
        const boundary = createWorkBoardArtifactBoundary({ v: 1, boards: [] });
        const scope = { serverId: 'home', accountId: 'one' };
        const transport = boundary.forAccount(scope.accountId);
        const owner = createHomeHubArtifactPortV1(transport, { accountId: scope.accountId });
        await owner.apply({ kind: 'widget_add', instance: { v: 1, id: 'checks', definition: { kind: 'installed',
            surface: { pluginId: 'acme.checks', localId: 'summary' } }, bindings: {} } });
        const executor = createActionExecutor(createActionExecutorBoundaryFixture({ homeHubArtifacts: owner, widgetAccountScope: () => scope,
            widgetInputs: createWidgetActionInputResolverV1({ readDescriptor: async () => ({
                sizeDeclaration: { sizes: ['medium', 'tall'], defaultSize: 'medium' }, inputs: { fields: [] },
                inputSchema: { type: 'object', additionalProperties: false } }), readContext: async () => ({}),
                readViewerValues: async () => ({ values: {} }), validateValue: async () => ({ status: 'valid' }), resolveOptions: async () => [] }),
        }));
        let executions = 0;
        const execute: typeof executor.execute = async (id, args, context) => {
            const result = await executor.execute(id, args, { ...context, actionsSettings });
            if (id === 'widgets.item.size.set' && result.ok) { executions++; boundary.offline(true); }
            return result;
        };
        const approval = createActionApprovalContinuationObserver({ onExecuted: () => {} });
        const store = createHomeHubAccountStore({ accountId: scope.accountId, transport, isCurrent: () => true,
            execute: intent => executeHomeHubLayoutIntent({ intent, scope, transport, execute, onApprovalPending: approval.requestApproval }) });
        await store.refresh();
        const previous = store.getSnapshot().layout;
        await expect(store.dispatch({ kind: 'widget_size', instanceId: 'checks', size: 'tall' }, { rethrow: true })).resolves.toBeUndefined();
        expect(store.getSnapshot()).toMatchObject({ status: 'error', layout: previous });
        expect(store.getSnapshot().failedIntent).toBeUndefined();
        boundary.offline(false);
        await store.retry();
        expect(executions).toBe(1);
        expect(store.getSnapshot()).toMatchObject({ status: 'ready', layout: { items: expect.arrayContaining([{ kind: 'widget',
            instance: expect.objectContaining({ id: 'checks' }), size: 'tall' }]) } });
        expect(store.getSnapshot().layout).toEqual(await owner.read());
    });
    it('uses the universal Action and retains a failed size for retry before reconciling the committed layout', async () => {
        const boundary = createWorkBoardArtifactBoundary({ v: 1, boards: [] });
        const scope = { serverId: 'home', accountId: 'one' };
        const transport = boundary.forAccount(scope.accountId);
        const owner = createHomeHubArtifactPortV1(transport, { accountId: scope.accountId });
        await owner.apply({ kind: 'widget_add', instance: { v: 1, id: 'checks', definition: { kind: 'installed',
            surface: { pluginId: 'acme.checks', localId: 'summary' } }, bindings: {} } });
        const executor = createActionExecutor(createActionExecutorBoundaryFixture({ homeHubArtifacts: owner, widgetAccountScope: () => scope,
            widgetInputs: createWidgetActionInputResolverV1({ readDescriptor: async () => ({
                sizeDeclaration: { sizes: ['medium', 'tall'], defaultSize: 'medium' }, inputs: { fields: [] },
                inputSchema: { type: 'object', additionalProperties: false } }), readContext: async () => ({}),
                readViewerValues: async () => ({ values: {} }), validateValue: async () => ({ status: 'valid' }), resolveOptions: async () => [] }),
        }));
        const requests: string[] = [];
        // This observer delegates every request to the real executor; only Artifact I/O is simulated.
        const execute: typeof executor.execute = (id, args, context) => {
            requests.push(id);
            return executor.execute(id, args, { ...context, actionsSettings });
        };
        const store = createHomeHubAccountStore({ accountId: scope.accountId, transport, isCurrent: () => true,
            execute: intent => executeHomeHubLayoutIntent({ intent, scope, transport, execute,
                onApprovalPending: createActionApprovalContinuationObserver({ onExecuted: () => {} }).requestApproval }) });
        await store.refresh();
        const previous = store.getSnapshot().layout;
        const intent = { kind: 'widget_size', instanceId: 'checks', size: 'tall' } as const;
        boundary.offline(true);
        await store.dispatch(intent);
        expect(store.getSnapshot()).toMatchObject({ status: 'error', failedIntent: intent, layout: previous });
        boundary.offline(false);
        await store.retry();
        expect(requests).toEqual(['widgets.item.size.set', 'widgets.item.size.set']);
        expect(store.getSnapshot()).toMatchObject({ status: 'ready', layout: { items: expect.arrayContaining([{ kind: 'widget', instance: expect.objectContaining({ id: 'checks' }), size: 'tall' }]) } });
        expect(store.getSnapshot().failedIntent).toBeUndefined();
        expect(store.getSnapshot().layout).toEqual(await owner.read());
    });
    it('changes a Home copy\u2019s network access through the universal network Action, not a Home layout update', async () => {
        const boundary = createWorkBoardArtifactBoundary({ v: 1, boards: [] });
        const scope = { serverId: 'home', accountId: 'one' };
        const transport = boundary.forAccount(scope.accountId);
        const owner = createHomeHubArtifactPortV1(transport, { accountId: scope.accountId });
        await owner.apply({ kind: 'widget_add', instance: { v: 1, id: 'status', definition: { kind: 'artifact', artifactId: 'status-page' }, bindings: {} } });
        const executor = createActionExecutor(createActionExecutorBoundaryFixture({ homeHubArtifacts: owner, widgetAccountScope: () => scope }));
        const requests: string[] = [];
        const settings = normalizeActionsSettingsV1({ v: 1, approvalWaivedSurfaces: { 'widgets.item.network.set': ['ui'] } });
        const execute: typeof executor.execute = (id, args, context) => {
            requests.push(id);
            return executor.execute(id, args, { ...context, actionsSettings: settings });
        };
        const store = createHomeHubAccountStore({ accountId: scope.accountId, transport, isCurrent: () => true,
            execute: intent => executeHomeHubLayoutIntent({ intent, scope, transport, execute,
                onApprovalPending: createActionApprovalContinuationObserver({ onExecuted: () => {} }).requestApproval }) });
        await store.refresh();
        await store.dispatch({ kind: 'network', instanceId: 'status', network: { networkOrigins: ['https://status.example.com'] } }, { rethrow: true });
        expect(requests).toEqual(['widgets.item.network.set']);
        const status = (await owner.read()).items.find(item => item.kind === 'widget' && item.instance.id === 'status');
        expect(status?.kind === 'widget' ? status.instance.networkOverride : null).toEqual({ networkOrigins: ['https://status.example.com'] });
        expect(store.getSnapshot().layout).toEqual(await owner.read());
    });
});
