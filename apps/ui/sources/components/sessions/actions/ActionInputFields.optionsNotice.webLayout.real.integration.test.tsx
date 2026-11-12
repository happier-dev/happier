// @vitest-environment jsdom

import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Text, View } from 'react-native';
import { afterEach, expect, it, vi } from 'vitest';

import { installWebLayoutBridge, measureWebLayout } from '@/dev/testkit/render/measureWebLayout';

vi.mock('react-native', async () => vi.importActual('react-native-web'));
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());

installWebLayoutBridge();

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(async () => {
    await act(async () => root?.unmount());
    root = null;
    host?.remove();
    host = null;
});

const SENTENCE = 'Couldn’t load the choices';

/**
 * A field whose choices failed, in the room a step card's binding leaves it on a phone at a large text size
 * (FIN-QA-LARGETEXT F13: the sentence broke into letters and Retry ran past a 195 px screen).
 */
it('reads a field’s failed-choices line by words and keeps its Retry inside the field', async () => {
    const { HappierInputField, HappierStateLine } = await import('@happier-dev/plugin-ui/presentation');
    const { usePluginUiTheme } = await import('@/components/plugins/surfaces/pluginUiThemeProjection');
    const { useUnistyles } = await import('react-native-unistyles');
    function Field() {
        const { theme } = useUnistyles();
        const presentationTheme = usePluginUiTheme(theme);
        return <HappierInputField field={{ path: 'channels', title: 'Send to', widget: 'select' }} value={undefined}
            options={[]} optionsStatus="failed" theme={presentationTheme} onChange={() => {}} frame="none"
            optionsNotice={<HappierStateLine icon={<View style={{ width: 13, height: 13 }} />}
                action={<View testID="retry" style={{ width: 46, height: 28 }} />}>
                <Text testID="sentence">{SENTENCE}</Text>
            </HappierStateLine>} />;
    }
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => root!.render(<View testID="binding" style={{ width: 96 }}><Field /></View>));
    const layout = await measureWebLayout(host, { viewport: { width: 400, height: 400 }, texts: [SENTENCE], settle: replay => act(replay) });
    const binding = layout.rect('binding');
    const sentence = layout.rect('sentence');
    // Words, not letters: the sentence keeps most of the field's width.
    expect(sentence.width).toBeGreaterThan(binding.width * 0.6);
    expect(sentence.clipped ?? false).toBe(false);
    expect(layout.rect('retry').right).toBeLessThanOrEqual(binding.right + 0.5);
});

it('wraps a failed-choices line’s Details and Retry inside a narrow field', async () => {
    const { HappierInputField } = await import('@happier-dev/plugin-ui/presentation');
    const { usePluginUiTheme } = await import('@/components/plugins/surfaces/pluginUiThemeProjection');
    const { SurfaceStateCard } = await import('@/components/ui/surfaces');
    const { useUnistyles } = await import('react-native-unistyles');
    function Field() {
        const { theme } = useUnistyles();
        const presentationTheme = usePluginUiTheme(theme);
        return <HappierInputField field={{ path: 'channels', title: 'Send to', widget: 'select' }} value={undefined}
            options={[]} optionsStatus="failed" theme={presentationTheme} onChange={() => {}} frame="none"
            optionsNotice={<SurfaceStateCard kind="error" size="line" title={SENTENCE} diagnosticCode="options_unavailable"
                action={{ label: 'Retry', onPress: () => {}, testID: 'retry' }} />} />;
    }
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => root!.render(<View testID="binding" style={{ width: 96 }}><Field /></View>));
    const layout = await measureWebLayout(host, { viewport: { width: 400, height: 400 }, settle: replay => act(replay) });
    expect(layout.rect('retry').right).toBeLessThanOrEqual(layout.rect('binding').right + 0.5);
});
