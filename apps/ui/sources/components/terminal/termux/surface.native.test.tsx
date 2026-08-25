import * as React from 'react';
import { View } from 'react-native';
import renderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { TermuxTerminalSurface } from './surface.native';
import type { EmbeddedTerminalWriteBytesResult } from '@/components/terminal/embedded/embeddedTerminalRendererHandle';

const nativeModuleMock = vi.hoisted(() => ({
    addListener: vi.fn(),
    clearSurface: vi.fn(),
    createSurface: vi.fn(),
    disposeSurface: vi.fn(),
    focusSurface: vi.fn(),
    writeBytes: vi.fn(),
}));
const getOptionalNativeModuleMock = vi.hoisted(() => vi.fn());
const getOptionalNativeViewManagerMock = vi.hoisted(() => vi.fn());
const listeners = vi.hoisted(() => new Map<string, (payload: unknown) => void>());

vi.mock('@happier-dev/terminal-native', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@happier-dev/terminal-native')>();
    return {
        ...actual,
        getOptionalHappierTerminalNativeModule: getOptionalNativeModuleMock,
        getOptionalHappierTerminalNativeViewManager: getOptionalNativeViewManagerMock,
    };
});

describe('TermuxTerminalSurface', () => {
    beforeEach(() => {
        listeners.clear();
        nativeModuleMock.addListener.mockReset();
        nativeModuleMock.addListener.mockImplementation((eventName: string, listener: (payload: unknown) => void) => {
            listeners.set(eventName, listener);
            return {
                remove: vi.fn(() => {
                    listeners.delete(eventName);
                }),
            };
        });
        nativeModuleMock.clearSurface.mockReset();
        nativeModuleMock.createSurface.mockReset();
        nativeModuleMock.createSurface.mockResolvedValue({ available: false, reason: 'accessibility-unproven' });
        nativeModuleMock.disposeSurface.mockReset();
        nativeModuleMock.focusSurface.mockReset();
        nativeModuleMock.writeBytes.mockReset();
        getOptionalNativeModuleMock.mockReset();
        getOptionalNativeViewManagerMock.mockReset();
    });

    it('reports native-module-missing when the Expo module or view manager is unavailable', async () => {
        const onUnavailable = vi.fn();
        const props = {
            surfaceId: 'surface-1',
            fontSize: 14,
            lineHeightPx: 18,
            onInput: vi.fn(),
            onReady: vi.fn(),
            onResize: vi.fn(),
            onUnavailable,
        };
        getOptionalNativeModuleMock.mockReturnValue(null);
        getOptionalNativeViewManagerMock.mockReturnValue(null);
        let root: renderer.ReactTestRenderer | null = null;

        await act(async () => {
            root = renderer.create(<TermuxTerminalSurface {...props} />);
        });

        await act(async () => {
            root?.update(<TermuxTerminalSurface {...props} />);
        });

        expect(onUnavailable).toHaveBeenCalledTimes(1);
        expect(onUnavailable).toHaveBeenCalledWith('native-module-missing');
    });

    it('renders the native view, writes byte frames, and emits embedded-terminal ACKs', async () => {
        const onWriteComplete = vi.fn();
        const NativeView = vi.fn((props: { testID?: string }) => <View testID={props.testID ?? 'termux-native-view'} />);
        nativeModuleMock.createSurface.mockResolvedValue({
            available: true,
            platform: 'android',
            renderer: 'android-termux',
            moduleVersion: '0.0.0',
            accessibility: 'fallback-required',
        });
        nativeModuleMock.writeBytes.mockResolvedValue({ accepted: true, byteOffset: 3 });
        getOptionalNativeModuleMock.mockReturnValue(nativeModuleMock);
        getOptionalNativeViewManagerMock.mockReturnValue(NativeView);
        const ref = React.createRef<React.ElementRef<typeof TermuxTerminalSurface>>();

        await act(async () => {
            renderer.create(
                <TermuxTerminalSurface
                    ref={ref}
                    surfaceId="surface-1"
                    fontSize={14}
                    lineHeightPx={18}
                    onInput={vi.fn()}
                    onReady={vi.fn()}
                    onResize={vi.fn()}
                    onWriteComplete={onWriteComplete}
                />,
            );
        });

        let accepted: EmbeddedTerminalWriteBytesResult | undefined = undefined;
        await act(async () => {
            accepted = ref.current?.writeBytes?.({
                terminalId: 'terminal-1',
                seq: 7,
                byteOffset: 0,
                writeGeneration: 1,
                bytes: new Uint8Array([65, 66, 67]),
            });
            await Promise.resolve();
        });

        expect(accepted).toEqual({ status: 'queued' });
        expect(nativeModuleMock.writeBytes).toHaveBeenCalledWith('surface-1', 'QUJD', 0);
        expect(onWriteComplete).toHaveBeenCalledWith({
            terminalId: 'terminal-1',
            seq: 7,
            byteOffset: 0,
            byteLength: 3,
            ackedByteOffset: 3,
            writeGeneration: 1,
        });
    });

    it('falls back when native surface creation resolves unavailable', async () => {
        const onUnavailable = vi.fn();
        const NativeView = vi.fn((props: { testID?: string }) => <View testID={props.testID ?? 'termux-native-view'} />);
        nativeModuleMock.createSurface.mockResolvedValue({
            available: false,
            reason: 'renderer-unavailable',
            detail: 'Termux renderer failed to create a remote session.',
        });
        getOptionalNativeModuleMock.mockReturnValue(nativeModuleMock);
        getOptionalNativeViewManagerMock.mockReturnValue(NativeView);

        await act(async () => {
            renderer.create(
                <TermuxTerminalSurface
                    surfaceId="surface-1"
                    fontSize={14}
                    lineHeightPx={18}
                    onInput={vi.fn()}
                    onReady={vi.fn()}
                    onResize={vi.fn()}
                    onUnavailable={onUnavailable}
                />,
            );
            await Promise.resolve();
        });

        expect(nativeModuleMock.createSurface).toHaveBeenCalledWith('surface-1');
        expect(onUnavailable).toHaveBeenCalledWith('renderer-unavailable');
    });

    it('routes native input, ready, resize, and writeAck events for the mounted surface', async () => {
        const onInput = vi.fn();
        const onReady = vi.fn();
        const onResize = vi.fn();
        const onWriteAck = vi.fn();
        const onWriteComplete = vi.fn();
        const NativeView = vi.fn((props: { testID?: string }) => <View testID={props.testID ?? 'termux-native-view'} />);
        nativeModuleMock.writeBytes.mockReturnValue(new Promise(() => {}));
        getOptionalNativeModuleMock.mockReturnValue(nativeModuleMock);
        getOptionalNativeViewManagerMock.mockReturnValue(NativeView);
        const ref = React.createRef<React.ElementRef<typeof TermuxTerminalSurface>>();

        await act(async () => {
            renderer.create(
                <TermuxTerminalSurface
                    ref={ref}
                    surfaceId="surface-1"
                    fontSize={14}
                    lineHeightPx={18}
                    onInput={onInput}
                    onReady={onReady}
                    onResize={onResize}
                    onWriteAck={onWriteAck}
                    onWriteComplete={onWriteComplete}
                />,
            );
        });

        await act(async () => {
            ref.current?.writeBytes?.({
                terminalId: 'terminal-1',
                seq: 8,
                byteOffset: 0,
                writeGeneration: 1,
                bytes: new Uint8Array([65, 66, 67, 68]),
            });
            listeners.get('input')?.({ surfaceId: 'surface-1', data: '\u001b[A' });
            listeners.get('surfaceReady')?.({ surfaceId: 'surface-1', cols: 100, rows: 32 });
            listeners.get('resize')?.({ surfaceId: 'surface-1', cols: 101, rows: 33 });
            listeners.get('writeAck')?.({ surfaceId: 'surface-1', byteOffset: 4 });
            await Promise.resolve();
        });

        expect(onInput).toHaveBeenCalledWith('\u001b[A');
        expect(onReady).toHaveBeenCalledWith(100, 32);
        expect(onResize).toHaveBeenCalledWith(101, 33);
        expect(onWriteAck).toHaveBeenCalledWith({ surfaceId: 'surface-1', byteOffset: 4 });
        expect(onWriteComplete).not.toHaveBeenCalled();
    });

    it('ignores stale direct write completions after the native surface changes', async () => {
        const onWriteComplete = vi.fn();
        const NativeView = vi.fn((props: { testID?: string }) => <View testID={props.testID ?? 'termux-native-view'} />);
        let resolveFirstWrite: ((value: unknown) => void) | null = null;
        let resolveSecondWrite: ((value: unknown) => void) | null = null;
        nativeModuleMock.writeBytes
            .mockImplementationOnce(() => new Promise((resolve) => {
                resolveFirstWrite = resolve;
            }))
            .mockImplementationOnce(() => new Promise((resolve) => {
                resolveSecondWrite = resolve;
            }));
        getOptionalNativeModuleMock.mockReturnValue(nativeModuleMock);
        getOptionalNativeViewManagerMock.mockReturnValue(NativeView);
        const ref = React.createRef<React.ElementRef<typeof TermuxTerminalSurface>>();
        let root: renderer.ReactTestRenderer | null = null;

        await act(async () => {
            root = renderer.create(
                <TermuxTerminalSurface
                    ref={ref}
                    surfaceId="surface-1"
                    fontSize={14}
                    lineHeightPx={18}
                    onInput={vi.fn()}
                    onReady={vi.fn()}
                    onResize={vi.fn()}
                    onWriteComplete={onWriteComplete}
                />,
            );
        });

        await act(async () => {
            ref.current?.writeBytes?.({
                terminalId: 'terminal-1',
                seq: 8,
                byteOffset: 0,
                writeGeneration: 1,
                bytes: new Uint8Array([65, 66, 67]),
            });
        });

        await act(async () => {
            root?.update(
                <TermuxTerminalSurface
                    ref={ref}
                    surfaceId="surface-2"
                    fontSize={14}
                    lineHeightPx={18}
                    onInput={vi.fn()}
                    onReady={vi.fn()}
                    onResize={vi.fn()}
                    onWriteComplete={onWriteComplete}
                />,
            );
        });

        await act(async () => {
            ref.current?.writeBytes?.({
                terminalId: 'terminal-1',
                seq: 9,
                byteOffset: 0,
                writeGeneration: 2,
                bytes: new Uint8Array([68, 69, 70]),
            });
        });

        await act(async () => {
            resolveFirstWrite?.({ accepted: true, byteOffset: 3 });
            await Promise.resolve();
        });

        expect(onWriteComplete).not.toHaveBeenCalled();

        await act(async () => {
            resolveSecondWrite?.({ accepted: true, byteOffset: 3 });
            await Promise.resolve();
        });

        expect(onWriteComplete).toHaveBeenCalledTimes(1);
        expect(onWriteComplete).toHaveBeenCalledWith({
            terminalId: 'terminal-1',
            seq: 9,
            byteOffset: 0,
            byteLength: 3,
            ackedByteOffset: 3,
            writeGeneration: 2,
        });
    });

    it('drops pending ACK state when the native write is rejected', async () => {
        const onWriteComplete = vi.fn();
        const NativeView = vi.fn((props: { testID?: string }) => <View testID={props.testID ?? 'termux-native-view'} />);
        nativeModuleMock.writeBytes.mockResolvedValue({ accepted: false, reason: 'renderer-unavailable' });
        getOptionalNativeModuleMock.mockReturnValue(nativeModuleMock);
        getOptionalNativeViewManagerMock.mockReturnValue(NativeView);
        const ref = React.createRef<React.ElementRef<typeof TermuxTerminalSurface>>();

        await act(async () => {
            renderer.create(
                <TermuxTerminalSurface
                    ref={ref}
                    surfaceId="surface-1"
                    fontSize={14}
                    lineHeightPx={18}
                    onInput={vi.fn()}
                    onReady={vi.fn()}
                    onResize={vi.fn()}
                    onWriteComplete={onWriteComplete}
                />,
            );
        });

        await act(async () => {
            ref.current?.writeBytes?.({
                terminalId: 'terminal-1',
                seq: 9,
                byteOffset: 0,
                writeGeneration: 1,
                bytes: new Uint8Array([65, 66, 67]),
            });
            await Promise.resolve();
            listeners.get('writeAck')?.({ surfaceId: 'surface-1', byteOffset: 3 });
        });

        expect(onWriteComplete).toHaveBeenCalledWith({
            terminalId: 'terminal-1',
            seq: 9,
            byteOffset: 0,
            byteLength: 3,
            ackedByteOffset: 0,
            writeGeneration: 1,
        });
    });

    it('attaches the native event sink and sanitizes native title and bell events', async () => {
        const onTitle = vi.fn();
        const onBell = vi.fn();
        const NativeView = vi.fn((props: { testID?: string }) => <View testID={props.testID ?? 'termux-native-view'} />);
        getOptionalNativeModuleMock.mockReturnValue(nativeModuleMock);
        getOptionalNativeViewManagerMock.mockReturnValue(NativeView);

        await act(async () => {
            renderer.create(
                <TermuxTerminalSurface
                    surfaceId="surface-1"
                    fontSize={14}
                    lineHeightPx={18}
                    onInput={vi.fn()}
                    onReady={vi.fn()}
                    onResize={vi.fn()}
                    onTitle={onTitle}
                    onBell={onBell}
                />,
            );
            await Promise.resolve();
        });

        await act(async () => {
            listeners.get('title')?.({ surfaceId: 'surface-1', title: 'build\u0007\u001b[31m' });
            listeners.get('bell')?.({ surfaceId: 'surface-1', label: 'ding\u0007\u001b[31m' });
        });

        expect(nativeModuleMock.createSurface).toHaveBeenCalledWith('surface-1');
        expect(onTitle).toHaveBeenCalledWith({
            surfaceId: 'surface-1',
            title: 'build[31m',
        });
        expect(onBell).toHaveBeenCalledWith({
            surfaceId: 'surface-1',
            label: 'ding[31m',
        });
    });
});
