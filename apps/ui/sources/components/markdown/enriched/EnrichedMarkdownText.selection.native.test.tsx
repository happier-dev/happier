import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { activateStorageAccountScope } from '@/dev/testkit/runtime/storageRuntime';
import { NATIVE_REFERENCE_CHIP_ANATOMY } from '@/components/ui/forms/multiTextInputTypography';

const navigation = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit');
    return createExpoRouterMock({ router: { push: navigation.push } }).module;
});

vi.mock('react-native', async () => {
    const { createReactNativeNativeMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeNativeMock({ platformOS: 'ios' });
});
// Only the two native view carriers are replaced. Exercise the installed JS
// wrapper and app adapter, not the default whole-package Markdown boundary stub.
vi.mock('react-native-enriched-markdown/src/EnrichedMarkdownTextNativeComponent.ts', () => ({ default: 'NativeMarkdownText' }));
vi.mock('react-native-enriched-markdown/src/EnrichedMarkdownNativeComponent.ts', () => ({ default: 'NativeGithubMarkdown' }));
vi.mock('react-native-enriched-markdown', async () => await vi.importActual<typeof import('react-native-enriched-markdown')>(
    'react-native-enriched-markdown/src/native/EnrichedMarkdownText',
));
vi.unmock('@/components/ui/icons/Icon');

const { EnrichedMarkdownTextAdapter } = await import('./EnrichedMarkdownTextAdapter');
const { ArtifactPassageSelection } = await import('@/components/artifacts/ArtifactPassageSelection');
const { resetSessionDraftRepositoryForTests } = await import('@/sync/ops/sessionDrafts/sessionDraftRepository');
let home: Awaited<ReturnType<typeof activateStorageAccountScope>> | null = null;
afterEach(() => { standardCleanup(); home?.dispose(); home = null; navigation.push.mockClear(); resetSessionDraftRepositoryForTests(); });

describe('installed enriched native selection carrier', () => {
    it('paints a review citation label with readable ink in the native chip', async () => {
        const reference = {
            label: 'High · Codex', severity: 'high' as const,
            foreground: '#a57272', textForeground: '#732525', background: '#f9edee',
        };
        const screen = await renderScreen(<EnrichedMarkdownTextAdapter
            markdown="See [finding](finding:run:f1)."
            profile="default" selectable streamingAnimated={false} agentTexMath={false}
            inlineReferences={{ scheme: 'finding', resolve: () => reference }} />);
        const native = screen.findByType('NativeMarkdownText');
        const chips = JSON.parse(native.props.markdownStyle.link.referenceChips);
        expect(chips.references['happier-ref:finding:run:f1']).toMatchObject({
            label: 'High · Codex', foreground: 0xff732525,
        });
    });

    it('passes bound chip presentation through the installed native style carrier and retains destination presses', async () => {
        const onPress = vi.fn();
        const picture = { label: 'Image #2', glyph: 'preview' as const, thumbnail: { uri: 'file:///preview.png' }, foreground: '#112233', background: '#11223312' };
        const screen = await renderScreen(<EnrichedMarkdownTextAdapter
            markdown="See [old](happier-ref:attachment:picture) and [unbound](happier-ref:session:missing)."
            profile="default" selectable streamingAnimated={false} agentTexMath={false}
            inlineReferences={{ resolve: (ref) => ref === 'attachment:picture' ? picture : null, onPress }} />);
        const native = screen.findByType('NativeMarkdownText');
        const chips = JSON.parse(native.props.markdownStyle.link.referenceChips);
        expect(chips.references['happier-ref:attachment:picture']).toMatchObject({
            label: 'Image #2', thumbnail: 'file:///preview.png', foreground: 0xff112233,
        });
        expect(Object.keys(chips.references)).toEqual(['happier-ref:attachment:picture']);
        expect(native.props.markdown).toBe('See [Image #2](happier-ref:attachment:picture) and unbound.');
        await act(async () => native.props.onLinkPress({ nativeEvent: { url: 'happier-ref:attachment:picture' } }));
        expect(onPress).toHaveBeenCalledWith('attachment:picture');
        const { storage } = await import('@/sync/domains/state/storage');
        const previousSettings = storage.getState().localSettings;
        try {
            await act(async () => storage.setState({ localSettings: { ...previousSettings, uiFontScale: 1.25 } }));
            expect(JSON.parse(screen.findByType('NativeMarkdownText').props.markdownStyle.link.referenceChips).anatomy.height)
                .toBe(NATIVE_REFERENCE_CHIP_ANATOMY.height * 1.25);
        } finally {
            await act(async () => storage.setState({ localSettings: previousSettings }));
        }
        await act(async () => screen.update(<EnrichedMarkdownTextAdapter markdown="Plain [site](https://example.com)" profile="default"
            selectable streamingAnimated={false} agentTexMath={false} />));
        expect(JSON.parse(screen.findByType('NativeMarkdownText').props.markdownStyle.link.referenceChips).references).toEqual({});
    });

    it('preserves actual rendered text and UTF-16 selection through the real dependency wrapper and app adapter', async () => {
        const selected = vi.fn();
        const screen = await renderScreen(<EnrichedMarkdownTextAdapter markdown="😀 **same**. 😀 **same**." profile="default"
            selectable streamingAnimated={false} agentTexMath={false} contextMenuItems={[{ text: 'Comment', onPress: selected }]} />);
        const renderedText = '\n😀 same. 😀 same.\n';
        const start = renderedText.lastIndexOf('same');
        await act(async () => screen.findByType('NativeMarkdownText').props.onContextMenuItemPress({ nativeEvent: {
            itemText: 'Comment', selectedText: 'same', sourceMarkdown: '😀 **same**. 😀 **same**.', renderedText, selectionStart: start, selectionEnd: start + 4,
        } }));
        expect(selected).toHaveBeenCalledWith({ text: 'same', renderedText, selection: { start, end: start + 4 } });
    });

    it('withholds mapping evidence from a held old native menu snapshot while preserving its text callback', async () => {
        const selected = vi.fn();
        const original = 'same. same.';
        const current = 'same.';
        const props = { profile: 'default' as const, selectable: true, streamingAnimated: false, agentTexMath: false,
            contextMenuItems: [{ text: 'Comment', onPress: selected }] };
        const screen = await renderScreen(<EnrichedMarkdownTextAdapter {...props} markdown={original} />);
        await act(async () => screen.update(<EnrichedMarkdownTextAdapter {...props} markdown={current} />));
        await act(async () => screen.findByType('NativeMarkdownText').props.onContextMenuItemPress({ nativeEvent: {
            itemText: 'Comment', selectedText: 'same', sourceMarkdown: original,
            renderedText: '\nsame. same.\n', selectionStart: 1, selectionEnd: 5,
        } }));
        expect(selected).toHaveBeenCalledWith({ text: 'same', selection: { start: 1, end: 5 } });
    });

    it('does not retarget a held native menu to a different Doc with identical Markdown', async () => {
        home = await activateStorageAccountScope({ serverId: 'home', accountId: 'alice' });
        const markdown = 'same. same.';
        const revision = { headerVersion: 1, bodyVersion: 1 };
        const screen = await renderScreen(<ArtifactPassageSelection artifactId="original" markdown={markdown} revision={revision} />);
        const native = screen.findByType('NativeMarkdownText');
        const held = native.props.onContextMenuItemPress;
        const event = { nativeEvent: { itemText: native.props.contextMenuItems[0].text, selectedText: 'same', sourceMarkdown: markdown,
            renderedText: '\nsame. same.\n', selectionStart: 1, selectionEnd: 5 } };
        await act(async () => held(event));
        expect(navigation.push).toHaveBeenCalledTimes(1);
        navigation.push.mockClear();
        await act(async () => screen.update(<ArtifactPassageSelection artifactId="different" markdown={markdown} revision={revision} />));
        await act(async () => held(event));
        expect(navigation.push).not.toHaveBeenCalled();
        await act(async () => screen.update(<ArtifactPassageSelection artifactId="original" markdown={markdown} revision={revision} />));
        await act(async () => held(event));
        expect(navigation.push).not.toHaveBeenCalled();
    });

    it('preserves a legacy text-only native selection callback without publishing a Doc passage', async () => {
        const selected = vi.fn();
        const screen = await renderScreen(<EnrichedMarkdownTextAdapter markdown="same." profile="default"
            selectable streamingAnimated={false} agentTexMath={false} contextMenuItems={[{ text: 'Comment', onPress: selected }]} />);
        const legacy = { itemText: 'Comment', selectedText: 'same', selectionStart: 0, selectionEnd: 4 };
        await act(async () => screen.findByType('NativeMarkdownText').props.onContextMenuItemPress({ nativeEvent: legacy }));
        expect(selected).toHaveBeenCalledWith({ text: 'same', selection: { start: 0, end: 4 } });

        home = await activateStorageAccountScope({ serverId: 'home', accountId: 'alice' });
        await act(async () => screen.update(<ArtifactPassageSelection artifactId="original" markdown="same." revision={{ headerVersion: 1, bodyVersion: 1 }} />));
        const native = screen.findByType('NativeMarkdownText');
        await act(async () => native.props.onContextMenuItemPress({ nativeEvent: { ...legacy, itemText: native.props.contextMenuItems[0].text } }));
        expect(navigation.push).not.toHaveBeenCalled();
    });
});
