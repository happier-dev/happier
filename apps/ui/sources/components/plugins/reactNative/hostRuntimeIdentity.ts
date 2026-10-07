import { Platform } from 'react-native';

import {
    DaemonReactNativeHostRuntimeIdentityV1Schema,
    type DaemonReactNativeHostRuntimeIdentityV1,
} from '@happier-dev/protocol/daemon/contributionRegistryProjection';

import { readCurrentAppRuntimeInfo } from '@/sync/runtime/readCurrentAppRuntimeInfo';


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

export function resolveNativeReactNativeHostRuntimeIdentity(
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
    });

    return identity.success ? identity.data : null;
}
