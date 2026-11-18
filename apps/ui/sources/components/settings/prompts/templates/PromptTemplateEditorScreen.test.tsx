import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { invokeTestInstanceHandler, renderScreen, standardCleanup } from '@/dev/testkit';
import { clearActiveUnsavedChangesGuard } from '@/utils/navigation/runGuardedNavigation';
import { createPlainPromptLibraryCatalogHomeFixture } from '@/dev/testkit/harness/promptLibraryCatalogBoundary';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import {
    installPromptTemplatesCommonModuleMocks,
    promptTemplatesRouterBackSpy,
    promptTemplatesRouterPushSpy,
} from './promptTemplatesScreenTestHelpers';

const promptTemplatesRouterReplaceSpy = vi.hoisted(() => vi.fn());


(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let catalog: Awaited<ReturnType<typeof createPlainPromptLibraryCatalogHomeFixture>>;

installPromptTemplatesCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            ScrollView: 'ScrollView',
            View: 'View',
            Switch: 'Switch',
            useWindowDimensions: () => ({ width: 1440, height: 1000, scale: 1, fontScale: 1 }),
            Platform: {
                OS: 'web',
                select: ({ web, default: defaultValue }: { web?: unknown; default?: unknown }) =>
                    web ?? defaultValue,
            },
        });
    },
    unistyles: async () => {
        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock({
            theme: {
                colors: {
                    groupped: { background: 'white' },
                    input: { background: '#fff', text: '#111', placeholder: '#666' },
                    accent: { blue: '#00f', indigo: '#60f' },
                    textSecondary: '#999',
                    textDestructive: '#f00',
                },
            },
        });
    },
    router: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        const routerMock = createExpoRouterMock({
            router: { push: promptTemplatesRouterPushSpy, back: promptTemplatesRouterBackSpy, replace: promptTemplatesRouterReplaceSpy },
        });
        return routerMock.module;
    },
    storage: importOriginal => importOriginal(),
});

const { storage } = await import('@/sync/domains/state/storageStore');
// Layout/menu consumers reach the router: load them after configuring its native boundary.
const { DropdownMenu } = await import('@/components/ui/forms/dropdown/DropdownMenu');
const { applyPromptLibraryCatalogSnapshot, resetPromptLibraryCatalogSnapshotsForTests } = await import('@/sync/store/settings/promptLibraryCatalogSnapshot');
const { resetPromptLibraryCatalogEngineForTests } = await import('@/sync/engine/settings/promptLibraryCatalogEngine');

/** Whether the screen currently asks the navigator to hold a departure (the unsaved-changes guard). */
const preventRemoveState = vi.hoisted(() => ({ last: null as boolean | null }));

// The navigator's remove interception is the navigation library boundary; record what the screen asks for.
vi.mock('@react-navigation/native', async (importOriginal) => ({
    ...await importOriginal<typeof import('@react-navigation/native')>(),
    ...(await import('@/dev/testkit/mocks/reactNavigation')).createReactNavigationNativeMock(),
    usePreventRemove: (preventRemove: boolean) => {
        preventRemoveState.last = preventRemove;
    },
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

// Only the browser portal and measured window frame are substituted; selection remains real.
vi.mock('@/components/ui/popover', async importOriginal => {
    const { createInlinePopoverModuleMock } = await import('@/dev/testkit/mocks/popover');
    return createInlinePopoverModuleMock(importOriginal);
});

function targetMenu(screen: Awaited<ReturnType<typeof renderScreen>>) {
    const menu = screen.findAllByType(DropdownMenu).find(node => node.props.itemTrigger);
    if (!menu) throw new Error('Missing target prompt selector');
    return menu;
}

async function chooseTarget(screen: Awaited<ReturnType<typeof renderScreen>>, artifactId: string) {
    await act(async () => { targetMenu(screen).props.onOpenChange(true); });
    await screen.pressByTestIdAsync(`dropdown-option-${artifactId}`);
    // A real dropdown settles selection after its popover closes.
    await vi.waitFor(() => expect(targetMenu(screen).props.selectedId).toBe(artifactId));
}

describe('PromptTemplateEditorScreen', () => {
    it.each(['doc', 'template'] as const)('isolates %s draft rail titles and cleanup between retained collection destinations', async kind => {
        if (kind === 'doc') {
            // Monaco is a browser SDK boundary; without its API the real editor uses its text-input fallback.
            vi.stubGlobal('window', {});
            onTestFinished(() => { vi.unstubAllGlobals(); });
        }
        const { PromptTemplateEditorScreen } = await import('./PromptTemplateEditorScreen');
        const { PromptDocEditorScreen } = await import('../docs/PromptDocEditorScreen');
        const { PromptCollectionLayout } = await import('../collection/PromptCollectionList');
        const { DestinationInstanceHost } = await import('@/components/appShell/workspace/DestinationInstanceHost');
        const { WorkspaceRouteOutlet } = await import('@/components/appShell/workspace/WorkspaceRouteOutlet');
        const { router } = await import('expo-router');
        const renderDestination = async (id: string) => {
            const screen = await renderScreen(<DestinationInstanceHost tabId={id} ref={{ kind: 'settings', params: {} }}
                pathname={`/settings/prompts/${kind === 'doc' ? 'docs' : 'templates'}/new`} navigation={router} focused visible>
                <WorkspaceRouteOutlet.Provider value={kind === 'doc' ? <PromptDocEditorScreen artifactId={null} /> : <PromptTemplateEditorScreen invocationId={null} />}>
                    <PromptCollectionLayout kind={kind} />
                </WorkspaceRouteOutlet.Provider>
            </DestinationInstanceHost>);
            await act(async () => { invokeTestInstanceHandler(screen.findHostByTestId(`settings-prompts-${kind}-layout`), 'onLayout', {
                nativeEvent: { layout: { x: 0, y: 0, width: 1440, height: 1000 } },
            }); });
            return screen;
        };
        const first = await renderDestination('first');
        const titleId = kind === 'doc' ? 'promptDoc.title' : 'promptTemplate.title';
        await act(async () => { first.changeTextByTestId(titleId, 'First draft'); });
        const second = await renderDestination('second');
        await act(async () => { second.changeTextByTestId(titleId, 'Second draft'); });
        const title = (screen: typeof first) => screen.findAll(node => node.props.testID === `promptLibrary.collection.${kind}.draft`
            && typeof node.props.title === 'string').map(node => node.props.title);
        expect(title(first)).toContain('First draft');
        expect(title(first)).not.toContain('Second draft');
        expect(title(second)).toContain('Second draft');
        await act(async () => { second.unmount(); });
        expect(title(first)).toContain('First draft');
    });

    afterEach(() => {
        standardCleanup();
        clearActiveUnsavedChangesGuard();
    });
    beforeEach(async () => {
        clearActiveUnsavedChangesGuard();
        resetPromptLibraryCatalogEngineForTests();
        resetPromptLibraryCatalogSnapshotsForTests();
        promptTemplatesRouterPushSpy.mockClear();
        promptTemplatesRouterBackSpy.mockClear();
        promptTemplatesRouterReplaceSpy.mockClear();
        catalog = await createPlainPromptLibraryCatalogHomeFixture('https://template-catalog.test', {
            key: 'invocations', value: { v: 1, entries: [] },
        });
        onTestFinished(catalog.dispose);
        const scope = storage.getState().settingsScope;
        if (!scope) throw new Error('Missing admitted template Account');
        storage.setState({ isDataReady: true });
        applyPromptLibraryCatalogSnapshot(scope, { catalog: { status: 'ready', rows: [catalog.read()],
            tombstones: catalog.tombstones, diagnostics: [] }, rawSettings: {}, sourceSettingsVersion: 7 }, true);
        storage.getState().applyArtifacts(['doc-1', 'doc-2'].map((id, index) => ({
            id, title: `Prompt ${index === 0 ? 'One' : 'Two'}`, headerVersion: 1, bodyVersion: 1,
            ownerAccountId: scope.accountId, access: 'owner' as const,
            header: { kind: 'prompt_doc.v2', title: `Prompt ${index === 0 ? 'One' : 'Two'}` },
            body: null, createdAt: 1, updatedAt: 1, seq: 1, isDecrypted: true,
        })));
    });

    it('uses a dropdown selector for the target prompt and exposes create/edit prompt actions', async () => {
        const { PromptTemplateEditorScreen } = await import('./PromptTemplateEditorScreen');

        const screen = await renderScreen(React.createElement(PromptTemplateEditorScreen, { invocationId: null }));

        const dropdown = targetMenu(screen);
        expect(dropdown?.props?.selectedId).toBe('');
        expect(dropdown.props.items.map((item: { id: string }) => item.id)).toEqual(['doc-1', 'doc-2']);

        expect(screen.findByTestId('promptTemplate.target.edit')).toBeTruthy();
        expect(screen.findByTestId('promptTemplate.target.new')).toBeTruthy();
        expect(screen.findByTestId('promptTemplate.behavior:insert_on_send')).toBeTruthy();
        expect(screen.findByTestId('promptTemplate.save')).toBeTruthy();
    });

    it('explains under the command field why a reserved slash command cannot be saved', async () => {
        const { PromptTemplateEditorScreen } = await import('./PromptTemplateEditorScreen');
        const screen = await renderScreen(React.createElement(PromptTemplateEditorScreen, { invocationId: null }));

        await act(async () => {
            screen.changeTextByTestId('promptTemplate.title', 'Clear');
            screen.changeTextByTestId('promptTemplate.token', '/clear');
        });
        await chooseTarget(screen, 'doc-1');
        await act(async () => {
            await screen.findByTestId('promptTemplate.save')?.props.onPress();
        });

        expect(screen.findByTestId('promptTemplate.token.error')).toBeTruthy();
        expect(catalog.mutations).toEqual([]);
    });

    it('opens a new template in the collection once its draft is saved', async () => {
        const { PromptTemplateEditorScreen } = await import('./PromptTemplateEditorScreen');
        const screen = await renderScreen(React.createElement(PromptTemplateEditorScreen, { invocationId: null }));

        await act(async () => {
            screen.changeTextByTestId('promptTemplate.title', 'Daily');
            screen.changeTextByTestId('promptTemplate.token', 'daily');
        });
        await chooseTarget(screen, 'doc-1');
        expect(preventRemoveState.last).toBe(true);
        await act(async () => {
            await screen.findByTestId('promptTemplate.save')?.props.onPress();
        });
        // The header dispatches Save without returning its promise; wait for the real persisted outcome.
        await vi.waitFor(() => expect(catalog.read().record.value).toEqual({
            v: 1,
            entries: [expect.objectContaining({ id: expect.any(String), token: '/daily', title: 'Daily' })],
        }));
        // The saved draft has nothing left to lose, so opening it is not held for a decision.
        await vi.waitFor(() => expect(preventRemoveState.last).toBe(false));
        expect(catalog.mutations).toEqual([{ key: 'invocations', expectedRevision: 4 }]);
        expect(catalog.settingsWrites()).toBe(0);
        const record = catalog.read().record;
        if (record.key !== 'invocations') throw new Error('Wrong template catalog fixture');
        const saved = record.value.entries[0]!;
        expect(saved.id).not.toBe('');
        await vi.waitFor(() => expect(promptTemplatesRouterReplaceSpy).toHaveBeenCalledWith(`/settings/prompts/templates/${saved.id}`));
    });

    it('honors Action Off for a complete new template before writing the catalog', async () => {
        const { Modal } = await import('@/modal');
        vi.mocked(Modal.alert).mockClear();
        storage.setState({ settings: { ...storage.getState().settings, actionsSettingsV1: ActionsSettingsV1Schema.parse({
            v: 1, actions: { 'prompts.invocation.create': { enabled: false } },
        }) } });
        const { PromptTemplateEditorScreen } = await import('./PromptTemplateEditorScreen');
        const screen = await renderScreen(React.createElement(PromptTemplateEditorScreen, { invocationId: null }));
        await act(async () => {
            screen.changeTextByTestId('promptTemplate.title', 'Daily');
            screen.changeTextByTestId('promptTemplate.token', 'daily');
        });
        await chooseTarget(screen, 'doc-1');
        await act(async () => { await screen.findByTestId('promptTemplate.save')?.props.onPress(); });
        // A raw catalog writer would persist despite the disabled Action.
        await vi.waitFor(() => expect(Modal.alert).toHaveBeenCalledWith('common.error', 'actionConfirmations.turnedOffUnnamedMessage'));
        expect(catalog.mutations).toEqual([]);
        expect(preventRemoveState.last).toBe(true);
        expect(promptTemplatesRouterReplaceSpy).not.toHaveBeenCalled();
    });

    it('edits through the captured revision and lets the Action waiver own deletion confirmation', async () => {
        const scope = storage.getState().settingsScope;
        if (!scope) throw new Error('Missing admitted template Account');
        const { writePromptLibraryRecord } = await import('@/sync/api/account/apiPromptLibraryCatalog');
        await writePromptLibraryRecord(scope, { record: { key: 'invocations', value: { v: 1, entries: [{
            id: 'saved', token: '/daily', title: 'Daily', target: { kind: 'doc', artifactId: 'doc-1', serverId: scope.serverId },
            behavior: 'insert', allowArgs: false, availableIn: 'session_only',
        }] } }, expectedRevision: 4 });
        catalog.mutations.length = 0;
        const { Modal } = await import('@/modal');
        vi.mocked(Modal.confirm).mockClear();
        vi.mocked(Modal.show).mockClear();
        const { PromptTemplateEditorScreen } = await import('./PromptTemplateEditorScreen');
        const screen = await renderScreen(<PromptTemplateEditorScreen invocationId="saved" />);
        await act(async () => { screen.changeTextByTestId('promptTemplate.title', 'Weekly'); });
        await screen.pressByTestIdAsync('promptTemplate.save');
        await vi.waitFor(() => expect(catalog.read().record.value).toMatchObject({ entries: [{ id: 'saved', title: 'Weekly',
            availableIn: 'session_only', target: { serverId: scope.serverId } }] }));
        expect(catalog.mutations).toEqual([{ key: 'invocations', expectedRevision: 5 }]);
        storage.setState({ settings: { ...storage.getState().settings, actionsSettingsV1: ActionsSettingsV1Schema.parse({
            v: 1, approvalWaivedSurfaces: { 'prompts.invocation.delete': ['ui'] },
        }) } });
        const menu = screen.findAllByType(DropdownMenu).find(node => node.props.testID === 'promptTemplate.header.menu');
        if (!menu) throw new Error('Missing template operations menu');
        await act(async () => { await menu.props.onSelect('delete'); });
        await vi.waitFor(() => expect(catalog.read().record.value).toEqual({ v: 1, entries: [] }));
        expect(catalog.mutations).toEqual([{ key: 'invocations', expectedRevision: 5 }, { key: 'invocations', expectedRevision: 6 }]);
        expect(Modal.confirm).not.toHaveBeenCalled();
        expect(Modal.show).not.toHaveBeenCalled();
        await vi.waitFor(() => expect(promptTemplatesRouterReplaceSpy).toHaveBeenCalledWith('/settings/prompts/templates'));
    });
});
