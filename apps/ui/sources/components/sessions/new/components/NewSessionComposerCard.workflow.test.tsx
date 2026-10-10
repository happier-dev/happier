import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { createNewSessionPromptStore } from '../hooks/screenModel/newSessionPromptStore';
import { NewSessionComposerCard } from './NewSessionComposerCard';
import type { NewSessionSimplePanelProps } from './NewSessionSimplePanel';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { useNewSessionWorkflowStart } from '../hooks/useNewSessionWorkflowStart';
import { getStorage } from '@/sync/domains/state/storageStore';
import { act } from 'react-test-renderer';
import { flattenTestStyle } from '@/dev/testkit';
import Color from 'color';

const platformState = vi.hoisted(() => ({ os: 'web' as 'web' | 'android', width: 1440 }));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        useWindowDimensions: () => ({ width: platformState.width, height: 844, scale: 1, fontScale: 1 }),
        Platform: {
            get OS() { return platformState.os; },
            select: (values: Record<string, unknown>) => values[platformState.os] ?? values.default,
        },
    });
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
// Portal/window measurement is the boundary; the menu and its workflow selection stay real.
vi.mock('@/components/ui/popover', async (importOriginal) => {
    const { createInlinePopoverModuleMock } = await import('@/dev/testkit/mocks/popover');
    return createInlinePopoverModuleMock(importOriginal);
});
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock().module;
});
vi.mock('@/sync/runtime/orchestration/connectionManager', () => ({
    getAppliedActiveServerSnapshot: () => ({ serverId: 'server-a' }),
    isAppliedActiveServerRuntimeAvailable: () => true,
}));
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key });
});

function panelProps(): NewSessionSimplePanelProps {
    return {
            // Native refs begin unmounted; this fixture does not measure the popover boundary.
            popoverBoundaryRef: React.createRef() as NewSessionSimplePanelProps['popoverBoundaryRef'],
            headerHeight: 0, safeAreaTop: 0, safeAreaBottom: 0,
            newSessionTopPadding: 0, newSessionSidePadding: 0, newSessionBottomPadding: 0, containerStyle: {},
            promptStore: createNewSessionPromptStore('Keep this brief'), setSessionPrompt: () => {},
            handleCreateSession: () => {}, canCreate: true, isCreating: false,
            emptyAutocompleteKinds: [], emptyAutocompleteSuggestions: async () => [],
            agentType: 'codex', handleAgentClick: undefined, permissionMode: 'default',
            handlePermissionModeChange: undefined, modelMode: 'default', setModelMode: undefined,
            modelOptions: [], connectionStatus: undefined, machineName: undefined, selectedPath: '/repo',
            useProfiles: false, selectedProfileId: null,
            showResumePicker: false, resumeSessionId: null, isResumeSupportChecking: false,
        } satisfies NewSessionSimplePanelProps;
}

describe('New workflow entry', () => {
    it('retains the selected workflow and its inputs when the screen panel recomposes across phone width', async () => {
        const { NewSessionSimplePanel } = await import('./NewSessionSimplePanel');
        const previous = getStorage().getState().profileScope;
        const props = { ...panelProps(), selectedMachineId: 'machine-1', targetServerId: 'server-a' };
        platformState.width = 1440;
        try {
            await act(async () => {
                getStorage().setState({ profileScope: { serverId: 'server-a', accountId: 'account-a' } });
            });
            const screen = await renderScreen(<NewSessionSimplePanel {...props} />);
            await screen.pressByTestIdAsync('new-session-workflow-chip');
            await screen.pressByTestIdAsync('workflow-choice:builtin:plan-with-a-panel');
            const input = screen.findByTestId('workflow-run-inputs');
            expect(input).not.toBeNull();
            for (const width of [390, 430, 1440]) {
                platformState.width = width;
                await screen.update(<NewSessionSimplePanel {...props} />);
                expect(screen.findByTestId('workflow-run-inputs')).toBe(input);
                expect(screen.findByTestId('new-session-composer-input')?.props.value).toBe('Keep this brief');
            }
        } finally {
            platformState.width = 1440;
            await act(async () => { getStorage().setState({ profileScope: previous }); });
        }
    });
    it('keeps the admitted read-only document on the same floating material plane', async () => {
        const { AgentInput } = await import('@/components/sessions/agentInput');
        const store = getStorage();
        const previous = store.getState().settings;
        platformState.os = 'android';
        try {
            await act(async () => {
                store.setState({ settings: { ...previous, glassBlurEnabled: true, glassSurfaceMaterials: null } });
            });
            const screen = await renderScreen(<AgentInput value="Frozen document" placeholder="Document" surfaceGroup="floating"
                autocompleteKinds={[]} autocompleteSuggestions={async () => []} />);
            const surface = screen.findByTestId('agent-input-material-surface');
            expect(surface).not.toBeNull();
            expect(Color(flattenTestStyle(surface?.props.style).backgroundColor as string).alpha()).toBe(0.9);
            expect(screen.getTextContent()).toContain('Frozen document');
            expect(screen.findByTestId('new-session-composer-input')).toBeNull();
        } finally {
            platformState.os = 'web';
            await act(async () => { store.setState({ settings: previous }); });
        }
    });
    it('gives the phone floating composer its own material coat and restores solid when its group is off', async () => {
        const store = getStorage();
        const previous = store.getState().settings;
        platformState.os = 'android';
        try {
            await act(async () => {
                store.setState({ settings: { ...previous, glassBlurEnabled: true, glassSurfaceMaterials: null } });
            });
            const screen = await renderScreen(<NewSessionComposerCard panelProps={panelProps()} layout="screen" attachments={false} surfaceGroup="floating" />);
            const surface = screen.findByTestId('agent-input-material-surface');
            expect(surface).not.toBeNull();
            expect(Color(flattenTestStyle(surface?.props.style).backgroundColor as string).alpha()).toBe(0.9);
            expect(screen.findByTestId('new-session-composer-input')?.props.value).toBe('Keep this brief');
            await act(async () => {
                store.setState({ settings: { ...previous, glassBlurEnabled: false, glassSurfaceMaterials: null } });
            });
            expect(Color(flattenTestStyle(screen.findByTestId('agent-input-material-surface')?.props.style).backgroundColor as string).alpha()).toBe(1);
            await act(async () => {
                store.setState({ settings: { ...previous, glassBlurEnabled: true, glassSurfaceMaterials: null } });
                screen.tree.update(<NewSessionComposerCard panelProps={panelProps()} layout="screen" attachments={false} />);
            });
            expect(Color(flattenTestStyle(screen.findByTestId('agent-input-material-surface')?.props.style).backgroundColor as string).alpha()).toBe(1);
        } finally {
            platformState.os = 'web';
            await act(async () => { store.setState({ settings: previous }); });
        }
    });
    it('offers Workflow in the actual New composer without replacing the plain-session prompt', async () => {
        const screen = await renderScreen(<NewSessionComposerCard panelProps={panelProps()} layout="screen" attachments={false} />);
        expect(screen.findByTestId('new-session-workflow-chip')).not.toBeNull();
        expect(screen.findByTestId('new-session-composer-input')?.props.value).toBe('Keep this brief');
    });
    it('retains the floating material when a selected workflow replaces the phone composer', async () => {
        const store = getStorage();
        const previous = store.getState();
        platformState.os = 'android';
        try {
            await act(async () => {
                store.setState({ profileScope: { serverId: 'server-a', accountId: 'account-a' }, settings: { ...previous.settings, glassBlurEnabled: true, glassSurfaceMaterials: null } });
            });
            const props = { ...panelProps(), selectedMachineId: 'machine-1', targetServerId: 'server-a' };
            const hook = await renderHook(() => useNewSessionWorkflowStart({ panelProps: props, prompt: 'Keep this brief', surfaceGroup: 'floating' }));
            const content = hook.getCurrent().chip.collapsedContentPopover?.renderContent;
            if (typeof content !== 'function') throw new Error('Workflow picker content is missing');
            const pickerNode = content({ requestClose: () => {}, maxHeight: 420 });
            if (!React.isValidElement(pickerNode)) throw new Error('Workflow picker is missing');
            const picker = await renderScreen(pickerNode);
            await picker.pressByTestIdAsync('workflow-choice:builtin:plan-with-a-panel');
            const composer = hook.getCurrent().composer;
            if (composer === null) throw new Error('Selected workflow composer is missing');
            const screen = await renderScreen(composer);
            expect(Color(flattenTestStyle(screen.findByTestId('agent-input-material-surface')?.props.style).backgroundColor as string).alpha()).toBe(0.9);
            expect(screen.findByTestId('new-session-composer-input')?.props.value).toBe('Keep this brief');
        } finally {
            platformState.os = 'web';
            await act(async () => { store.setState({ settings: previous.settings, profileScope: previous.profileScope }); });
        }
    });
    it('keeps the embedded bar focused while Workflow stays available in its actions menu', async () => {
        const screen = await renderScreen(<NewSessionComposerCard panelProps={panelProps()} layout="embedded" attachments={false} />);
        expect(screen.findByTestId('new-session-workflow-chip')).toBeNull();
        await screen.pressByTestIdAsync('agent-input-action-menu-button');
        expect(screen.getTextContent()).toContain('workflows');
        expect(screen.findByTestId('new-session-composer-input')?.props.value).toBe('Keep this brief');
    });
    it('keeps typed text as the first text input, then withdraws that private draft on Account change', async () => {
        getStorage().setState({ profileScope: { serverId: 'server-a', accountId: 'account-a' } });
        const props = { ...panelProps(), selectedMachineId: 'machine-1', targetServerId: 'server-a' };
        const hook = await renderHook(() => useNewSessionWorkflowStart({ panelProps: props, prompt: 'Keep this brief' }));
        const content = hook.getCurrent().chip.collapsedContentPopover?.renderContent;
        if (typeof content !== 'function') throw new Error('Workflow picker content is missing');
        const pickerNode = content({ requestClose: () => {}, maxHeight: 420 });
        if (!React.isValidElement(pickerNode)) throw new Error('Workflow picker is missing');
        const picker = await renderScreen(pickerNode);
        await picker.pressByTestIdAsync('workflow-choice:builtin:plan-with-a-panel');
        const composer = hook.getCurrent().composer;
        if (composer === null) throw new Error('Selected workflow composer is missing');
        const screen = await renderScreen(composer);
        expect(screen.findByTestId('new-session-composer-input')?.props.value).toBe('Keep this brief');
        // No Home feature snapshot has advertised Workflow support in this fixture.
        expect(screen.findByTestId('workflow-run-inputs-run')?.props.disabled).toBe(true);
        await act(async () => { getStorage().setState({ profileScope: { serverId: 'server-a', accountId: 'account-b' } }); });
        expect(hook.getCurrent().composer).toBeNull();
    });
});
