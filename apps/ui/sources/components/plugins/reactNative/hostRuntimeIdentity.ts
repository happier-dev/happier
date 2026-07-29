import React from 'react';
import { Platform } from 'react-native';

import {
    DaemonReactNativeHostRuntimeIdentityV1Schema,
    type DaemonReactNativeHostRuntimeIdentityV1,
} from '@happier-dev/protocol';

import { readCurrentAppRuntimeInfo } from '@/sync/runtime/readCurrentAppRuntimeInfo';

import { resolveDefaultReactNativeLoaderBackend } from './resolveDefaultReactNativeLoaderBackend';
import { resolveReactNativeWebLoaderCapability } from './reactNativeWebLoaderCapability';

export { resolveReactNativeWebLoaderCapability } from './reactNativeWebLoaderCapability';

/**
 * The minimal readiness shape the identity probe reads from the canonical
 * loader-backend resolution. `available === true` means the native Re.Pack
 * ScriptManager runtime resolved AND the host installed-artifact module loader
 * is wired (see `createRepackScriptManagerBackendFromClient` in `loader.ts`),
 * so both readiness bits are reported together.
 */
type ReactNativeLoaderBackendReadinessProbe = () => Readonly<{ available: boolean }>;

export type ResolveNativeReactNativeHostRuntimeIdentityParams = Readonly<{
    resolveLoaderBackend?: ReactNativeLoaderBackendReadinessProbe;
}>;

/**
 * Source ScriptManager readiness from the real loader-backend probe (PR-13):
 * readiness ORIGINATES here in the UI/native host, never on the daemon. Returns
 * the reported readiness capability only when the probe confirms an integrated
 * runtime; absent/false probes report nothing so the daemon stays fail-closed.
 */
function resolveReportedScriptManagerReadiness(
    resolveLoaderBackend: ReactNativeLoaderBackendReadinessProbe,
): DaemonReactNativeHostRuntimeIdentityV1['scriptManagerRuntime'] | undefined {
    let available = false;
    try {
        available = resolveLoaderBackend().available === true;
    } catch {
        available = false;
    }
    return available
        ? Object.freeze({ integrated: true, installedArtifactLoaderAvailable: true })
        : undefined;
}

type NativeRuntimePlatform = 'android' | 'ios';
type NativeRuntimeChannel = 'development' | 'internal' | 'store';

function readOptionalString(value: unknown): string | null {
    const text = typeof value === 'string' ? value.trim() : '';
    return text ? text : null;
}

function readNativePlatform(value: unknown): NativeRuntimePlatform | null {
    return value === 'android' || value === 'ios' ? value : null;
}

function normalizeNativeChannel(value: unknown): NativeRuntimeChannel | null {
    const rawChannel = readOptionalString(value)?.toLowerCase();
    switch (rawChannel) {
        case 'development':
        case 'internaldev':
            return 'development';
        case 'internal':
        case 'internalpreview':
            return 'internal';
        case 'store':
        case 'production':
        case 'preview':
        case 'dev':
        case 'publicdev':
        case 'stable':
            return 'store';
        default:
            return null;
    }
}

function readReactNativeVersion(): string | null {
    const constants = (Platform as unknown as {
        constants?: {
            reactNativeVersion?: unknown;
        };
    }).constants;
    const version = constants?.reactNativeVersion;
    if (typeof version === 'string') {
        return readOptionalString(version);
    }
    if (!version || typeof version !== 'object') {
        return null;
    }

    const parts = version as Readonly<Record<string, unknown>>;
    const major = typeof parts.major === 'number' ? parts.major : null;
    const minor = typeof parts.minor === 'number' ? parts.minor : null;
    const patch = typeof parts.patch === 'number' ? parts.patch : null;
    if (major === null || minor === null || patch === null) {
        return null;
    }

    const prerelease = readOptionalString(parts.prerelease);
    return prerelease ? `${major}.${minor}.${patch}-${prerelease}` : `${major}.${minor}.${patch}`;
}

function readHermesVersion(): string | null {
    const hermes = (globalThis as Readonly<Record<string, unknown>>).HermesInternal;
    if (!hermes || typeof hermes !== 'object') {
        return null;
    }
    const getRuntimeProperties = (hermes as {
        getRuntimeProperties?: () => Readonly<Record<string, unknown>>;
    }).getRuntimeProperties;
    if (typeof getRuntimeProperties !== 'function') {
        return null;
    }

    try {
        const properties = getRuntimeProperties();
        return readOptionalString(properties['OSS Release Version'])
            ?? readOptionalString(properties['Hermes Release Version'])
            ?? readOptionalString(properties.HermesReleaseVersion)
            ?? readOptionalString(properties.version);
    } catch {
        return null;
    }
}

export function resolveNativeReactNativeHostRuntimeIdentity(
    params?: ResolveNativeReactNativeHostRuntimeIdentityParams,
): DaemonReactNativeHostRuntimeIdentityV1 | null {
    const platform = readNativePlatform(Platform.OS);
    if (!platform) {
        return null;
    }

    const runtimeInfo = readCurrentAppRuntimeInfo();
    const rawUpdateChannel = readOptionalString(runtimeInfo.updateChannel);
    const channel = normalizeNativeChannel(rawUpdateChannel);
    if (!channel) {
        return null;
    }

    const reactVersion = readOptionalString(React.version);
    const reactNativeVersion = readReactNativeVersion();
    const hermesVersion = readHermesVersion();
    const scriptManagerRuntime = resolveReportedScriptManagerReadiness(
        params?.resolveLoaderBackend ?? resolveDefaultReactNativeLoaderBackend,
    );
    const identity = DaemonReactNativeHostRuntimeIdentityV1Schema.safeParse({
        platform,
        channel,
        ...(rawUpdateChannel ? { rawUpdateChannel } : {}),
        ...(runtimeInfo.appVersion ? { appVersion: runtimeInfo.appVersion } : {}),
        ...(runtimeInfo.nativeApplicationVersion
            ? { nativeApplicationVersion: runtimeInfo.nativeApplicationVersion }
            : {}),
        ...(runtimeInfo.nativeBuildVersion ? { nativeBuildVersion: runtimeInfo.nativeBuildVersion } : {}),
        ...(runtimeInfo.applicationId ? { applicationId: runtimeInfo.applicationId } : {}),
        ...(reactVersion ? { reactVersion } : {}),
        ...(reactNativeVersion ? { reactNativeVersion } : {}),
        ...(runtimeInfo.runtimeVersion ? { expoRuntimeVersion: runtimeInfo.runtimeVersion } : {}),
        ...(hermesVersion ? { hermesVersion } : {}),
        availableNativeCapabilities: [],
        ...(scriptManagerRuntime ? { scriptManagerRuntime } : {}),
    });

    return identity.success ? identity.data : null;
}
