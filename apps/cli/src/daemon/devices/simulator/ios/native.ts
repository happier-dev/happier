import { createRequire } from 'node:module';

import type { IosSimulatorAdapterHealthV1 } from '@happier-dev/protocol';

import { resolveCliRuntimeAssetPath } from '@/packagedRuntime/assets/resolveCliRuntimeAssetPath';
import { createIosSimulatorUnavailableHealth } from './diagnostics';

type MaybePromise<T> = T | Promise<T>;

/** The ABI of the packaged producer, including its adjacent framework dependency. */
export type IosSimulatorNativeCapture = Readonly<{
    start: () => Promise<void>;
    stop: () => Promise<void>;
    subscribe: (codec: 0 | 1, receive: (data: Buffer, width: number, height: number, flags: number) => void) => Promise<() => MaybePromise<void>>;
    screenSize: () => Promise<Readonly<{ width: number; height: number }>>;
    updateStreamSettings: (mjpegFps: number, mjpegQuality: number, maxDimension: number, h264Fps: number, h264Bitrate: number) => Promise<void>;
}>;

export type IosSimulatorNativeHid = Readonly<{
    touch: (phase: 'begin' | 'move' | 'end', x: number, y: number, width: number, height: number, edge: number) => Promise<void>;
    button: (button: string) => Promise<void>;
    key: (phase: 'down' | 'up', usage: number) => Promise<void>;
}>;

export type IosSimulatorNativeAddon = Readonly<{
    SimCapture: new (udid: string, mjpegFps: number, mjpegQuality: number, maxDimension: number, h264Fps: number, h264Bitrate: number, screenId: number) => IosSimulatorNativeCapture;
    SimHID: new (udid: string) => IosSimulatorNativeHid;
    axTypeKeyboardCharacter: (udid: string, character: string) => Promise<boolean>;
}>;

export const IOS_SIMULATOR_NATIVE_CODECS = ['h264.avcc', 'image.mjpeg'] as const;
export const IOS_SIMULATOR_NATIVE_INPUT_KINDS = ['tap', 'long_press', 'swipe', 'drag', 'keyboard_text', 'keyboard_key', 'hardware_button'] as const;

export type IosSimulatorNativeProducerResolution = Readonly<
    | { ok: true; addon: IosSimulatorNativeAddon; health: Extract<IosSimulatorAdapterHealthV1, { status: 'available' }> }
    | { ok: false; health: Extract<IosSimulatorAdapterHealthV1, { status: 'unavailable' }> }
>;

export function resolveIosSimulatorNativeProducer(input: Readonly<{
    platform?: NodeJS.Platform;
    arch?: string;
    loadAddon?: (path: string) => unknown;
}> = {}): IosSimulatorNativeProducerResolution {
    const unavailable = (code: string, diagnostic: Record<string, unknown> = {}): IosSimulatorNativeProducerResolution => ({
        ok: false,
        health: createIosSimulatorUnavailableHealth({
            reasonCode: code === 'unsupported_host' ? 'unsupported_host' : 'ios_native_producer_unavailable',
            diagnostics: [{ code, ...diagnostic }],
        }) as Extract<IosSimulatorAdapterHealthV1, { status: 'unavailable' }>,
    });
    if ((input.platform ?? process.platform) !== 'darwin' || (input.arch ?? process.arch) !== 'arm64') {
        return unavailable('unsupported_host');
    }
    try {
        const addon: unknown = (input.loadAddon ?? createRequire(import.meta.url))(
            resolveCliRuntimeAssetPath('assets', 'ios', 'producer', 'native', 'serve-sim-native.node'),
        );
        if (!addon || typeof addon !== 'object'
            || !('SimCapture' in addon) || typeof addon.SimCapture !== 'function'
            || !('SimHID' in addon) || typeof addon.SimHID !== 'function'
            || !('axTypeKeyboardCharacter' in addon) || typeof addon.axTypeKeyboardCharacter !== 'function') {
            return unavailable('ios_native_producer_abi_mismatch');
        }
        return {
            ok: true,
            // N-API is an untyped external boundary; the packaged ABI is characterized by native integration QA.
            addon: addon as IosSimulatorNativeAddon,
            health: {
                v: 1, platform: 'ios', status: 'available', usesPrivateFrameworks: true,
                helperDistribution: 'bundled-native', requiredPrivateFrameworks: ['CoreSimulator', 'SimulatorKit'],
                supportedCodecs: [...IOS_SIMULATOR_NATIVE_CODECS], supportedInputKinds: [...IOS_SIMULATOR_NATIVE_INPUT_KINDS],
            },
        };
    } catch (error) {
        return unavailable('ios_native_producer_load_failed', {
            nativeCode: error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : undefined,
            errorName: error instanceof Error ? error.name : 'UnknownError',
        });
    }
}
