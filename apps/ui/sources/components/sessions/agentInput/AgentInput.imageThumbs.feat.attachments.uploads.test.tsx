// @vitest-environment jsdom
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen as renderPanelScreen } from '@/dev/testkit';
import { storage } from '@/sync/domains/state/storageStore';
import { installSessionPaneRuntimeTestHarness } from '@/components/sessions/panes/sessionPaneRuntimeTestHarness';
import { projectAgentInputAttachmentRowItems, type AgentInputAttachment } from './agentInputContracts';
import { installAgentInputCommonModuleMocks } from './agentInputTestHelpers';
import { ModalPortalTargetProvider } from '@/modal/portal/ModalPortalTarget';

function flattenStyle(style: unknown): Record<string, unknown> {
    if (!style) return {};
    if (Array.isArray(style)) return style.reduce<Record<string, unknown>>((result, entry) => ({ ...result, ...flattenStyle(entry) }), {});
    return typeof style === 'object' ? style as Record<string, unknown> : {};
}
type ModalShowConfig = Parameters<typeof import('@/modal')['Modal']['show']>[0];
const modalShowSpy = vi.fn((_config: ModalShowConfig) => 'modal-1');
installAgentInputCommonModuleMocks({
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({ spies: { show: modalShowSpy } }).module;
    },
});
vi.mock('expo-image', () => ({
    Image: (props: Record<string, unknown>) => React.createElement('Image', props),
}));
vi.mock('expo-linear-gradient', () => ({ LinearGradient: 'LinearGradient' }));
const runtime = installSessionPaneRuntimeTestHarness();
beforeEach(() => {
    modalShowSpy.mockClear();
    storage.setState({ settings: { ...storage.getState().settings, agentInputEnterToSend: true,
        agentInputActionBarLayout: 'wrap', agentInputChipDensity: 'labels',
        sessionPermissionModeApplyTiming: 'immediate' } });
});
async function renderScreen(element: React.ReactElement) {
    return renderPanelScreen(element, { wrapper: runtime.Wrapper });
}

describe('AgentInput (image attachment thumbnails)', () => {
    async function renderAgentInput(attachments: readonly AgentInputAttachment[]) {
        const { AgentInput } = await import('./AgentInput');
        return renderScreen(React.createElement(AgentInput, {
            value: '',
            placeholder: 'placeholder',
            onChangeText: () => { },
            onSend: () => { },
            autocompleteKinds: [],
            autocompleteSuggestions: async () => [],
            attachmentRowItems: projectAgentInputAttachmentRowItems({ transferAttachments: attachments }),
            hasSendableAttachments: true,
        }));
    }

    it('opens a larger preview when an image thumbnail is pressed', async () => {
        const attachments = [
            {
                key: 'a1',
                label: 'file.png',
                status: 'pending',
                preview: { kind: 'image', uri: 'blob:test' },
                onRemove: () => { },
            },
            {
                key: 'a2',
                label: 'second.png',
                status: 'pending',
                preview: { kind: 'image', uri: 'blob:second' },
                onRemove: () => { },
            },
        ] satisfies readonly AgentInputAttachment[];

        modalShowSpy.mockClear();

        const screen = await renderAgentInput(attachments);

        expect(screen.findByTestId('agent-input-attachment-image:a1')).toBeTruthy();
        await screen.pressByTestIdAsync('agent-input-attachment-image:a1');

        expect(modalShowSpy).toHaveBeenCalledTimes(1);
        const modalConfig = modalShowSpy.mock.calls[0]?.[0];
        expect(modalConfig?.component).toBeDefined();
        expect(modalConfig?.props).toEqual(expect.objectContaining({
            initialIndex: 0,
            images: [
                { kind: 'direct', uri: 'blob:test', title: 'file.png' },
                { kind: 'direct', uri: 'blob:second', title: 'second.png' },
            ],
        }));
    }, 120_000);

    it('reuses the current web modal portal target when opening an attachment preview from inside a modal surface', async () => {
        const attachments = [
            {
                key: 'a1',
                label: 'file.png',
                status: 'pending',
                preview: { kind: 'image', uri: 'blob:test' },
                onRemove: () => { },
            },
        ] satisfies readonly AgentInputAttachment[];

        modalShowSpy.mockClear();
        const portalTarget = document.createElement('div');
        const { AgentInput } = await import('./AgentInput');

        const screen = await renderScreen(
            <ModalPortalTargetProvider target={portalTarget}>
                <AgentInput
                    value=""
                    placeholder="placeholder"
                    onChangeText={() => { }}
                    onSend={() => { }}
                    autocompleteKinds={[]}
                    autocompleteSuggestions={async () => []}
                    attachmentRowItems={projectAgentInputAttachmentRowItems({ transferAttachments: attachments })}
                    hasSendableAttachments={true}
                />
            </ModalPortalTargetProvider>,
        );

        await screen.pressByTestIdAsync('agent-input-attachment-image:a1');

        expect(modalShowSpy).toHaveBeenCalledTimes(1);
        const modalConfig = modalShowSpy.mock.calls[0]?.[0];
        expect(modalConfig?.webPortalTarget).toBe(portalTarget);
    });

    it('renders a thumbnail tile for image attachments', async () => {
        const attachments = [
            {
                key: 'a1',
                label: 'file.png',
                status: 'pending',
                preview: { kind: 'image', uri: 'blob:test' },
                onRemove: () => { },
            },
        ] satisfies readonly AgentInputAttachment[];

        const screen = await renderAgentInput(attachments);

        expect(screen.findByTestId('agent-input-attachment-image:a1')).toBeTruthy();
    });

    it('uses button accessibility semantics for attachment image thumbnails', async () => {
        const attachments = [
            {
                key: 'a1',
                label: 'file.png',
                status: 'pending',
                preview: { kind: 'image', uri: 'blob:test' },
                onRemove: () => { },
            },
        ] satisfies readonly AgentInputAttachment[];

        const screen = await renderAgentInput(attachments);

        expect(screen.findByTestId('agent-input-attachment-image:a1')?.props.accessibilityRole).toBe('button');
    });

    it('keeps image removal available while uploading', async () => {
        const onRemove = vi.fn();
        const attachments = [
            {
                key: 'a1',
                label: 'file.png',
                status: 'uploading',
                preview: { kind: 'image', uri: 'blob:test' },
                onRemove,
            },
        ] satisfies readonly AgentInputAttachment[];

        const screen = await renderAgentInput(attachments);

        expect(screen.findByTestId('agent-input-attachment-remove:a1')?.props.disabled).not.toBe(true);
        await screen.pressByTestIdAsync('agent-input-attachment-remove:a1');
        expect(onRemove).toHaveBeenCalledTimes(1);
    });

    it('exposes removable attachments as labelled real target frames', async () => {
        const attachments = [
            {
                key: 'image',
                label: 'image.png',
                status: 'pending',
                preview: { kind: 'image', uri: 'blob:image' },
                onRemove: () => { },
            },
            {
                key: 'file',
                label: 'notes.txt',
                status: 'pending',
                onRemove: () => { },
            },
        ] satisfies readonly AgentInputAttachment[];

        const screen = await renderAgentInput(attachments);

        for (const key of ['image', 'file']) {
            const remove = screen.findByTestId(`agent-input-attachment-remove:${key}`);
            expect(remove?.props.accessibilityRole).toBe('button');
            expect(remove?.props.accessibilityLabel).toBe('common.remove');
            expect(remove?.props.hitSlop).toBeUndefined();
            expect(flattenStyle(remove?.props.style)).toMatchObject({ minHeight: 44, minWidth: 44 });
        }
    });

});
