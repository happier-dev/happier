import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
    vi.resetModules();
    vi.unmock('react-native');
    vi.unmock('expo-application');
    vi.unmock('expo-constants');
    vi.unmock('expo-updates');
});

async function installRuntimeMocks(
    platform: 'ios' | 'android' | 'web',
    updateChannel = 'internal',
    versions: Readonly<{
        expoAppVersion?: string;
        nativeApplicationVersion?: string;
    }> = {},
) {
    vi.doMock('react-native', async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return await createReactNativeWebMock({
            Platform: {
                OS: platform,
                constants: {
                    reactNativeVersion: { major: 0, minor: 83, patch: 4 },
                },
                select: <T,>(options: {
                    ios?: T;
                    android?: T;
                    web?: T;
                    native?: T;
                    default?: T;
                }) => options[platform] ?? options.native ?? options.default ?? options.web,
            },
        });
    });
    vi.doMock('expo-constants', () => ({
        default: {
            expoConfig: {
                version: versions.expoAppVersion ?? '0.2.1',
                updates: {
                    requestHeaders: {
                        'expo-channel-name': updateChannel,
                    },
                },
            },
        },
    }));
    vi.doMock('expo-application', () => ({
        nativeApplicationVersion: versions.nativeApplicationVersion ?? '0.2.0',
        nativeBuildVersion: '101',
        applicationId: platform === 'android' ? 'dev.happier.app.android' : 'dev.happier.app',
    }));
    vi.doMock('expo-updates', () => ({
        channel: updateChannel,
        updateId: null,
        runtimeVersion: 'runtime-55',
        createdAt: null,
        isEmbeddedLaunch: true,
    }));
}

describe('React Native host runtime identity resolver', () => {
    it('resolves source-backed native runtime identity and reports ScriptManager not-integrated by default', async () => {
        await installRuntimeMocks('ios');
        const { resolveNativeReactNativeHostRuntimeIdentity } = await import('./hostRuntimeIdentity');

        const identity = resolveNativeReactNativeHostRuntimeIdentity();

        expect(identity).toMatchObject({
            platform: 'ios',
            channel: 'internal',
            rawUpdateChannel: 'internal',
            appVersion: '0.2.1',
            nativeApplicationVersion: '0.2.0',
            nativeBuildVersion: '101',
            applicationId: 'dev.happier.app',
            reactNativeVersion: '0.83.4',
            expoRuntimeVersion: 'runtime-55',
            availableNativeCapabilities: [],
        });
        // Default probe under the test runtime resolves no native client, so
        // readiness is omitted (fail-closed).
        expect(identity).not.toHaveProperty('scriptManagerRuntime');
    });

    it('reports ScriptManager readiness integrated when the real loader-backend probe is available', async () => {
        await installRuntimeMocks('ios');
        const { resolveNativeReactNativeHostRuntimeIdentity } = await import('./hostRuntimeIdentity');

        const identity = resolveNativeReactNativeHostRuntimeIdentity({
            resolveLoaderBackend: () => ({ available: true }),
        });

        expect(identity?.scriptManagerRuntime).toEqual({
            integrated: true,
            installedArtifactLoaderAvailable: true,
        });
    });

    it('reports the real native app version when Expo exposes the placeholder app version', async () => {
        await installRuntimeMocks('ios', 'development', {
            expoAppVersion: '0.0.0',
            nativeApplicationVersion: '0.2.10',
        });
        const { resolveNativeReactNativeHostRuntimeIdentity } = await import('./hostRuntimeIdentity');

        expect(resolveNativeReactNativeHostRuntimeIdentity({
            resolveLoaderBackend: () => ({ available: true }),
        })).toMatchObject({
            platform: 'ios',
            channel: 'development',
            appVersion: '0.2.10',
            nativeApplicationVersion: '0.2.10',
        });
    });

    it('omits ScriptManager readiness when the loader-backend probe reports unavailable', async () => {
        await installRuntimeMocks('ios');
        const { resolveNativeReactNativeHostRuntimeIdentity } = await import('./hostRuntimeIdentity');

        const identity = resolveNativeReactNativeHostRuntimeIdentity({
            resolveLoaderBackend: () => ({ available: false }),
        });

        expect(identity).not.toHaveProperty('scriptManagerRuntime');
    });

    it('stays fail-closed when the loader-backend probe throws', async () => {
        await installRuntimeMocks('ios');
        const { resolveNativeReactNativeHostRuntimeIdentity } = await import('./hostRuntimeIdentity');

        const identity = resolveNativeReactNativeHostRuntimeIdentity({
            resolveLoaderBackend: () => {
                throw new Error('probe boom');
            },
        });

        expect(identity).not.toBeNull();
        expect(identity).not.toHaveProperty('scriptManagerRuntime');
    });

    it.each([
        ['production', 'store'],
        ['preview', 'store'],
        ['dev', 'store'],
        ['internalpreview', 'internal'],
        ['internaldev', 'development'],
    ] as const)('normalizes Expo update channel %s to plugin UI channel %s', async (
        updateChannel,
        expectedChannel,
    ) => {
        await installRuntimeMocks('android', updateChannel);
        const { resolveNativeReactNativeHostRuntimeIdentity } = await import('./hostRuntimeIdentity');

        expect(resolveNativeReactNativeHostRuntimeIdentity()).toMatchObject({
            platform: 'android',
            channel: expectedChannel,
            rawUpdateChannel: updateChannel,
        });
    });

    it('returns null outside native iOS and Android runtimes', async () => {
        await installRuntimeMocks('web');
        const { resolveNativeReactNativeHostRuntimeIdentity } = await import('./hostRuntimeIdentity');

        expect(resolveNativeReactNativeHostRuntimeIdentity()).toBeNull();
    });
});
