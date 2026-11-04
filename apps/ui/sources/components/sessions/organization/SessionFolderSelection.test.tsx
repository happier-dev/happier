import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createStore } from 'zustand/vanilla';
import { flushHookEffects, renderHook, renderScreen } from '@/dev/testkit';
import { Modal, ModalProvider } from '@/modal';
import type { SectionAddress, SessionSection } from '@/sync/domains/session/organization/sections';
import { openSessionFolderSelection } from './SessionFolderSelection';
import { buildSessionSectionMoveMenuItems } from './sessionSectionMoveMenu';
import { registerStorageStateReader, registerStorageStateSubscribe } from '@/sync/domains/state/storageStateReaderBridge';
import type { StorageState } from '@/sync/store/types';
import type { ProjectAccountRowsSnapshot } from '@/sync/domains/workspaces/projectAccountRows';
import { readSessionSectionChoiceLabels, useSessionSectionChoiceLabels } from '@/sync/domains/session/organization/useSessionSectionChoiceLabels';

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({ renderCustomModals: true }).module;
});

const sections: readonly SessionSection[] = [
    { address: { serverId: 'home', sectionId: 'id:with:separators' }, display: { status: 'available', value: { name: 'Planning', icon: null } }, sortKey: 'a0' },
    { address: { serverId: 'other-home', sectionId: 'foreign' }, display: { status: 'available', value: { name: 'Foreign', icon: null } }, sortKey: 'a0' },
    { address: { serverId: 'home', sectionId: 'locked' }, display: { status: 'locked', reason: 'content_unreadable' }, sortKey: null },
];

afterEach(() => {
    registerStorageStateReader(() => ({ projectAccountRows: null }) as unknown as StorageState);
    registerStorageStateSubscribe(() => () => {});
});

describe('qualified Session Section selection', () => {
    it('names the current unreadable Section without substituting a foreign Home name or offering it as a move destination', async () => {
        const scopedSections: readonly SessionSection[] = [sections[0]!, sections[2]!, {
            address: { serverId: 'other-home', sectionId: 'locked' }, sortKey: null,
            display: { status: 'available', value: { name: 'Foreign private name', icon: null } },
        }];
        const hook = await renderHook(() => useSessionSectionChoiceLabels(scopedSections, 'home', 'Unavailable'));
        expect(hook.getCurrent().get('locked')).toBe('Unavailable section');
        expect(readSessionSectionChoiceLabels(scopedSections, 'home', 'Unavailable').get('locked')).toBe('Unavailable section');
        expect(hook.getCurrent().get('id:with:separators')).toBe('Planning');
        expect(buildSessionSectionMoveMenuItems({ serverId: 'home', sections: scopedSections,
            currentSectionIds: ['locked'], projectTitle: null, canCreate: false }).map(item => item.title))
            .not.toContain('Foreign private name');
        expect(buildSessionSectionMoveMenuItems({ serverId: 'home', sections: scopedSections,
            currentSectionIds: ['locked'], projectTitle: null, canCreate: false }).map(item => item.id))
            .not.toContain('session.section.move:section:locked');
        await hook.unmount();
    });

    it('uses held Project titles for duplicate Section names in both the chooser and list menu without caller display props', async () => {
        const scope = { serverId: 'home', accountId: 'account' };
        let projectPathReads = 0;
        const rows: ProjectAccountRowsSnapshot = { scope, status: 'ready', coverage: 'complete',
            workspaceRefs: [
                { id: 'sales-base', serverId: 'home', projectKey: 'sales', machineId: 'machine',
                    get rootPath() { projectPathReads += 1; return '/sales'; }, createdAtMs: 1 },
                { id: 'sales-other', serverId: 'home', projectKey: 'sales', machineId: 'machine', rootPath: '/worktree', createdAtMs: 2 },
                { id: 'payments', serverId: 'home', projectKey: 'payments', machineId: 'machine', rootPath: '/payments', label: 'Payments', createdAtMs: 1 },
                { id: 'sales-other', serverId: 'foreign-home', projectKey: 'foreign', machineId: 'machine', rootPath: '/private-foreign', createdAtMs: 1 },
            ], organizations: [{ key: { kind: 'project-organization', serverId: 'home', projectKey: 'sales' },
                revision: 1, value: { label: 'Sales' } }], relationships: [], revisionsByPhysicalKey: {} };
        const storage = createStore<{ profileScope: typeof scope; projectAccountRows: ProjectAccountRowsSnapshot }>()(() => ({
            profileScope: scope, projectAccountRows: rows,
        }));
        // Genuine held-state boundary: keep the real Account admission, Project and label projections.
        registerStorageStateReader(() => storage.getState() as unknown as StorageState);
        registerStorageStateSubscribe(listener => storage.subscribe((state, previous) => listener(
            state as unknown as StorageState, previous as unknown as StorageState,
        )));
        const duplicateSections: readonly SessionSection[] = ['sales-other', 'payments'].map((id) => ({
            address: { serverId: 'home', sectionId: id }, sortKey: null,
            display: { status: 'available', value: { name: 'Leads', icon: null } },
            legacyContext: { ancestors: [], workspace: { t: 'workspaceRef', serverId: 'home', workspaceRefId: id } },
        }));
        const screen = await renderScreen(<ModalProvider children={null} />);
        let selection!: Promise<SectionAddress | null | undefined>;
        await act(async () => { selection = openSessionFolderSelection({ sourceLabel: 'Session', serverId: 'home',
            sections: duplicateSections, value: null }); });
        const menuTitles = () => buildSessionSectionMoveMenuItems({ serverId: 'home', sections: duplicateSections,
            currentSectionIds: [null], projectTitle: null, canCreate: false }).slice(0, 2).map(item => item.title);
        expect(screen.getTextContent()).toContain('Leads — Sales');
        expect(screen.getTextContent()).toContain('Leads — Payments');
        expect(menuTitles()).toEqual(['Leads — Sales', 'Leads — Payments']);
        projectPathReads = 0;
        await act(async () => storage.setState({ projectAccountRows: { ...rows, relationships: [] } }));
        // An unrelated Project publication must not revisit even the held title candidates.
        expect(projectPathReads).toBe(0);
        await act(async () => storage.setState({ projectAccountRows: { ...rows, organizations: [
            { ...rows.organizations[0]!, revision: 2, value: { label: 'Sales renamed' } },
        ] } }));
        expect(screen.getTextContent()).toContain('Leads — Sales renamed');
        expect(menuTitles()).toEqual(['Leads — Sales renamed', 'Leads — Payments']);
        await act(async () => storage.setState({ profileScope: { ...scope, accountId: 'other-account' } }));
        expect(screen.getTextContent()).not.toContain('Sales renamed');
        expect(screen.getTextContent()).not.toContain('Payments');
        expect(menuTitles()).toEqual(['Leads — Unavailable', 'Leads — Unavailable']);
        await act(async () => { vi.mocked(Modal.show).mock.calls.at(-1)?.[0]?.onRequestClose?.(); });
        await expect(selection).resolves.toBeUndefined();
        await screen.unmount();
    });

    it.each(['project', 'section:id:with:separators'])('returns the canonical %s target through the mounted shared list', async (choice) => {
        const screen = await renderScreen(<ModalProvider children={null} />);
        let selection!: Promise<SectionAddress | null | undefined>;
        await act(async () => {
            selection = openSessionFolderSelection({ sourceLabel: 'Two sessions', serverId: 'home', sections,
                value: { serverId: 'home', sectionId: 'old' } });
        });
        expect(screen.getTextContent()).not.toContain('Foreign');
        expect(screen.findByTestId('session-folder-selection:root:option:session.section.move:section:locked')).toBeNull();
        await screen.pressByTestIdAsync(`session-folder-selection:root:option:session.section.move:${choice}`);
        await expect(selection).resolves.toEqual(choice === 'project' ? null : sections[0]!.address);
        expect(screen.findByTestId('session-folder-selection')).toBeNull();
        await screen.unmount();
    });

    it('disables unavailable actions and distinguishes cancellation from Back to project', async () => {
        const screen = await renderScreen(<ModalProvider children={null} />);
        let selection!: Promise<SectionAddress | null | undefined>;
        let resolved = false;
        await act(async () => {
            selection = openSessionFolderSelection({ sourceLabel: 'One session', serverId: 'home', sections,
                value: null, disabledReason: 'Unavailable' });
            void selection.then(() => { resolved = true; });
        });
        expect(screen.findByTestId('session-folder-selection:root:option:session.section.move:section:id:with:separators')?.props.disabled).toBe(true);
        await screen.pressByTestIdAsync('session-folder-selection:root:option:session.section.move:section:id:with:separators');
        expect(resolved).toBe(false);
        const config = vi.mocked(Modal.show).mock.calls.at(-1)?.[0];
        await act(async () => { config?.onRequestClose?.(); });
        await expect(selection).resolves.toBeUndefined();
        expect(screen.findByTestId('session-folder-selection')).toBeNull();
        await screen.unmount();
    });

    it('creates a qualified first Section with no existing choices', async () => {
        const screen = await renderScreen(<ModalProvider children={null} />);
        const address = { serverId: 'home', sectionId: 'first' };
        let selection!: Promise<SectionAddress | null | undefined>;
        await act(async () => { selection = openSessionFolderSelection({ sourceLabel: 'One session',
            serverId: 'home', sections: [], value: null, onCreate: async () => address }); });
        await screen.pressByTestIdAsync('session-folder-selection:root:option:session.section.move:new');
        await expect(selection).resolves.toEqual(address);
        await screen.unmount();
    });

    it('refuses a foreign Home returned by creation instead of stripping its qualification', async () => {
        const screen = await renderScreen(<ModalProvider children={null} />);
        let selection!: Promise<SectionAddress | null | undefined>;
        let resolved = false;
        await act(async () => {
            selection = openSessionFolderSelection({ sourceLabel: 'One session', serverId: 'home', sections,
                value: null, onCreate: async () => ({ serverId: 'other-home', sectionId: 'id:with:separators' }) });
            void selection.then(() => { resolved = true; });
        });
        await screen.pressByTestIdAsync('session-folder-selection:root:option:session.section.move:new');
        await flushHookEffects({ cycles: 2 });
        expect(resolved).toBe(false);
        const config = vi.mocked(Modal.show).mock.calls.at(-1)?.[0];
        await act(async () => { config?.onRequestClose?.(); });
        await expect(selection).resolves.toBeUndefined();
        await screen.unmount();
    });
});
