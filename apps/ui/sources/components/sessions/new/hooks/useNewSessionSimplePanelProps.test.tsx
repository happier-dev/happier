import * as React from 'react';
import { createNewSessionPromptStore } from '@/components/sessions/new/hooks/screenModel/newSessionPromptStore';
import { View } from 'react-native';
import { describe, expect, it, vi } from 'vitest';
import { createProviderErrorV1 } from '@happier-dev/protocol';

import { renderHook } from '@/dev/testkit';

import type { NewSessionSimplePanelProps } from '../components/NewSessionSimplePanel';
import { useNewSessionSimplePanelProps } from './useNewSessionSimplePanelProps';

function createPanelProps(
    overrides: Partial<NewSessionSimplePanelProps> = {},
): NewSessionSimplePanelProps {
    const popoverBoundaryRef = React.createRef<View>() as React.RefObject<View>;
    return {
        popoverBoundaryRef,
        headerHeight: 0,
        safeAreaTop: 0,
        safeAreaBottom: 0,
        newSessionTopPadding: 0,
        newSessionSidePadding: 0,
        newSessionBottomPadding: 0,
        containerStyle: {},
        promptStore: createNewSessionPromptStore(''),
        setSessionPrompt: vi.fn(),
        handleCreateSession: vi.fn(),
        canCreate: true,
        isCreating: false,
        emptyAutocompleteKinds: [],
        emptyAutocompleteSuggestions: async () => [],
        agentType: 'codex',
        handleAgentClick: vi.fn(),
        permissionMode: 'default',
        handlePermissionModeChange: vi.fn(),
        modelMode: 'default',
        setModelMode: vi.fn(),
        modelOptions: [],
        connectionStatus: undefined,
        machineName: 'Machine',
        selectedPath: '/repo',
        showResumePicker: false,
        resumeSessionId: null,
        isResumeSupportChecking: false,
        useProfiles: false,
        selectedProfileId: null,
        ...overrides,
    };
}

describe('useNewSessionSimplePanelProps', () => {
    it('preserves the route-owned bottom-anchor decision across the memoized panel model', async () => {
        const hook = await renderHook((props: NewSessionSimplePanelProps) => useNewSessionSimplePanelProps(props), {
            initialProps: createPanelProps({ shouldBottomAnchor: true }),
        });

        expect(hook.getCurrent().shouldBottomAnchor).toBe(true);

        await hook.rerender(createPanelProps({ shouldBottomAnchor: false }));

        expect(hook.getCurrent().shouldBottomAnchor).toBe(false);

        await hook.unmount();
    });

    it('preserves launch status badge props across the memoized panel model', async () => {
        const statusBadges = [{
            key: 'new-session-launch-starting',
            label: 'newSession.startingSession',
            tone: 'active' as const,
        }];

        const hook = await renderHook((props: NewSessionSimplePanelProps) => useNewSessionSimplePanelProps(props), {
            initialProps: createPanelProps({ statusBadges }),
        });

        expect(hook.getCurrent().statusBadges).toBe(statusBadges);

        await hook.unmount();
    });

    it('preserves route-owned composer notice and trailing actions', async () => {
        const composerTopContent = React.createElement('ComposerNotice');
        const statusTrailingActions = React.createElement('StatusActions');
        const hook = await renderHook((props: NewSessionSimplePanelProps) => useNewSessionSimplePanelProps(props), {
            initialProps: createPanelProps({ composerTopContent, statusTrailingActions }),
        });

        expect(hook.getCurrent().composerTopContent).toBe(composerTopContent);
        expect(hook.getCurrent().statusTrailingActions).toBe(statusTrailingActions);

        await hook.unmount();
    });

    it('preserves the typed Provider launch refusal and updates its recovery callback', async () => {
        const providerLaunchError = createProviderErrorV1('provider_not_enabled_on_machine', {
            connectionId: 'pc_provider',
            machineId: 'machine-1',
        });
        const firstRetry = vi.fn();
        const secondRetry = vi.fn();
        const hook = await renderHook((props: NewSessionSimplePanelProps) => useNewSessionSimplePanelProps(props), {
            initialProps: createPanelProps({ providerLaunchError, retryProviderLaunch: firstRetry }),
        });

        expect(hook.getCurrent().providerLaunchError).toBe(providerLaunchError);
        expect(hook.getCurrent().retryProviderLaunch).toBe(firstRetry);

        await hook.rerender(createPanelProps({ providerLaunchError, retryProviderLaunch: secondRetry }));

        expect(hook.getCurrent().providerLaunchError).toBe(providerLaunchError);
        expect(hook.getCurrent().retryProviderLaunch).toBe(secondRetry);
        await hook.unmount();
    });

    it('keeps shared popover configs stable while calling the latest render content', async () => {
        const firstMachineContent = React.createElement('MachineContent', { value: 'first' });
        const secondMachineContent = React.createElement('MachineContent', { value: 'second' });
        const firstRenderMachineContent = vi.fn(() => firstMachineContent);
        const secondRenderMachineContent = vi.fn(() => secondMachineContent);
        const firstResumeContent = React.createElement('ResumeContent', { value: 'first' });
        const secondResumeContent = React.createElement('ResumeContent', { value: 'second' });
        const firstRenderResumeContent = vi.fn(() => firstResumeContent);
        const secondRenderResumeContent = vi.fn(() => secondResumeContent);
        const firstProfileContent = React.createElement('ProfileContent', { value: 'first' });
        const secondProfileContent = React.createElement('ProfileContent', { value: 'second' });
        const firstRenderProfileContent = vi.fn(() => firstProfileContent);
        const secondRenderProfileContent = vi.fn(() => secondProfileContent);
        const firstPathContent = React.createElement('PathContent', { value: 'first' });
        const secondPathContent = React.createElement('PathContent', { value: 'second' });
        const firstRenderPathContent = vi.fn(() => firstPathContent);
        const secondRenderPathContent = vi.fn(() => secondPathContent);

        const hook = await renderHook((props: NewSessionSimplePanelProps) => useNewSessionSimplePanelProps(props), {
            initialProps: createPanelProps({
                machinePopover: {
                    renderContent: firstRenderMachineContent,
                    maxHeightCap: 560,
                    maxWidthCap: 560,
                    scrollEnabled: false,
                    keyboardShouldPersistTaps: 'handled',
                },
                resumePopover: {
                    renderContent: firstRenderResumeContent,
                    maxHeightCap: 460,
                    maxWidthCap: 460,
                },
                profilePopover: {
                    renderContent: firstRenderProfileContent,
                    maxHeightCap: 560,
                    maxWidthCap: 560,
                },
                pathPopover: {
                    renderContent: firstRenderPathContent,
                    maxHeightCap: 560,
                    maxWidthCap: 560,
                    scrollEnabled: false,
                    keyboardShouldPersistTaps: 'handled',
                },
            }),
        });
        const firstMachinePopover = hook.getCurrent().machinePopover;
        const firstResumePopover = hook.getCurrent().resumePopover;
        const firstProfilePopover = hook.getCurrent().profilePopover;
        const firstPathPopover = hook.getCurrent().pathPopover;

        await hook.rerender(createPanelProps({
            machinePopover: {
                renderContent: secondRenderMachineContent,
                maxHeightCap: 560,
                maxWidthCap: 560,
                scrollEnabled: false,
                keyboardShouldPersistTaps: 'handled',
            },
            resumePopover: {
                renderContent: secondRenderResumeContent,
                maxHeightCap: 460,
                maxWidthCap: 460,
            },
            profilePopover: {
                renderContent: secondRenderProfileContent,
                maxHeightCap: 560,
                maxWidthCap: 560,
            },
            pathPopover: {
                renderContent: secondRenderPathContent,
                maxHeightCap: 560,
                maxWidthCap: 560,
                scrollEnabled: false,
                keyboardShouldPersistTaps: 'handled',
            },
        }));

        expect(hook.getCurrent().machinePopover).toBe(firstMachinePopover);
        expect(hook.getCurrent().resumePopover).toBe(firstResumePopover);
        expect(hook.getCurrent().profilePopover).toBe(firstProfilePopover);
        expect(hook.getCurrent().pathPopover).toBe(firstPathPopover);

        const renderMachineContent = hook.getCurrent().machinePopover?.renderContent;
        const renderResumeContent = hook.getCurrent().resumePopover?.renderContent;
        const renderProfileContent = hook.getCurrent().profilePopover?.renderContent;
        const renderPathContent = hook.getCurrent().pathPopover?.renderContent;
        expect(typeof renderMachineContent).toBe('function');
        expect(typeof renderResumeContent).toBe('function');
        expect(typeof renderProfileContent).toBe('function');
        expect(typeof renderPathContent).toBe('function');
        expect(typeof renderMachineContent === 'function' ? renderMachineContent({ requestClose: vi.fn(), maxHeight: 320 }) : renderMachineContent)
            .toBe(secondMachineContent);
        expect(typeof renderResumeContent === 'function' ? renderResumeContent({ requestClose: vi.fn(), maxHeight: 320 }) : renderResumeContent)
            .toBe(secondResumeContent);
        expect(typeof renderProfileContent === 'function' ? renderProfileContent({ requestClose: vi.fn(), maxHeight: 320 }) : renderProfileContent)
            .toBe(secondProfileContent);
        expect(typeof renderPathContent === 'function' ? renderPathContent({ requestClose: vi.fn(), maxHeight: 320 }) : renderPathContent)
            .toBe(secondPathContent);
        expect(firstRenderMachineContent).not.toHaveBeenCalled();
        expect(secondRenderMachineContent).toHaveBeenCalledTimes(1);
        expect(firstRenderResumeContent).not.toHaveBeenCalled();
        expect(secondRenderResumeContent).toHaveBeenCalledTimes(1);
        expect(firstRenderProfileContent).not.toHaveBeenCalled();
        expect(secondRenderProfileContent).toHaveBeenCalledTimes(1);
        expect(firstRenderPathContent).not.toHaveBeenCalled();
        expect(secondRenderPathContent).toHaveBeenCalledTimes(1);

        await hook.unmount();
    });
});
