import { createHash, getHashes, randomFillSync } from 'node:crypto';
import * as React from 'react';
import type { NativeComposerInputHandle } from '@/components/ui/forms/nativeComposerInput';
import { happierCryptoWorkerStub } from './happierCryptoWorkerStub';

// Vitest runs in a Node environment; `expo-modules-core` is designed for Expo/Metro and
// imports `react-native` (Flow) via its TS source entrypoint. For unit tests we only need
// a minimal subset of the surface area used by other Expo packages (e.g. `expo-localization`).

export const Platform = {
    // Match the shape used by `expo-localization` on web/Node.
    isDOMAvailable: typeof window !== 'undefined' && typeof document !== 'undefined',
    OS: 'node',
    select: <T,>(specifics: Record<string, T> & { default?: T }) =>
        (specifics as any).node ?? (specifics as any).default,
} as const;

export enum PermissionStatus {
    GRANTED = 'granted',
    UNDETERMINED = 'undetermined',
    DENIED = 'denied',
}

export class NativeModule<TEvents = unknown> {
    addListener(_eventName: keyof TEvents | string, _listener: (...args: unknown[]) => void): { remove: () => void } {
        return {
            remove: () => undefined,
        };
    }

    removeListeners(_count: number): void {}
}

const optionalNativeModules = new Map<string, object>();

/** Replace one genuinely native SDK module, including Metro call-time lookup. */
export function installOptionalNativeModuleForTests(moduleName: string, module: object): () => void {
    const previous = optionalNativeModules.get(moduleName);
    optionalNativeModules.set(moduleName, module);
    return () => {
        if (optionalNativeModules.get(moduleName) !== module) return;
        if (previous) optionalNativeModules.set(moduleName, previous);
        else optionalNativeModules.delete(moduleName);
    };
}

// Native SDK lookup is opaque; the importing SDK supplies its external module type.
export function requireOptionalNativeModule<T extends object = Record<string, unknown>>(moduleName?: string): T | null {
    return (moduleName ? optionalNativeModules.get(moduleName) as T | undefined : undefined) ?? null;
}

function digestBytes(algorithm: string, data: BufferSource): Uint8Array<ArrayBuffer> {
    const normalized = algorithm.replaceAll('-', '').toLowerCase();
    if (!getHashes().includes(normalized)) {
        throw new DOMException('Unrecognized algorithm name', 'NotSupportedError');
    }
    const bytes = ArrayBuffer.isView(data)
        ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
        : new Uint8Array(data);
    return new Uint8Array(createHash(normalized).update(bytes).digest());
}

const expoCryptoModule = {
    getRandomValues(bytes: Uint8Array): void {
        randomFillSync(bytes);
    },
    digest(algorithm: string, output: Uint8Array, data: BufferSource): void {
        output.set(digestBytes(algorithm, data));
    },
    async digestAsync(algorithm: string, data: BufferSource): Promise<ArrayBuffer> {
        return digestBytes(algorithm, data).buffer;
    },
};

export function requireNativeModule<T = never>(moduleName: string): T {
    if (moduleName === 'ExpoCrypto') return expoCryptoModule as T;
    if (optionalNativeModules.has(moduleName)) return optionalNativeModules.get(moduleName) as T;
    if (moduleName === 'HappierCryptoWorker') return happierCryptoWorkerStub as T;
    return {} as T;
}

/** Native view registration is an OS boundary; renderer tests keep its public host props and ref. */
export function requireNativeViewManager<P extends object>(moduleName: string): React.ComponentType<P> {
    if (moduleName === 'HappierComposerInput') {
        return React.forwardRef<NativeComposerInputHandle, P>((props, ref) => {
            const hostRef = React.useRef<Partial<NativeComposerInputHandle> | null>(null);
            // Expo adds the module's commands to the native view ref. Generic renderer
            // node mocks supply only host methods; explicit native command doubles win.
            React.useImperativeHandle(ref, () => ({
                focus: () => undefined,
                blur: () => undefined,
                setTextAndSelection: () => undefined,
                setSelection: () => undefined,
                offsetAtPoint: async () => null,
                setDropCaret: () => undefined,
                measureInWindow: callback => callback(0, 0, 0, 0),
                ...hostRef.current,
            }));
            return React.createElement(moduleName, { ...props, ref: hostRef });
        }) as unknown as React.ComponentType<P>;
    }
    return moduleName as unknown as React.ComponentType<P>;
}

export default {
    NativeModule,
    Platform,
    requireOptionalNativeModule,
    requireNativeModule,
    requireNativeViewManager,
};
