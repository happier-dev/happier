import { initializeAuthRouteRuntimeForTests } from '@/dev/testkit/harness/authRouteRuntimeHarness';
import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen as renderWithoutAuth } from '@/dev/testkit';
import { InjectedAuthProvider } from '@/auth/context/AuthContext';


(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const promptStacksRouterPushSpy = vi.hoisted(() => vi.fn());
async function renderScreen(element: React.ReactElement) {
    return renderWithoutAuth(<InjectedAuthProvider credentials={null}>{element}</InjectedAuthProvider>);
}
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({ View: 'View', ScrollView: 'ScrollView', Switch: 'Switch' });
});
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({ router: { push: promptStacksRouterPushSpy } }).module;
});
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock({ translate: key => key }));
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);
// Replace the portal/window boundary, leaving row actions and menu content real.
vi.mock('@/components/ui/popover', async importOriginal => {
    const { createInlinePopoverModuleMock } = await import('@/dev/testkit/mocks/popover');
    return createInlinePopoverModuleMock(importOriginal);
});

await initializeAuthRouteRuntimeForTests();
const { storage } = await import('@/sync/domains/state/storageStore');
const { settingsDefaults } = await import('@/sync/domains/settings/settings');
const { publishAppliedActiveServerSnapshot } = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
const { applyPromptLibraryCatalogSnapshot, resetPromptLibraryCatalogSnapshotsForTests } = await import('@/sync/store/settings/promptLibraryCatalogSnapshot');
const { resetPromptLibraryCatalogEngineForTests } = await import('@/sync/engine/settings/promptLibraryCatalogEngine');
const scope = { serverId: 'prompt-stack-home', accountId: 'prompt-stack-account' };

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

describe('PromptStackEditorScreen', () => {
    beforeEach(() => {
        promptStacksRouterPushSpy.mockClear();
        resetPromptLibraryCatalogEngineForTests();
        resetPromptLibraryCatalogSnapshotsForTests();
        storage.setState({ settings: settingsDefaults, settingsVersion: 7, settingsScope: scope, profileScope: scope, isDataReady: true });
        publishAppliedActiveServerSnapshot({ serverId: scope.serverId, serverUrl: 'https://prompt-stack.invalid', generation: 1 });
        storage.getState().applyArtifacts([{ id: 'doc-1', title: 'Instructions', headerVersion: 1, bodyVersion: 1,
            ownerAccountId: scope.accountId, access: 'owner', header: { kind: 'prompt_doc.v2', title: 'Instructions' },
            body: null, createdAt: 1, updatedAt: 1, seq: 1, isDecrypted: true }]);
        applyPromptLibraryCatalogSnapshot(scope, { catalog: { status: 'ready', rows: [{ revision: 4,
            record: { key: 'coding', value: { v: 1, scope: { kind: 'coding' }, entries: [{ id: 'entry-1',
                ref: { kind: 'doc', artifactId: 'doc-1' }, enabled: true, placement: 'system_append' }] } } }],
            tombstones: [], diagnostics: [] }, rawSettings: {}, sourceSettingsVersion: 7 }, true);
    });

    it('renders stack entries with row actions and an add action on the section', async () => {
        const { PromptStackEditorScreen } = await import('./PromptStackEditorScreen');

        const screen = await renderScreen(React.createElement(PromptStackEditorScreen, {
                surface: 'coding',
                title: 'System Prompt Additions',
            }));

        expect(screen.findByTestId('promptStack.entry.entry-1')).toBeTruthy();
        expect(screen.findByTestId('promptStack.add')).toBeTruthy();

        await screen.pressByTestIdAsync('promptStack.entry.entry-1.more');
        const actionIds = [
            'edit',
            'moveUp',
            'moveDown',
            'budget.all',
            'budget.3000',
            'budget.9000',
            'budget.24000',
            'delete',
        ];
        for (const id of actionIds) expect(screen.findHostByTestId(id)).toBeTruthy();
        await screen.pressByTestIdAsync('edit');
        await vi.waitFor(() => expect(promptStacksRouterPushSpy).toHaveBeenCalledWith(
            `/settings/prompts/docs/doc-1?serverId=${scope.serverId}`,
        ));
    });

    it('offers documents but no skill bundles through its real add menu', async () => {
        storage.getState().applyArtifacts([
            { id: 'available-doc', title: 'Review notes', header: { kind: 'prompt_doc.v2', title: 'Review notes' },
                ownerAccountId: scope.accountId, access: 'owner', isDecrypted: true, body: null,
                headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 },
            { id: 'available-skill', title: 'Review skill', header: { kind: 'prompt_bundle.v2', title: 'Review skill', bundleSchemaId: 'skills.skill_md_v1' },
                ownerAccountId: scope.accountId, access: 'owner', isDecrypted: true, body: null,
                headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 },
        ]);
        const { PromptStackEditorScreen } = await import('./PromptStackEditorScreen');
        const { DropdownMenu } = await import('@/components/ui/forms/dropdown/DropdownMenu');
        const screen = await renderScreen(<PromptStackEditorScreen surface="coding" title="Context" />);
        await screen.pressByTestIdAsync('promptStack.add');
        const menu = screen.findAllByType(DropdownMenu).find(node => node.props.testID === 'promptStack.addMenu');
        expect(menu?.props.items.map((item: { id: string }) => item.id)).toEqual(['available-doc']);
    });

    it('opens the Account page with the three memory creation defaults, each saying the consequence of its state', async () => {
        storage.setState({ settings: { ...settingsDefaults, memoryUseInNewSessions: false, memoryUseInNewBots: true, memoryUpkeepInNewBots: false } });
        const { PromptStackEditorScreen } = await import('./PromptStackEditorScreen');

        const screen = await renderScreen(React.createElement(PromptStackEditorScreen, { surface: 'coding', title: 'Context' }));
        const subtitle = (testID: string) => screen.findAllByTestId(testID).map((node) => node.props.subtitle).find((value) => typeof value === 'string');

        expect(screen.findByTestId('context.memoryDefaults.sessions.switch')?.props.value).toBe(false);
        expect(screen.findByTestId('context.accountMemory.remember')).toBeTruthy();
        expect(subtitle('context.memoryDefaults.sessions')).toBe('contextPages.account.sessionsOff');
        expect(screen.findByTestId('context.memoryDefaults.bots.switch')?.props.value).toBe(true);
        expect(subtitle('context.memoryDefaults.bots')).toBe('contextPages.account.botsOn');
        // D47: memory upkeep for new Bots sits with the memory defaults and follows its own switch.
        expect(screen.findByTestId('context.memoryDefaults.upkeep.switch')?.props.value).toBe(false);
        expect(subtitle('context.memoryDefaults.upkeep')).toBe('contextPages.account.upkeepOff');
    });

    it('keeps the memory defaults and the memory section off the Voice stack page', async () => {
        const { PromptStackEditorScreen } = await import('./PromptStackEditorScreen');

        const screen = await renderScreen(React.createElement(PromptStackEditorScreen, { surface: 'voice', title: 'Voice' }));

        expect(screen.findByTestId('context.memoryDefaults.upkeep')).toBeNull();
        expect(screen.findByTestId('promptStacks.voice')).toBeNull();
        expect(screen.findByTestId('promptStack.add')).toBeTruthy();
    });

    it('shows your memory as its own section, never again as a document row', async () => {
        applyPromptLibraryCatalogSnapshot(scope, { catalog: { status: 'ready', rows: [{ revision: 5,
            record: { key: 'coding', value: { v: 1, scope: { kind: 'coding' }, entries: [
                { id: 'account.memory', ref: { kind: 'doc', artifactId: 'memory-1' }, enabled: true, placement: 'system_append' },
                { id: 'entry-1', ref: { kind: 'doc', artifactId: 'doc-1' }, enabled: true, placement: 'system_append' }] } } }],
            tombstones: [], diagnostics: [] }, rawSettings: {}, sourceSettingsVersion: 7 }, true);
        storage.getState().applyArtifacts([{ id: 'memory-1', title: 'Account memory', headerVersion: 1, bodyVersion: 1,
            ownerAccountId: scope.accountId, access: 'owner', header: { kind: 'memory_doc.v1', title: 'Account memory' },
            body: null, createdAt: 1, updatedAt: 1, seq: 1, isDecrypted: true }]);
        const { PromptStackEditorScreen } = await import('./PromptStackEditorScreen');

        const screen = await renderScreen(React.createElement(PromptStackEditorScreen, { surface: 'coding', title: 'Context' }));

        expect(screen.findByTestId('promptStack.entry.account.memory')).toBeNull();
        expect(screen.findByTestId('promptStack.entry.entry-1')).toBeTruthy();
        // The single remaining document cannot move past the memory entry it is listed without.
        await screen.pressByTestIdAsync('promptStack.entry.entry-1.more');
        expect(screen.findHostByTestId('moveUp')?.props.disabled).toBe(true);
        expect(screen.findHostByTestId('moveDown')?.props.disabled).toBe(true);
    });
});
