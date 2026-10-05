import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { createStorageModuleStub } from '@/dev/testkit/mocks/storage';

/**
 * The persisted device-local settings slot is the only boundary mocked here: the
 * preference model, seeding rules and mutation outcomes below are the real
 * production logic every Companion entry point runs.
 */
const local = vi.hoisted(() => ({
    // The realm-qualified key the canonical resolver produces: Account, Home and Session.
    // Switching `accountId` is what a same-Home Account switch does to every write.
    accountId: 'account-a',
    byKey: {} as Record<string, unknown>,
    key: (sessionId: string | null, serverId?: string | null) => (
        sessionId && serverId ? `${local.accountId}:${serverId}:${sessionId}` : null
    ),
}));

vi.mock('@/sync/domains/state/storage', () =>
    createStorageModuleStub({
        useSessionCompanionPreferenceSlot: (sessionId: string | null, serverId?: string | null) => {
            const storageKey = local.key(sessionId, serverId);
            return { storageKey, stored: storageKey ? local.byKey[storageKey] : undefined };
        },
        useMutateSessionCompanionPreference: () => (
            sessionId: string,
            updater: (stored: unknown) => unknown,
            serverId?: string | null,
        ) => {
            const storageKey = local.key(sessionId, serverId);
            if (!storageKey) return false;
            const next = updater(local.byKey[storageKey]);
            if (next === null) return false;
            local.byKey[storageKey] = next;
            return true;
        },
    }),
);

import { useSessionCompanionController } from './useSessionCompanionController';

const SUMMARY = { kind: 'builtin', id: 'session_summary' };

async function mountController(serverId: string | null = 'home-a') {
    return await renderHook(() => useSessionCompanionController({
        sessionId: 'session-1',
        serverId,
        openFullSurface: () => {},
    }));
}

describe('useSessionCompanionController', () => {
    it('checks transfer removal against latest storage even before its mounted preference rerenders', async () => {
        const hook = await mountController();
        const controller = hook.getCurrent();
        const instance = { v: 1 as const, id: 'copy-a', definition: { kind: 'builtin' as const, id: 'session_summary' }, bindings: {} };
        const item = { kind: 'instance' as const, instance };
        controller.show();
        controller.addItem(item);
        const guard = { expectedInstance: instance, expectedPresentation: { frameStyle: null, nativeIndex: 1 } };
        controller.renameInstance(instance.id, 'New title');
        expect(controller.removeItem(item, guard)).toBeNull();
        expect(storedNow()).toMatchObject({ items: [SUMMARY, { instance: { displayName: 'New title' } }] });
        expect(controller.removeItem(item)).not.toBeNull();
        expect(storedNow()).toMatchObject({ items: [SUMMARY] });
    });
    it('persists and reverses an item frame override while retaining later changes to other items', async () => {
        const hook = await mountController();
        const controller = hook.getCurrent();
        controller.show();
        controller.addItem({ kind: 'builtin', id: 'agent_plan' });
        const summary = { kind: 'builtin' as const, id: 'session_summary' as const };
        const plan = { kind: 'builtin' as const, id: 'agent_plan' as const };
        const outcome = controller.setItemFrameStyle(summary, 'card');
        expect(outcome).not.toBeNull();
        controller.setItemFrameStyle(plan, 'plain');
        expect(controller.applyLocalInverse(outcome!)).toBe(true);
        expect(storedNow()).toMatchObject({ items: [summary, { ...plan, frameStyle: 'plain' }] });
        const reapplied = controller.setItemFrameStyle(summary, 'card');
        controller.setItemFrameStyle(summary, 'plain');
        expect(controller.applyLocalInverse(reapplied!)).toBe(false);
        controller.setItemFrameStyle(summary, null);
        expect(storedNow()).toMatchObject({ items: [summary, { ...plan, frameStyle: 'plain' }] });
    });
    beforeEach(() => {
        local.accountId = 'account-a';
        local.byKey = {};
    });

    const storedNow = (accountId = local.accountId) => local.byKey[`${accountId}:home-a:session-1`];

    it('seeds and persists the built-in Session Summary when the Companion is first revealed', async () => {
        const hook = await mountController();

        const outcome = hook.getCurrent().show();

        expect(outcome).not.toBeNull();
        expect(storedNow()).toMatchObject({ visible: true, items: [SUMMARY] });
        const current = await hook.rerender();
        expect(current.preference.visible).toBe(true);
        expect(current.preference.items).toEqual([SUMMARY]);
    });

    it('reveals an existing selection without seeding a second summary card', async () => {
        local.byKey['account-a:home-a:session-1'] = {
            v: 1,
            visible: false,
            collapsed: true,
            edge: 'trailing',
            density: 'compact',
            items: [{ kind: 'widget', widgetId: 'item-1' }],
        };
        const hook = await mountController();

        hook.getCurrent().show();

        const current = await hook.rerender();
        expect(current.preference.visible).toBe(true);
        expect(current.preference.collapsed).toBe(false);
        expect(current.preference.items).toEqual([{ kind: 'widget', widgetId: 'item-1' }]);
    });

    it('refuses a published inverse whose realm or mounted owner is gone', async () => {
        const hook = await mountController();
        const outcome = hook.getCurrent().show();
        expect(outcome).not.toBeNull();
        const publishedRealmKey = hook.getCurrent().realmKey;
        expect(publishedRealmKey).toBe('account-a:home-a:session-1');
        await hook.rerender();

        // Control: the same Account, same Home, unchanged field — the inverse still restores.
        const undoable = hook.getCurrent();
        expect(undoable.applyLocalInverse(outcome!, publishedRealmKey)).toBe(true);
        expect(storedNow()).toMatchObject({ visible: false });

        // An Account switch on the SAME Home keeps the realm resolvable, so the write key is
        // the NEXT Account's. The inverse published by the previous Account must not write it.
        const second = hook.getCurrent().show();
        expect(second).not.toBeNull();
        await hook.rerender();
        local.accountId = 'account-b';
        const afterSwitch = await hook.rerender();
        expect(afterSwitch.realmKey).toBe('account-b:home-a:session-1');
        expect(afterSwitch.applyLocalInverse(second!, publishedRealmKey)).toBe(false);
        expect(storedNow('account-b')).toBeUndefined();

        // A retired owner's inverse is inert too, with no Account switch at all.
        local.accountId = 'account-a';
        const beforeUnmount = await hook.rerender();
        await hook.unmount();
        expect(beforeUnmount.applyLocalInverse(second!, 'account-a:home-a:session-1')).toBe(false);
        expect(storedNow()).toMatchObject({ visible: true });
    });

    it('refuses to write when the exact Session realm cannot be proven', async () => {
        const hook = await mountController(null);

        expect(hook.getCurrent().availability).toBe('realm_unavailable');
        expect(hook.getCurrent().show()).toBeNull();
        expect(storedNow()).toBeUndefined();
    });
});
