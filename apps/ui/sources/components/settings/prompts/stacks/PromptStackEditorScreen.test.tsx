import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import {
    installPromptStacksCommonModuleMocks,
    promptStacksRouterPushSpy,
} from './promptStacksScreenTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

installPromptStacksCommonModuleMocks({
    storage: importOriginal => importOriginal(),
});

const { storage } = await import('@/sync/domains/state/storageStore');
const { settingsDefaults } = await import('@/sync/domains/settings/settings');
const { publishAppliedActiveServerSnapshot } = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
const { applyPromptLibraryCatalogSnapshot, resetPromptLibraryCatalogSnapshotsForTests } = await import('@/sync/store/settings/promptLibraryCatalogSnapshot');
const { resetPromptLibraryCatalogEngineForTests } = await import('@/sync/engine/settings/promptLibraryCatalogEngine');
const scope = { serverId: 'prompt-stack-home', accountId: 'prompt-stack-account' };

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('@/components/ui/layout/layout', () => ({
    layout: { maxWidth: 1000 },
    useLayoutMaxWidth: () => 1000,
    useLayoutMaxWidthStyle: () => ({ maxWidth: 1000 }),
}));

vi.mock('@/components/ui/lists/ItemRowActions', () => ({
    ItemRowActions: (props: any) => React.createElement('ItemRowActions', props),
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
                ref: { kind: 'doc', artifactId: 'doc-1' }, enabled: true, placement: 'system_append', editPolicy: 'user_only' }] } } }],
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

        const actions = screen.findAllByType('ItemRowActions' as any)[0];
        expect(actions).toBeTruthy();
        expect(actions?.props?.actions?.map((action: any) => action.id)).toEqual([
            'edit',
            'moveUp',
            'moveDown',
            'delete',
        ]);
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
        const moves = screen.findAllByType('ItemRowActions' as any)[0]?.props.actions.filter((action: any) => action.id.startsWith('move'));
        expect(moves.map((action: any) => action.disabled)).toEqual([true, true]);
    });
});
