import { describe, expect, it } from 'vitest';
import { createActionExecutor, type ActionExecutorDeps } from './actionExecutor.js';
import { getActionSpec } from './actionSpecs.js';
import { createHomeHubArtifactPortV1 } from '../home/homeHubArtifactV1.js';
import { createWorkBoardArtifactBoundary } from '../boards/workBoardArtifactV1.testkit.js';

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
        const executor = createActionExecutor({ homeHubArtifacts: port } as unknown as ActionExecutorDeps);
        expect(getActionSpec('home.hub.layout.update')).toMatchObject({ executionPlacement: 'account', surfaces: { cli: true, rpc: true } });
        const instance = { v: 1, id: 'copy', definition: { kind: 'builtin', id: 'count' }, bindings: {} };
        expect(await executor.execute('home.hub.layout.update', { intent: { kind: 'widget_add', instance } }, { surface: 'cli' })).toMatchObject({ ok: true });
        expect(await executor.execute('home.hub.layout.update', { intent: { kind: 'setup_visibility', stepId: 'addPhone', hidden: true } }, { surface: 'agent' })).toMatchObject({ ok: true });
        expect(await executor.execute('home.hub.layout.update', { intent: { kind: 'widget_width', instanceId: 'copy', width: 'full' } }, { surface: 'cli' })).toMatchObject({ ok: true });
        const otherClient = createActionExecutor({ homeHubArtifacts: port } as unknown as ActionExecutorDeps);
        expect(await otherClient.execute('home.hub.layout.get', {}, { surface: 'mcp' })).toMatchObject({ ok: true, result: {
            layout: { instances: [instance], sections: { copy: { width: 'full' } } }, hiddenSetupStepIds: ['addPhone'],
            sections: expect.arrayContaining([{ kind: 'widget', id: 'copy', instance, width: 'full', hidden: false, hideable: true }]),
        } });
        expect(await executor.execute('home.hub.layout.update', { intent: { kind: 'visibility', sectionId: 'attention', hidden: true } }, { surface: 'cli' })).toMatchObject({ ok: true });
        expect((await port.read()).hidden).not.toContain('attention');
        const before = await port.read();
        expect(await executor.execute('home.hub.layout.update', { intent: { kind: 'reorder', sectionIds: ['copy'] } }, { surface: 'agent' })).toMatchObject({ ok: false, errorCode: 'home_hub_order_incomplete' });
        expect(await port.read()).toEqual(before);
    });
});
