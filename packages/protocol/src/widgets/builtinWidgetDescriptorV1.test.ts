import { describe, expect, it } from 'vitest';
import { readBuiltinWidgetDescriptorV1, SESSION_COMPANION_BUILTIN_ITEM_IDS } from './builtinWidgetDescriptorV1.js';
import { resolveConfiguredWidgetInputs } from './widgetInputAdmissionV1.js';

describe('native widget target contracts', () => {
    it('admits Project bodies with an exact checkout without requiring a saved Source or Session', () => {
        const checkout = { serverId: 'home', id: 'checkout', machineId: 'machine', rootPath: '/repo', createdAtMs: 0 };
        for (const id of ['project_about', 'project_code', 'project_readme', 'project_checkouts', 'project_scripts', 'project_sessions', 'project_changes']) {
            const descriptor = readBuiltinWidgetDescriptorV1({ kind: 'builtin', id });
            expect(descriptor).toMatchObject({ target: 'app', workspaceInputPath: 'checkout' });
            expect(resolveConfiguredWidgetInputs({ descriptor: descriptor!, instance: {
                v: 1, id: 'copy', definition: { kind: 'builtin', id }, bindings: { checkout: { kind: 'context', slot: 'checkout' } },
            }, providedContext: { checkout: [checkout], project: [] }, viewerValues: {} })).toEqual({ status: 'ready', input: { checkout } });
        }
    });

    it('refuses incomplete checkout inputs and preserves the Session-only native contracts', () => {
        const descriptor = readBuiltinWidgetDescriptorV1({ kind: 'builtin', id: 'project_code' });
        expect(descriptor).not.toBeNull();
        expect(resolveConfiguredWidgetInputs({ descriptor: descriptor!, instance: {
            v: 1, id: 'copy', definition: { kind: 'builtin', id: 'project_code' }, bindings: { checkout: { kind: 'value', value: { rootPath: '/repo' } } },
        }, providedContext: {}, viewerValues: {} }).status).toBe('invalid');
        for (const id of SESSION_COMPANION_BUILTIN_ITEM_IDS) expect(readBuiltinWidgetDescriptorV1({ kind: 'builtin', id }))
            .toMatchObject({ target: 'session', sessionInputPath: 'session' });
    });

    it('admits a pinned real WorkspaceRef with additive Project facts, without making them checkout authority', () => {
        const checkout = { id: 'checkout', serverId: 'home', machineId: 'machine', rootPath: '/repo', createdAtMs: 1,
            projectKey: 'stable-project', label: 'My checkout', source: { sourceId: 'source', revision: 2 } };
        const descriptor = readBuiltinWidgetDescriptorV1({ kind: 'builtin', id: 'project_code' });
        expect(resolveConfiguredWidgetInputs({ descriptor: descriptor!, instance: {
            v: 1, id: 'copy', definition: { kind: 'builtin', id: 'project_code' }, bindings: { checkout: { kind: 'value', value: checkout } },
        }, providedContext: {}, viewerValues: {} })).toEqual({ status: 'ready', input: { checkout } });
    });
});
