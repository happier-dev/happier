import { describe, expect, it } from 'vitest';
import type { PluginActionInputById } from '@happier-dev/plugin-sdk/actions';
import { getActionSpec } from '@happier-dev/plugin-sdk/actions';
import { ensureTriagePullRequestCompanionV1 } from './sessionPullRequestPlacement.js';

const session = { serverId: 'home-a', sessionId: 'session-a' };
const scope = { serverId: session.serverId, accountId: 'viewer-a' };
const definition = { kind: 'installed', surface: { pluginId: 'happier.triage', localId: 'session-pull-request' } } as const;
const surface = { ...scope, owner: { kind: 'companion', sessionId: session.sessionId } } as const;
function boundary() {
    const calls: unknown[] = [];
    let instances: PluginActionInputById['widgets.item.add']['instance'][] = [];
    let available = true;
    const actions: Parameters<typeof ensureTriagePullRequestCompanionV1>[0] = {
        async execute(action, input) {
            calls.push({ action, input });
            // This is the external widget Action transport; production schema admission stays real.
            if (action === 'widgets.catalog.list') return getActionSpec(action).outputSchema.parse({ surface,
                entries: available ? [{ definition, availability: 'available', title: 'Pull request', fields: [], instanceCount: instances.length,
                    sizeDeclaration: { sizes: ['medium'], defaultSize: 'medium' }, presentation: { sizes: ['medium'], defaultSize: 'medium' } }] : [],
                presentation: { sizes: ['medium'], defaultSize: 'medium' } }) as never;
            if (action === 'widgets.item.list') return getActionSpec(action).outputSchema.parse({ surface,
                canEdit: true, instances: instances.map(instance => ({ instance })) }) as never;
            if (action === 'widgets.item.add') {
                const add = getActionSpec(action).inputSchema.parse(input) as PluginActionInputById['widgets.item.add'];
                instances = [add.instance];
                return getActionSpec(action).outputSchema.parse({ ref: { surface, instanceId: add.instance.id }, instance: add.instance }) as never;
            }
            throw new Error('Unexpected placement Action');
        },
    };
    return { actions, calls, remove() { instances = []; }, unavailable() { available = false; } };
}

describe('explicit-link Companion completion', () => {
    it('adds through the exact admitted Account and existing widget Actions, deduplicates, then permits the next link to restore removal', async () => {
        const h = boundary();
        expect(await ensureTriagePullRequestCompanionV1(h.actions, session, scope.accountId)).toBe('added');
        expect(h.calls).toContainEqual({ action: 'widgets.item.add', input: {
            surface: { ...scope, owner: { kind: 'companion', sessionId: session.sessionId } },
            instance: { v: 1, id: 'happier.triage:session-pull-request', definition,
                bindings: { session: { kind: 'value', value: session } } },
        } });
        expect(await ensureTriagePullRequestCompanionV1(h.actions, session, scope.accountId)).toBe('present');
        h.remove();
        // No mounted observer or retained callback exists: only another explicit completion invokes it.
        const afterRemoval = h.calls.length;
        await Promise.resolve();
        expect(h.calls).toHaveLength(afterRemoval);
        expect(await ensureTriagePullRequestCompanionV1(h.actions, session, scope.accountId)).toBe('added');
        expect(h.calls.filter(call => (call as { action: string }).action === 'widgets.item.add')).toHaveLength(2);
    });

    it('does not retain a late-ready add or dispatch after cancellation', async () => {
        const h = boundary();
        h.unavailable();
        expect(await ensureTriagePullRequestCompanionV1(h.actions, session, scope.accountId)).toBe('unavailable');
        expect(h.calls.map(call => (call as { action: string }).action)).toEqual(['widgets.catalog.list']);
        const controller = new AbortController(); controller.abort();
        await expect(ensureTriagePullRequestCompanionV1(h.actions, session, scope.accountId, { signal: controller.signal })).resolves.toBe('unavailable');
        expect(h.calls).toHaveLength(1);
    });

    it('does not mistake an approval or a foreign Widget receiver response for completed placement', async () => {
        for (const response of [
            { kind: 'approval_request_created', artifactId: 'approval-placement', actionId: 'widgets.item.add' },
            { surface: { ...surface, accountId: 'viewer-b' }, entries: [{ definition, availability: 'available',
                title: 'Pull request', fields: [], instanceCount: 0, sizeDeclaration: { sizes: ['medium'], defaultSize: 'medium' },
                presentation: { sizes: ['medium'], defaultSize: 'medium' } }], presentation: { sizes: ['medium'], defaultSize: 'medium' } },
            { surface: { ...surface, serverId: 'other-home' }, entries: [{ definition, availability: 'available',
                title: 'Pull request', fields: [], instanceCount: 0, sizeDeclaration: { sizes: ['medium'], defaultSize: 'medium' },
                presentation: { sizes: ['medium'], defaultSize: 'medium' } }], presentation: { sizes: ['medium'], defaultSize: 'medium' } },
        ]) {
            const calls: unknown[] = [];
            const actions: Parameters<typeof ensureTriagePullRequestCompanionV1>[0] = {
                async execute(action) { calls.push(action); return response as never; },
            };
            expect(await ensureTriagePullRequestCompanionV1(actions, session, scope.accountId)).toBe('unavailable');
            expect(calls).toEqual(['widgets.catalog.list']);
        }
    });
});
