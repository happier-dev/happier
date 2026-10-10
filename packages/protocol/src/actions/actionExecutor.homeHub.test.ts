import { describe, expect, it } from 'vitest';
import { createActionExecutor, type ActionExecutorDeps } from './actionExecutor.js';
import { getActionSpec } from './actionSpecs.js';
import { createHomeHubArtifactPortV1 } from '../home/homeHubArtifactV1.js';
import { createWorkBoardArtifactBoundary } from '../boards/workBoardArtifactV1.testkit.js';
import { createWidgetActionInputResolverV1 } from '../widgets/widgetActionInputResolverV1.js';
import { WidgetInstanceV1Schema } from '../widgets/widgetInstanceV1.js';

describe('Home layout Account Actions', () => {
    it.each([true, false])('preserves the issued Artifact acknowledgment after retirement (applied: %s)', async applied => {
        const boundary = createWorkBoardArtifactBoundary();
        const accountId = 'one';
        const transport = boundary.forAccount(accountId);
        await createHomeHubArtifactPortV1(transport, { accountId }).apply({ kind: 'visibility', sectionId: 'setup', hidden: true });
        let current = true;
        const port = createHomeHubArtifactPortV1({ ...transport, update: async input => {
            const result = applied ? await transport.update(input)
                : { ok: false as const, errorCode: 'artifact_account_mode_mismatch', error: 'artifact_account_mode_mismatch' };
            current = false;
            return result;
        } }, { accountId, shouldContinue: () => current, readWidgets: () => {
            if (!current) throw new Error('must not read another Account after the issued update');
            return [];
        } });
        const executor = createActionExecutor({ homeHubArtifacts: port } as unknown as ActionExecutorDeps);
        const result = await executor.execute('home.hub.layout.update', { intent: { kind: 'setup_visibility', stepId: 'addPhone', hidden: true } }, { surface: 'cli' });
        expect(result).toMatchObject(applied
            ? { ok: true, result: { layout: { hidden: expect.arrayContaining(['setup:addPhone']) }, hiddenSetupStepIds: ['addPhone'] } }
            : { ok: false, errorCode: 'artifact_account_mode_mismatch' });
        const persisted = await createHomeHubArtifactPortV1(transport, { accountId }).read();
        expect(persisted.hidden.includes('setup:addPhone')).toBe(applied);
    });

    it('admits agent and CLI Home edits through the same Artifact owner and preserves instance/layout/setup state on reload', async () => {
        const boundary = createWorkBoardArtifactBoundary();
        const accountId = 'one';
        const port = createHomeHubArtifactPortV1(boundary.forAccount(accountId), { accountId });
        const instance = WidgetInstanceV1Schema.parse({ v: 1, id: 'copy', definition: { kind: 'inline', definition: {
            v: 1, id: 'count', name: 'Count', sizeDeclaration: { sizes: ['medium', 'full'], defaultSize: 'medium' },
            inputs: { fields: [] }, inputSchema: { type: 'object', additionalProperties: false },
            provenance: { source: { kind: 'authored' } },
            body: { kind: 'declarative', document: { version: 1, root: { kind: 'text', text: 'Count' } } },
        } }, bindings: {} });
        const deps = { homeHubArtifacts: port, widgetAccountScope: () => ({ serverId: 'home', accountId }),
            widgetInputs: createWidgetActionInputResolverV1({
                readDescriptor: async request => request.instance.definition.kind === 'inline' ? request.instance.definition.definition : null,
                readContext: async () => ({}), readViewerValues: async () => ({ values: {} }),
                validateValue: async () => ({ status: 'valid' }), resolveOptions: async () => [],
            }),
        };
        const executor = createActionExecutor(deps as unknown as ActionExecutorDeps);
        expect(getActionSpec('home.hub.layout.update')).toMatchObject({ executionPlacement: 'account', surfaces: { cli: true, rpc: true } });
        const beforeAdd = await port.read();
        const unwired = createActionExecutor({ homeHubArtifacts: port });
        expect(await unwired.execute('home.hub.layout.update', { intent: { kind: 'widget_add', instance } }, { surface: 'cli' }))
            .toMatchObject({ ok: false, errorCode: 'widget_scope_unavailable' });
        expect(await port.read()).toEqual(beforeAdd);
        expect(await executor.execute('home.hub.layout.update', { intent: { kind: 'widget_add', instance } }, { surface: 'cli' })).toMatchObject({ ok: true });
        expect(await executor.execute('home.hub.layout.update', { intent: { kind: 'setup_visibility', stepId: 'addPhone', hidden: true } }, { surface: 'agent' })).toMatchObject({ ok: true });
        expect(await executor.execute('home.hub.layout.update', { intent: { kind: 'widget_size', instanceId: 'copy', size: 'full' } }, { surface: 'cli' })).toMatchObject({ ok: true });
        const otherClient = createActionExecutor({ ...deps,
            homeHubArtifacts: createHomeHubArtifactPortV1(boundary.forAccount(accountId), { accountId }),
        });
        expect(await otherClient.execute('home.hub.layout.get', {}, { surface: 'mcp' })).toMatchObject({ ok: true, result: {
            layout: { items: [{ kind: 'widget', instance, size: 'full' }] }, hiddenSetupStepIds: ['addPhone'],
            sections: expect.arrayContaining([{ kind: 'widget', id: 'copy', instance, size: 'full', hidden: false, hideable: true }]),
        } });
        expect(await executor.execute('home.hub.layout.update', { intent: { kind: 'visibility', sectionId: 'attention', hidden: true } }, { surface: 'cli' })).toMatchObject({ ok: true });
        expect((await port.read()).hidden).not.toContain('attention');
        const before = await port.read();
        expect(await executor.execute('home.hub.layout.update', { intent: { kind: 'reorder', sectionIds: ['copy'] } }, { surface: 'agent' })).toMatchObject({ ok: false, errorCode: 'home_hub_order_incomplete' });
        expect(await port.read()).toEqual(before);
        expect(await executor.execute('home.hub.layout.update', { intent: { kind: 'group_create', groupId: 'counts', instanceIds: ['copy'], title: 'Counts' } }, { surface: 'cli' }))
            .toMatchObject({ ok: true });
        expect(await otherClient.execute('home.hub.layout.get', {}, { surface: 'mcp' })).toMatchObject({ ok: true, result: {
            layout: { items: [{ kind: 'group', id: 'counts', children: [{ instance, size: 'full' }] }] },
            sections: expect.arrayContaining([expect.objectContaining({ kind: 'group', id: 'counts', children: [{ kind: 'widget', id: 'copy', instance, size: 'full', hidden: false, hideable: true, frameStyle: 'plain' }] })]),
        } });
    });
});
