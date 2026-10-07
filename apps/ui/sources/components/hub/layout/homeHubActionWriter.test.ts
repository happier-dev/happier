import { describe, expect, it } from 'vitest';
import { ActionsSettingsV1Schema, createActionExecutor } from '@happier-dev/protocol';
import { createHomeHubArtifactPortV1 } from '@happier-dev/protocol/home';
import { createWidgetActionInputResolverV1 } from '@happier-dev/protocol/widgets';
import { createWorkBoardArtifactBoundary } from '@/dev/testkit/harness/workBoardArtifactBoundary';
import { createActionExecutorBoundaryFixture } from '@/dev/testkit/fixtures/actionExecutorBoundary';
import { createHomeHubAccountStore } from './homeHubAccountStore';
import { executeHomeHubLayoutIntent } from './homeHubActionWriter';
import { readPresentationNotice, retirePresentationNotice } from '@/components/sessions/presentation/presentationNotices';

describe('Home mounted size Action adapter', () => {
    it('keeps the committed size and reports approval pending instead of acknowledging the requested size', async () => {
        retirePresentationNotice();
        const scope = { serverId: 'home', accountId: 'one' };
        const transport = createWorkBoardArtifactBoundary({ v: 1, boards: [] }).forAccount(scope.accountId);
        const owner = createHomeHubArtifactPortV1(transport, { accountId: scope.accountId });
        await owner.apply({ kind: 'widget_add', instance: { v: 1, id: 'checks', definition: { kind: 'installed',
            surface: { pluginId: 'acme.checks', localId: 'summary' } }, bindings: {} } });
        const previous = await owner.read();
        const executor = createActionExecutor(createActionExecutorBoundaryFixture({ homeHubArtifacts: owner, widgetAccountScope: () => scope,
            widgetInputs: createWidgetActionInputResolverV1({ readDescriptor: async () => ({
                sizeDeclaration: { sizes: ['medium', 'tall'], defaultSize: 'medium' }, inputs: { fields: [] },
                inputSchema: { type: 'object', additionalProperties: false } }), readContext: async () => ({}),
                readViewerValues: async () => ({ values: {} }), validateValue: async () => ({ status: 'valid' }), resolveOptions: async () => [] }),
            // Approval persistence is a genuine transport boundary; no domain owner is replaced.
            approvalsCreate: async () => ({ artifactId: 'size-approval' }),
        }));
        // The mounted default executor enriches context with the Account's Actions policy.
        // Supply that same public context here; the real shared policy decides approval.
        const actionsSettings = ActionsSettingsV1Schema.parse({ v: 1, actions: {
            'widgets.instance.size.set': { approvalRequiredSurfaces: ['ui'] },
        } });
        const execute: typeof executor.execute = (id, args, context) => executor.execute(id, args, {
            ...context, actionsSettings, runtimeAccountId: scope.accountId, serverIdentityId: 'srv_home', actionRequestId: 'size-approval-request',
        });
        const layout = await executeHomeHubLayoutIntent({ scope, transport, execute,
            intent: { kind: 'widget_size', instanceId: 'checks', size: 'tall' } });
        expect(layout).toEqual(previous);
        expect(await owner.read()).toEqual(previous);
        expect(readPresentationNotice()).toMatchObject({ severity: 'info' });
        retirePresentationNotice();
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
            return executor.execute(id, args, context);
        };
        const store = createHomeHubAccountStore({ accountId: scope.accountId, transport, isCurrent: () => true,
            execute: intent => executeHomeHubLayoutIntent({ intent, scope, transport, execute }) });
        await store.refresh();
        const previous = store.getSnapshot().layout;
        const intent = { kind: 'widget_size', instanceId: 'checks', size: 'tall' } as const;
        boundary.offline(true);
        await store.dispatch(intent);
        expect(store.getSnapshot()).toMatchObject({ status: 'error', failedIntent: intent, layout: previous });
        boundary.offline(false);
        await store.retry();
        expect(requests).toEqual(['widgets.instance.size.set', 'widgets.instance.size.set']);
        expect(store.getSnapshot()).toMatchObject({ status: 'ready', layout: { sections: { checks: { size: 'tall' } } } });
        expect(store.getSnapshot().failedIntent).toBeUndefined();
        expect(store.getSnapshot().layout).toEqual(await owner.read());
    });
});
