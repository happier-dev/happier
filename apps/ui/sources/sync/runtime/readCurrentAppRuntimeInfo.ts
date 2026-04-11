import * as Application from 'expo-application';
import Constants from 'expo-constants';
import * as Updates from 'expo-updates';

export type AppRuntimeLaunchSource = 'embedded' | 'ota' | 'unknown';

export interface CurrentAppRuntimeInfo {
    appVersion: string | null;
    nativeApplicationVersion: string | null;
    nativeBuildVersion: string | null;
    applicationId: string | null;
    updateChannel: string | null;
    updateId: string | null;
    runtimeVersion: string | null;
    updateCreatedAt: string | null;
    launchSource: AppRuntimeLaunchSource;
}

function toTrimmedString(value: unknown): string | null {
    const text = typeof value === 'string' ? value.trim() : '';
    return text ? text : null;
}

function resolveConfiguredUpdateChannel(): string | null {
    const requestHeaders = Constants.expoConfig?.updates?.requestHeaders;
    if (!requestHeaders || typeof requestHeaders !== 'object') {
        return null;
    }

    const expoChannelName = (requestHeaders as Record<string, unknown>)['expo-channel-name'];
    return toTrimmedString(expoChannelName);
}

function resolveLaunchSource(updateId: string | null): AppRuntimeLaunchSource {
    if (Updates.isEmbeddedLaunch === true) {
        return 'embedded';
    }
    if (updateId) {
        return 'ota';
    }
    return 'unknown';
}

export function readCurrentAppRuntimeInfo(): CurrentAppRuntimeInfo {
    const updateId = toTrimmedString(Updates.updateId);
    const createdAt = Updates.createdAt instanceof Date ? Updates.createdAt.toISOString() : null;

    return {
        appVersion: toTrimmedString(Constants.expoConfig?.version),
        nativeApplicationVersion: toTrimmedString(Application.nativeApplicationVersion),
        nativeBuildVersion: toTrimmedString(Application.nativeBuildVersion),
        applicationId: toTrimmedString(Application.applicationId),
        updateChannel: toTrimmedString(Updates.channel) ?? resolveConfiguredUpdateChannel(),
        updateId,
        runtimeVersion: toTrimmedString(Updates.runtimeVersion),
        updateCreatedAt: createdAt,
        launchSource: resolveLaunchSource(updateId),
    };
}
