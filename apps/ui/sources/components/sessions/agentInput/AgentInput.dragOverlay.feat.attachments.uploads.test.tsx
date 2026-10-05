/** @vitest-environment jsdom */
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { flattenTestStyle } from '@/dev/testkit';
// Collect the real owner graph before the interaction timeout starts.
import { AgentInput } from './AgentInput';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type HostProps = Readonly<{
    children?: React.ReactNode;
    style?: unknown;
    testID?: string;
    accessibilityLabel?: string;
    onPress?: unknown;
}>;

/** The React Native browser host is the boundary, not the composer or its policies. */
function domHost(tag: 'div' | 'span' | 'button') {
    return React.forwardRef<HTMLElement, HostProps>(function BrowserHost(props, ref) {
        const htmlProps: Record<string, unknown> = {
            ref,
            style: flattenTestStyle(props.style),
            'data-testid': props.testID,
            'aria-label': props.accessibilityLabel,
            onClick: props.onPress,
        };
        for (const [key, value] of Object.entries(props)) {
            if (key.startsWith('data-') || key.startsWith('aria-')) htmlProps[key] = value;
        }
        if (tag === 'button') htmlProps.type = 'button';
        return React.createElement(tag, htmlProps, props.children);
    });
}

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    const View = domHost('div');
    return createReactNativeWebMock({
        View,
        ScrollView: View,
        Text: domHost('span'),
        Pressable: domHost('button'),
        useWindowDimensions: () => ({ width: 800, height: 600 }),
        Dimensions: { get: () => ({ width: 800, height: 600, scale: 1, fontScale: 1 }) },
    });
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('react-native-reanimated', async () => {
    const { createReanimatedModuleMock } = await import('@/dev/testkit/mocks/reanimated');
    const { View, Text, ScrollView } = await import('react-native');
    const mock = createReanimatedModuleMock();
    return { ...mock, default: { ...mock.default, View, Text, ScrollView } };
});

vi.mock('@expo/vector-icons', async () => {
    const { createExpoVectorIconsMock } = await import('@/dev/testkit/mocks/icons');
    const Icon = domHost('span');
    return Object.fromEntries(Object.keys(createExpoVectorIconsMock()).map(name => [name, Icon]));
});

vi.mock('expo-linear-gradient', async () => ({ LinearGradient: (await import('react-native')).View }));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), canGoBack: () => false }) }));

// Vitest's default suffix resolution is native; retain the actual browser implementations.
vi.mock('@/components/ui/forms/MultiTextInput', async () => await import('@/components/ui/forms/MultiTextInput.web'));
vi.mock('@/hooks/ui/useWebFileDropZone', async () => await import('@/hooks/ui/useWebFileDropZone.web'));
vi.unmock('color');

const mounted: Array<{ root: ReturnType<typeof createRoot>; container: HTMLElement }> = [];

afterEach(async () => {
    await act(async () => {
        for (const { root } of mounted) root.unmount();
    });
    for (const { container } of mounted) container.remove();
    mounted.length = 0;
});

function createFileDragEvent(type: string, files: readonly File[] = [], point = { x: 0, y: 0 }): Event {
    const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: point.x, clientY: point.y });
    Object.defineProperty(event, 'dataTransfer', {
        value: { files, items: files.map(file => ({ kind: 'file', getAsFile: () => file })), types: ['Files'] },
    });
    return event;
}

async function renderAgentInput(onAttachmentsAdded: (files: readonly File[]) => void) {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    mounted.push({ root, container });
    await act(async () => {
        root.render(<AgentInput value="" placeholder="placeholder" onChangeText={() => {}} onSend={() => {}}
            autocompleteKinds={[]} autocompleteSuggestions={async () => []}
            onAttachmentsAdded={onAttachmentsAdded} hasSendableAttachments={false} />);
    });
    const input = container.querySelector<HTMLTextAreaElement>('[data-testid="new-session-composer-input"]');
    const material = container.querySelector<HTMLElement>('[data-testid="agent-input-material-surface"]');
    if (!input || !material?.parentElement) throw new Error('Composer input and material surface must render');
    // The enclosing drop host includes the panel rim, outside the textarea and material children.
    return { container, dropSurface: material.parentElement };
}

describe('AgentInput (attachments drag overlay)', () => {
    it('shows Attach beside the pointer and retires it on Escape without changing the draft', async () => {
        const rendered = await renderAgentInput(() => {});
        await act(async () => { rendered.dropSurface.dispatchEvent(createFileDragEvent('dragenter', [], { x: 96, y: 128 })); });
        const overlay = document.querySelector<HTMLElement>('[data-testid="agent-input-drop-overlay"]');
        expect(overlay).not.toBeNull();
        expect(getComputedStyle(overlay!).position).toBe('fixed');
        expect(parseFloat(getComputedStyle(overlay!).left)).toBeGreaterThan(96);
        expect(parseFloat(getComputedStyle(overlay!).top)).toBeGreaterThan(128);
        await act(async () => { rendered.dropSurface.dispatchEvent(createFileDragEvent('dragover', [], { x: 240, y: 320 })); });
        expect(parseFloat(getComputedStyle(overlay!).left)).toBeGreaterThan(240);
        expect(parseFloat(getComputedStyle(overlay!).top)).toBeGreaterThan(320);
        await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); });
        expect(document.querySelector('[data-testid="agent-input-drop-overlay"]')).toBeNull();
        expect(rendered.container.querySelector<HTMLTextAreaElement>('[data-testid="new-session-composer-input"]')?.value).toBe('');
    });

    it('adds attachments dropped on the enclosing panel outside the textarea', async () => {
        const onAttachmentsAdded = vi.fn();
        const rendered = await renderAgentInput(onAttachmentsAdded);
        const file = new File([new Uint8Array([1, 2, 3])], 'photo.png', { type: 'image/png' });
        await act(async () => {
            rendered.dropSurface.dispatchEvent(createFileDragEvent('dragenter', [file]));
            rendered.dropSurface.dispatchEvent(createFileDragEvent('dragover', [file]));
            rendered.dropSurface.dispatchEvent(createFileDragEvent('drop', [file]));
        });
        expect(onAttachmentsAdded).toHaveBeenCalledWith([file]);
    });

    it('uses DataTransfer item files when the dropped FileList is empty', async () => {
        const onAttachmentsAdded = vi.fn();
        const rendered = await renderAgentInput(onAttachmentsAdded);
        const file = new File([new Uint8Array([1, 2, 3])], 'photo.png', { type: 'image/png' });
        const event = new Event('drop', { bubbles: true, cancelable: true });
        Object.defineProperty(event, 'dataTransfer', {
            value: { files: [], items: [{ kind: 'file', getAsFile: () => file }], types: ['Files'] },
        });
        await act(async () => { rendered.dropSurface.dispatchEvent(event); });
        expect(onAttachmentsAdded).toHaveBeenCalledWith([file]);
    });
});
