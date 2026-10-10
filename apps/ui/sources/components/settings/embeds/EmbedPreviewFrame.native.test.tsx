import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

import { buildEmbedPreviewReadyEnvelope } from '@/embed/preview/embedPreviewConfiguration';

let lastWebViewProps: Readonly<Record<string, unknown>> | null = null;
const injectJavaScript = vi.fn();

// The platform WebView is the boundary; the app's WebView engine above it is real.
vi.mock('react-native-webview', () => ({
    WebView: React.forwardRef((props: Readonly<Record<string, unknown>>, ref: React.ForwardedRef<unknown>) => {
        lastWebViewProps = props;
        const instance = React.useMemo(() => ({ injectJavaScript }), []);
        if (typeof ref === 'function') ref(instance);
        else if (ref) ref.current = instance;
        return React.createElement('WebView', props);
    }),
}));

vi.mock('@/sync/domains/server/serverConfig', () => ({
    getServerUrl: () => 'https://home.acme.dev',
}));

const identity = { instanceId: 'preview-1', mountNonce: 'nonce-1' };

function injectedEnvelopes(): unknown[] {
    return injectJavaScript.mock.calls.map(([script]) => {
        const match = /var data=("(?:[^"\\]|\\.)*");/.exec(String(script));
        return match ? JSON.parse(JSON.parse(match[1]!)) : null;
    });
}

beforeEach(() => {
    lastWebViewProps = null;
    injectJavaScript.mockReset();
});

beforeAll(async () => { await import('./EmbedLivePreview'); }, 600_000);

describe('native embed preview frame', () => {
    it('uses the real preview bridge for the passive empty-state illustration and surfaces a load failure', async () => {
        const { EmbedLivePreview } = await import('./EmbedLivePreview');
        const screen = await renderScreen(
            <EmbedLivePreview
                presentation="illustration"
                style={{ v: 1, preset: 'tokyoNight', radius: 'round' }}
                ui={{ attachments: false }}
                newChat={false}
            />,
        );
        expect(screen.findAllByTestId('settings-embed-preview-reduce-motion')).toHaveLength(0);
        const source = lastWebViewProps?.source as { uri?: string } | undefined;
        const params = new URL(source!.uri!).searchParams;
        const tileIdentity = { instanceId: params.get('i')!, mountNonce: params.get('n')! };
        const onMessage = lastWebViewProps?.onMessage as (event: unknown) => void;
        await act(async () => {
            onMessage({ nativeEvent: { data: JSON.stringify(buildEmbedPreviewReadyEnvelope(tileIdentity)), url: source!.uri! } });
        });
        expect(injectedEnvelopes().at(-1)).toMatchObject({ payload: { kind: 'configure', style: { preset: 'tokyoNight', radius: 'round' } } });
        const onError = lastWebViewProps?.onError as (event: unknown) => void;
        await act(async () => { onError({ nativeEvent: { description: 'web app unavailable' } }); });
        expect(screen.findAllByTestId('settings-embed-preview-unavailable')).toHaveLength(1);
    });
    it('fills a pushed phone page with the real chat at full width, with no desktop widget chrome (lab P3)', async () => {
        const { EmbedLivePreview } = await import('./EmbedLivePreview');
        const screen = await renderScreen(
            <EmbedLivePreview presentation="page" style={null} ui={{ attachments: true }} newChat={false} />,
        );
        await act(async () => {
            screen.findByTestId('settings-embed-preview')!.props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: 375, height: 640 } } });
        });
        expect(screen.findAllByTestId('settings-embed-preview-width-phone')).toHaveLength(0);
        expect(screen.findAllByTestId('settings-embed-preview-reduce-motion')).toHaveLength(0);
        // The chat is laid out at the page's own width and height, unscaled.
        const frame = screen.root.findAll((node) => typeof node.type === 'string' && node.props.style?.transformOrigin === 'top left');
        expect(frame).toHaveLength(1);
        expect(frame[0]!.props.style).toMatchObject({ width: 375, height: 640, transform: [{ scale: 1 }] });
    });
    it('loads the preview route of this Home\'s web app in the WebView engine and drives it with configure', async () => {
        const { EmbedPreviewFrame } = await import('./EmbedPreviewFrame');
        const render = (radius: 'soft' | 'round') => (
            <EmbedPreviewFrame
                title="Preview"
                path="/embed/preview?i=preview-1&n=nonce-1"
                identity={identity}
                configuration={{ style: { v: 1, radius }, ui: { attachments: false } }}
                frameWidth={390}
                height={560}
                scale={1}
                onUnavailable={() => {}}
            />
        );
        const screen = await renderScreen(render('soft'));

        expect((lastWebViewProps?.source as { uri?: string } | undefined)?.uri).toBe('https://home.acme.dev/embed/preview?i=preview-1&n=nonce-1');

        // The route announces it is listening; the answer is the current configuration.
        const onMessage = lastWebViewProps?.onMessage as (event: unknown) => void;
        await act(async () => {
            onMessage({ nativeEvent: { data: JSON.stringify(buildEmbedPreviewReadyEnvelope(identity)), url: 'https://home.acme.dev/embed/preview' } });
        });
        expect(injectedEnvelopes().at(-1)).toMatchObject({
            direction: 'hostToFrame', identity,
            payload: { kind: 'configure', ui: { attachments: false }, style: { radius: 'soft' } },
        });

        // An edit is pushed to the loaded route without reloading it.
        await act(async () => { await screen.update(render('round')); });
        const last = injectedEnvelopes().at(-1) as { sequence: number; payload: { style: { radius: string } } };
        expect(last.payload.style.radius).toBe('round');
        expect((lastWebViewProps?.source as { uri?: string } | undefined)?.uri).toBe('https://home.acme.dev/embed/preview?i=preview-1&n=nonce-1');
    });
});
