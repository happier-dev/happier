import * as React from 'react';
import { View } from 'react-native';
import { describe, expect, it, vi } from 'vitest';

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
        sessionPrompt: '',
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
    it('keeps shared popover configs stable while calling the latest render content', async () => {
        const firstContent = React.createElement('Content', { value: 'first' });
        const secondContent = React.createElement('Content', { value: 'second' });
        const firstRenderContent = vi.fn(() => firstContent);
        const secondRenderContent = vi.fn(() => secondContent);
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
                    renderContent: firstRenderContent,
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
                renderContent: secondRenderContent,
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
        const renderedMachine = typeof renderMachineContent === 'function'
            ? renderMachineContent({ requestClose: vi.fn(), maxHeight: 320 })
            : renderMachineContent;
        const renderedResume = typeof renderResumeContent === 'function'
            ? renderResumeContent({ requestClose: vi.fn(), maxHeight: 320 })
            : renderResumeContent;
        const renderedProfile = typeof renderProfileContent === 'function'
            ? renderProfileContent({ requestClose: vi.fn(), maxHeight: 320 })
            : renderProfileContent;
        const renderedPath = typeof renderPathContent === 'function'
            ? renderPathContent({ requestClose: vi.fn(), maxHeight: 320 })
            : renderPathContent;
        expect(renderedMachine).toBe(secondContent);
        expect(renderedResume).toBe(secondResumeContent);
        expect(renderedProfile).toBe(secondProfileContent);
        expect(renderedPath).toBe(secondPathContent);
        expect(firstRenderContent).not.toHaveBeenCalled();
        expect(secondRenderContent).toHaveBeenCalledTimes(1);
        expect(firstRenderResumeContent).not.toHaveBeenCalled();
        expect(secondRenderResumeContent).toHaveBeenCalledTimes(1);
        expect(firstRenderProfileContent).not.toHaveBeenCalled();
        expect(secondRenderProfileContent).toHaveBeenCalledTimes(1);
        expect(firstRenderPathContent).not.toHaveBeenCalled();
        expect(secondRenderPathContent).toHaveBeenCalledTimes(1);

        await hook.unmount();
    });
});
