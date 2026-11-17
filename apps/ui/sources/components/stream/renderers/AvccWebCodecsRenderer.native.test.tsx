import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit/render/renderScreen';

const bridge = vi.hoisted(() => ({ messages: [] as string[] }));
vi.mock('react-native-webview', async () => {
    const React = await import('react');
    return { WebView: React.forwardRef((props: object, ref) => {
        React.useImperativeHandle(ref, () => ({ postMessage: (message: string) => bridge.messages.push(message) }), []);
        return React.createElement('WebView', props);
    }) };
});

describe('phone AVCC renderer', () => {
    it('bridges decoder output and process failure, reloads, and sends no repeated frame batches', async () => {
        const { AvccWebCodecsRenderer } = await import('./AvccWebCodecsRenderer.native');
        bridge.messages = [];
        const onDecoded = vi.fn();
        const onDiagnostic = vi.fn();
        const onRecoveryRequired = vi.fn();
        const onFailure = vi.fn();
        const chunks = [new Uint8Array([1, 2, 3])];
        const props = { chunks, onDecoded, onDiagnostic, onRecoveryRequired, onFailure, testID: 'phone' };
        const screen = await renderScreen(<AvccWebCodecsRenderer {...props} />);
        const view = () => screen.findByType('WebView');
        const message = (data: unknown) => act(async () => view().props.onMessage({ nativeEvent: { data: JSON.stringify(data) } }));
        expect(bridge.messages).toHaveLength(0);
        await message({ v: 1, type: 'ready', payload: {} });
        expect(bridge.messages.map((value) => JSON.parse(value))).toEqual([{ v: 1, type: 'frames', payload: { chunks: ['AQID'] } }]);
        await act(async () => screen.update(<AvccWebCodecsRenderer {...props} />));
        expect(bridge.messages).toHaveLength(1);
        await act(async () => screen.update(<AvccWebCodecsRenderer {...props} chunks={[new Uint8Array([4])]} />));
        expect(bridge.messages).toHaveLength(2);
        await message({ v: 1, type: 'decoded', payload: {} });
        expect(onDecoded).toHaveBeenCalledOnce();
        await message({ v: 1, type: 'diagnostic', payload: { reasonCode: 'webcodecs_unavailable' } });
        expect(onFailure).toHaveBeenCalledWith({ reasonCode: 'webcodecs_unavailable' });
        await act(async () => view().props.onContentProcessDidTerminate());
        expect(onDiagnostic).toHaveBeenCalledWith(expect.objectContaining({ reasonCode: 'webcodecs_process_terminated' }));
        expect(onRecoveryRequired).toHaveBeenCalledOnce();
        expect(view()).toBeTruthy();
        await act(async () => view().props.onError());
        expect(onFailure).toHaveBeenCalledWith({ reasonCode: 'webcodecs_webview_load_failed' });
        expect(onRecoveryRequired).toHaveBeenCalledOnce();
        await screen.unmount();
        expect(JSON.parse(bridge.messages.at(-1)!)).toEqual({ v: 1, type: 'stop', payload: {} });
    });
});
