import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const postMessageSpy = vi.fn();
let lastWebViewProps: any = null;

vi.mock('react-native', () => ({
    View: 'View',
}));

vi.mock('react-native-webview', () => ({
    WebView: React.forwardRef((props: any, ref: any) => {
        lastWebViewProps = props;
        if (ref) {
            ref.current = {
                postMessage: postMessageSpy,
            };
        }
        return React.createElement('WebView', props, props.children);
    }),
}));

vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({
        theme: {
            dark: true,
            colors: {
                surface: '#000',
                text: '#fff',
                surfaceSelected: '#222',
                divider: '#333',
            },
        },
    }),
}));

import { encodeChunkedEnvelope } from '@/components/ui/webview/bridge/chunkedBridge';

import { XtermWebViewSurface } from './XtermWebViewSurface.native';

function emitEnvelope(envelope: any) {
    if (!lastWebViewProps?.onMessage) throw new Error('WebView onMessage missing');
    lastWebViewProps.onMessage({ nativeEvent: { data: JSON.stringify(envelope) } });
}

function findPostedEnvelopeByType(type: string): any {
    for (const call of postMessageSpy.mock.calls) {
        const raw = call?.[0];
        if (typeof raw !== 'string') continue;
        try {
            const parsed = JSON.parse(raw);
            if (parsed && parsed.type === type) return parsed;
        } catch {
            // ignore
        }
    }
    return null;
}

describe('XtermWebViewSurface (native)', () => {
    it('buffers writes until ready and forwards input/resize', async () => {
        postMessageSpy.mockClear();
        lastWebViewProps = null;

        const onInput = vi.fn();
        const onResize = vi.fn();
        const onReady = vi.fn();
        const ref = React.createRef<any>();

        await act(async () => {
            renderer.create(
                React.createElement(XtermWebViewSurface, {
                    ref,
                    fontSize: 12,
                    lineHeightPx: 18,
                    onInput,
                    onResize,
                    onReady,
                    bridgeMaxChunkBytes: 64_000,
                }),
            );
        });

        expect(ref.current).toBeTruthy();
        expect(typeof ref.current.write).toBe('function');
        expect(typeof ref.current.clear).toBe('function');

        // Buffer write before terminal is ready.
        ref.current.write('hello');
        expect(findPostedEnvelopeByType('write')).toBeNull();

        // Terminal reports ready; host should flush pending writes.
        emitEnvelope({ v: 1, type: 'ready', payload: { cols: 80, rows: 24 } });
        expect(onReady).toHaveBeenCalledWith(80, 24);

        expect(findPostedEnvelopeByType('write')).toEqual(
            expect.objectContaining({
                v: 1,
                type: 'write',
                payload: { data: 'hello' },
            }),
        );

        emitEnvelope({ v: 1, type: 'resize', payload: { cols: 90, rows: 30 } });
        expect(onResize).toHaveBeenCalledWith(90, 30);

        emitEnvelope({ v: 1, type: 'input', payload: { data: 'ls' } });
        expect(onInput).toHaveBeenCalledWith('ls');
    });

    it('decodes chunked incoming messages', async () => {
        postMessageSpy.mockClear();
        lastWebViewProps = null;

        const onInput = vi.fn();
        const onResize = vi.fn();
        const onReady = vi.fn();

        await act(async () => {
            renderer.create(
                React.createElement(XtermWebViewSurface, {
                    fontSize: 12,
                    lineHeightPx: 18,
                    onInput,
                    onResize,
                    onReady,
                    bridgeMaxChunkBytes: 1_000,
                }),
            );
        });

        const chunks = encodeChunkedEnvelope({
            envelope: { v: 1, type: 'input', payload: { data: 'chunked' } },
            maxChunkBytes: 30,
            messageId: 'm-input',
        });

        for (const msg of chunks) {
            emitEnvelope(msg);
        }

        expect(onInput).toHaveBeenCalledWith('chunked');
    });

    it('re-buffers writes after the webview html changes until ready fires again', async () => {
        postMessageSpy.mockClear();
        lastWebViewProps = null;

        const onInput = vi.fn();
        const onResize = vi.fn();
        const onReady = vi.fn();
        const ref = React.createRef<any>();

        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(
                React.createElement(XtermWebViewSurface, {
                    ref,
                    fontSize: 12,
                    lineHeightPx: 18,
                    onInput,
                    onResize,
                    onReady,
                    bridgeMaxChunkBytes: 64_000,
                }),
            );
        });

        emitEnvelope({ v: 1, type: 'ready', payload: { cols: 80, rows: 24 } });
        postMessageSpy.mockClear();

        await act(async () => {
            tree.update(
                React.createElement(XtermWebViewSurface, {
                    ref,
                    fontSize: 14,
                    lineHeightPx: 21,
                    onInput,
                    onResize,
                    onReady,
                    bridgeMaxChunkBytes: 64_000,
                }),
            );
        });

        ref.current.write('after-reload');
        expect(findPostedEnvelopeByType('write')).toBeNull();

        emitEnvelope({ v: 1, type: 'ready', payload: { cols: 80, rows: 24 } });

        expect(findPostedEnvelopeByType('write')).toEqual(
            expect.objectContaining({
                v: 1,
                type: 'write',
                payload: { data: 'after-reload' },
            }),
        );
    });
});
