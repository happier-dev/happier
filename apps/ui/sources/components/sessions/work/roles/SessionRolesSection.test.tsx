import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BUILT_IN_ROLES_V1 } from '@happier-dev/protocol';
import type { Metadata } from '@happier-dev/session-core/state';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

/** The Action front door is the boundary: every change is a `session.roles.*` / `session.notes.set` Action. */
const shared = vi.hoisted(() => ({
    calls: [] as Array<{ actionId: string; input: any }>,
    metadata: null as Partial<Metadata> | null,
    /** Writes the host refuses (a typed `{ ok: false }`), for the keep-the-draft contract. */
    refused: new Set<string>(),
    alerts: [] as unknown[][],
    platformOS: 'node',
}));

// The platform is a host boundary: keyboard-only reveal is a web contract.
vi.mock('react-native', async () => {
    const actual = await vi.importActual<typeof import('@/dev/reactNativeStub')>('@/dev/reactNativeStub');
    return { ...actual, Platform: { ...actual.Platform, get OS() { return shared.platformOS; } } };
});

// The modal host is the presentation boundary: a refused write is reported there.
vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({ spies: { alertAsync: async (...args) => { shared.alerts.push(args); } } }).module;
});

vi.mock('@/sync/ops/actions/frontDoorRuntimeActionExecutor', () => ({
    createFrontDoorActionExecute: () => async (actionId: string, input: unknown) => {
        shared.calls.push({ actionId, input });
        if (shared.refused.has(actionId)) return { ok: false, errorCode: 'action_failed', error: 'refused' };
        if (actionId === 'roles.list') {
            return { ok: true, result: { items: [
                { roleId: 'orchestrator', role: BUILT_IN_ROLES_V1.orchestrator, shared: false, viewOnly: false, migratedFromV0_2: false },
                { roleId: 'builder', role: BUILT_IN_ROLES_V1.builder, shared: false, viewOnly: false, migratedFromV0_2: false },
            ] } };
        }
        return { ok: true, result: { updated: true } };
    },
}));

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    // Counted copy keeps its count so a summary can be read back ("roles.session.countChanged:2").
    return createTextModuleMock({
        translate: (key: string, params?: Record<string, unknown>) => (
            params && 'count' in params ? `${key}:${String(params.count)}` : key
        ),
    });
});

vi.mock('@/sync/domains/state/storage', async (importOriginal) => {
    const { createPartialStorageModuleMock, createUseSettingMock } = await import('@/dev/testkit/mocks/storage');
    return createPartialStorageModuleMock(importOriginal, {
        useSetting: createUseSettingMock({
            fallback: (key: string) => {
                if (key === 'rolesV1') return { overrides: {} };
                if (key === 'acpCatalogSettingsV1') return { v: 2, backends: [] };
                if (key === 'backendEnabledByTargetKey') return {};
                return undefined;
            },
        }),
        useSessionMetadata: () => shared.metadata ? { path: '/repo', host: 'test-machine', ...shared.metadata } : null,
    });
});

installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();
const { SessionRolesSection } = await import('./SessionRolesSection');
const { SessionNotesSection } = await import('./SessionNotesSection');
const { SessionWorkMoreMenu } = await import('../SessionWorkMoreMenu');
const { SessionHandsOffRow } = await import('@/components/roles/session/sessionRole');
const { invalidateRoleCatalog } = await import('@/components/roles/catalog/useRoleCatalog');

/** The composite that declared a testID (not the host it painted), for reading its declared props. */
function declared(screen: { findAll: (predicate: (node: any) => boolean) => any[] }, testID: string, prop: string) {
    return screen.findAll((node: any) => node.props?.testID === testID && node.props?.[prop] !== undefined)[0] ?? null;
}

function writes() {
    return shared.calls.filter((call) => call.actionId !== 'roles.list');
}

const researchRole = {
    roleId: 'session:research',
    name: 'Research',
    instructions: 'Read and report.',
    runsAs: { kind: 'background_run', intent: 'task' },
    workspaceWrites: 'deny',
    secondOpinion: 'off',
    enabled: true,
};

describe('Work › Roles and Notes', () => {
    let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;
    beforeEach(async () => {
        connection = await restoreServerAccountForTest({
            serverUrl: 'https://session-roles.test', accountId: 'account-1',
            request: async (url) => {
                const path = new URL(String(url)).pathname;
                if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
                if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
                if (path === '/v2/account/settings') return Response.json({ content: null, version: 0 });
                return Response.json({}, { status: 404 });
            },
        });
        const { storage } = await import('@/sync/domains/state/storage');
        storage.getState().activateProfileScope({ serverId: connection.home.id, accountId: 'account-1' });
        shared.calls = [];
        shared.refused = new Set();
        shared.alerts = [];
        shared.platformOS = 'node';
        shared.metadata = {
            work: {
                sessionRolesV1: {
                    roleId: 'orchestrator',
                    overrides: {
                        builder: { roleId: 'builder', engine: { agentTargetKey: 'agent:codex' } },
                        orchestrator: { roleId: 'orchestrator', workspaceWrites: 'deny' },
                    },
                    sessionRoles: { 'session:research': researchRole },
                    notes: 'Keep the ledger backfill inside the API session.',
                },
            },
        };
        invalidateRoleCatalog();
    });
    afterEach(async () => {
        await standardCleanup();
        await connection?.dispose();
        connection = undefined;
    });

    it('shows only this session\'s differences on the flat page section, then All roles', async () => {
        const screen = await renderScreen(<SessionRolesSection sessionId="lead" />);
        const rowIds = screen.findAll((node: any) => typeof node.type === 'string'
            && typeof node.props?.testID === 'string'
            && /^session-work-roles\.row\.[^.]+$/u.test(node.props.testID))
            .map((node: any) => node.props.testID);
        expect([...new Set(rowIds)]).toEqual([
            'session-work-roles.row.builder',
            'session-work-roles.row.orchestrator',
            'session-work-roles.row.session:research',
        ]);
        // Page anatomy: the header summarises the differences and explains the scope behind ⓘ.
        const count = screen.findByTestId('session-agents-section-count:session-work-roles')!;
        expect(count.props.children).toBe('roles.session.countChanged:2 · roles.session.countAdded:1');
        expect(screen.findByTestId('session-work-roles-info')).toBeTruthy();
        // "All roles" is the trailing row: the enabled catalog roles plus the session-only ones.
        expect(declared(screen, 'session-work-roles.all', 'detail')!.props.detail).toBe('roles.session.inUse:3');
        // The inline add form and the bulk actions are no longer in the section.
        expect(screen.findByTestId('session-work-roles.addForm')).toBeNull();
        expect(screen.findByTestId('session-work-roles.useDefaults')).toBeNull();
    });

    it('summarises only what exists: no changes means no count and just All roles', async () => {
        shared.metadata = { work: { sessionRolesV1: { roleId: 'orchestrator', overrides: {}, sessionRoles: {}, notes: '' } } };
        const screen = await renderScreen(<SessionRolesSection sessionId="lead" />);
        expect(screen.findByTestId('session-agents-section-count:session-work-roles')).toBeNull();
        expect(screen.findByTestId('session-work-roles.row.builder')).toBeNull();
        expect(declared(screen, 'session-work-roles.all', 'detail')!.props.detail).toBe('roles.session.inUse:2');
    });

    it('offers Use defaults and Apply to sessions under it from the Work ⋯ menu', async () => {
        const screen = await renderScreen(<SessionWorkMoreMenu sessionId="lead" hasReports />);
        const menu = declared(screen, 'session-work-more.menu', 'items')!;
        expect(menu.props.items.map((item: { id: string }) => item.id)).toEqual(['roles.useDefaults', 'roles.applyToReports']);
        await act(async () => { await menu.props.onSelect('roles.useDefaults'); });
        expect(writes()).toEqual([
            { actionId: 'session.roles.override.clear', input: { sessionId: 'lead', roleId: 'builder' } },
            { actionId: 'session.roles.override.clear', input: { sessionId: 'lead', roleId: 'orchestrator' } },
            { actionId: 'session.roles.remove', input: { sessionId: 'lead', roleId: 'session:research' } },
        ]);
    });

    it('has no ⋯ menu when there is nothing to reset and no sessions under it', async () => {
        shared.metadata = { work: { sessionRolesV1: { roleId: 'orchestrator', overrides: {}, sessionRoles: {}, notes: '' } } };
        const screen = await renderScreen(<SessionWorkMoreMenu sessionId="lead" hasReports={false} />);
        expect(screen.findByTestId('session-work-more.menu')).toBeNull();
    });

    it('resets a changed role back to its Settings default', async () => {
        const screen = await renderScreen(<SessionRolesSection sessionId="lead" />);
        const row = screen.findByTestId('session-work-roles.row.builder')!;
        await act(async () => { row.props.onHoverIn?.(); });
        await act(async () => { screen.findByTestId('session-work-roles.row.builder.reset')!.props.onPress(); });
        expect(writes()).toEqual([{ actionId: 'session.roles.override.clear', input: { sessionId: 'lead', roleId: 'builder' } }]);
    });

    it('lets the user relax hands-off from the Role popover through the override Action', async () => {
        const screen = await renderScreen(<SessionHandsOffRow sessionId="lead" roleId="orchestrator" />);
        const toggle = screen.findByTestId('session-role.handsOff')!
            .findAll((node: any) => typeof node.props?.onValueChange === 'function')[0]!;
        expect(toggle.props.value).toBe(true);
        await act(async () => { await toggle.props.onValueChange(false); });
        expect(writes()).toEqual([{
            actionId: 'session.roles.override.set',
            input: { sessionId: 'lead', roleId: 'orchestrator', workspaceWrites: 'allow' },
        }]);
    });

    it('clamps the notes to three lines and offers More only when they overflow', async () => {
        const screen = await renderScreen(<SessionNotesSection sessionId="lead" />);
        const layout = (testID: string, height: number) => screen.findByTestId(testID)!.props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: 300, height } } });
        expect(screen.findByTestId('session-work-notes.text')!.props.numberOfLines).toBe(3);
        await act(async () => { layout('session-work-notes.text', 60); layout('session-work-notes.measure', 60); });
        expect(screen.findByTestId('session-work-notes.more')).toBeNull();
        await act(async () => { layout('session-work-notes.measure', 100); });
        await act(async () => { screen.findByTestId('session-work-notes.more')!.props.onPress(); });
        expect(screen.findByTestId('session-work-notes.text')!.props.numberOfLines).toBeUndefined();
        expect(screen.findByTestId('session-work-notes.more')).toBeNull();
    });

    it('edits the notes with ✎ and saves them through session.notes.set', async () => {
        const screen = await renderScreen(<SessionNotesSection sessionId="lead" />);
        await act(async () => { screen.findByTestId('session-work-notes.edit')!.props.onPress(); });
        await act(async () => { screen.findByTestId('session-work-notes.field')!.props.onChangeText('Run searches as background runs.'); });
        await act(async () => { screen.findByTestId('session-work-notes.save')!.props.onPress(); });
        expect(writes()).toEqual([{
            actionId: 'session.notes.set',
            input: { sessionId: 'lead', notes: 'Run searches as background runs.' },
        }]);
    });

    it('shows one row that starts the notes when there are none', async () => {
        shared.metadata = { work: { sessionRolesV1: { roleId: 'orchestrator', overrides: {}, sessionRoles: {}, notes: '' } } };
        const screen = await renderScreen(<SessionNotesSection sessionId="lead" />);
        expect(screen.findByTestId('session-work-notes.text')).toBeNull();
        await act(async () => { screen.findByTestId('session-work-notes.add')!.props.onPress(); });
        expect(screen.findByTestId('session-work-notes.field')).toBeTruthy();
    });

    it('reveals a changed role\'s Reset on keyboard focus, without hover (web)', async () => {
        shared.platformOS = 'web';
        const screen = await renderScreen(<SessionRolesSection sessionId="lead" />);
        const slot = () => screen.findByTestId('session-work-roles.row.builder.resetSlot')!;
        const pointerEvents = () => [slot().props.style].flat(Infinity)
            .reduce((value: unknown, style: any) => style?.pointerEvents ?? value, undefined);
        // Reset is in the tree (so Tab reaches it) but not shown until the row is hovered or focused.
        expect(screen.findByTestId('session-work-roles.row.builder.reset')).toBeTruthy();
        expect(pointerEvents()).toBe('none');
        expect(screen.findByTestId('session-work-roles.row.builder.marker')).toBeTruthy();
        await act(async () => { slot().props.onFocus(); });
        expect(pointerEvents()).toBe('auto');
        expect(screen.findByTestId('session-work-roles.row.builder.marker')).toBeNull();
        await act(async () => { screen.findByTestId('session-work-roles.row.builder.reset')!.props.onPress(); });
        expect(writes()).toEqual([{ actionId: 'session.roles.override.clear', input: { sessionId: 'lead', roleId: 'builder' } }]);
    });

    it('keeps the notes editor and the draft open when the save is refused', async () => {
        shared.refused.add('session.notes.set');
        const screen = await renderScreen(<SessionNotesSection sessionId="lead" />);
        await act(async () => { screen.findByTestId('session-work-notes.edit')!.props.onPress(); });
        await act(async () => { screen.findByTestId('session-work-notes.field')!.props.onChangeText('Draft the user typed.'); });
        await act(async () => { await screen.findByTestId('session-work-notes.save')!.props.onPress(); });
        await vi.waitFor(() => expect(shared.alerts).toHaveLength(1));
        expect(screen.findByTestId('session-work-notes.field')!.props.value).toBe('Draft the user typed.');
        // Retrying after the host accepts closes the editor.
        shared.refused.clear();
        await act(async () => { await screen.findByTestId('session-work-notes.save')!.props.onPress(); });
        await vi.waitFor(() => expect(screen.findByTestId('session-work-notes.field')).toBeNull());
    });

    it('keeps the new-role form and what was typed when adding the role is refused', async () => {
        shared.refused.add('session.roles.add');
        const screen = await renderScreen(<SessionRolesSection sessionId="lead" />);
        await act(async () => { screen.findByTestId('session-work-roles.add')!.props.onPress(); });
        await act(async () => { screen.findByTestId('session-work-roles.add.new')!.props.onPress(); });
        await act(async () => { screen.findByTestId('session-work-roles.addForm.name')!.props.onChangeText('Reviewer'); });
        await act(async () => { await screen.findByTestId('session-work-roles.addForm.submit')!.props.onPress(); });
        await vi.waitFor(() => expect(shared.alerts).toHaveLength(1));
        expect(writes().map((call) => call.actionId)).toEqual(['session.roles.add']);
        expect(screen.findByTestId('session-work-roles.addForm.name')!.props.value).toBe('Reviewer');
    });

    it('keeps a cross-owner worker\'s copied roles and notes read-only', async () => {
        const roles = await renderScreen(<SessionRolesSection sessionId="worker" copiedAtSpawn />);
        expect(declared(roles, 'session-work-roles.all', 'onPress')).toBeNull();
        expect(roles.findByTestId('session-work-roles.add')).toBeNull();
        const notes = await renderScreen(<SessionNotesSection sessionId="worker" copiedAtSpawn />);
        expect(notes.findByTestId('session-work-notes.edit')).toBeNull();
    });

    it('withdraws an open notes editor when copied ownership becomes known', async () => {
        const notes = await renderScreen(<SessionNotesSection sessionId="worker" />);
        await act(async () => { notes.findByTestId('session-work-notes.edit')!.props.onPress(); });
        expect(notes.findByTestId('session-work-notes.field')).toBeTruthy();
        await act(async () => { notes.update(<SessionNotesSection sessionId="worker" copiedAtSpawn />); });
        expect(notes.findByTestId('session-work-notes.field')).toBeNull();
        expect(notes.findByTestId('session-work-notes.save')).toBeNull();
        expect(writes()).toEqual([]);
    });
});
