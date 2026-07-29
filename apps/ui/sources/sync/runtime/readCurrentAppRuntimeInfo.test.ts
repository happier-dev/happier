import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
    vi.resetModules();
    vi.unmock('expo-application');
    vi.unmock('expo-constants');
    vi.unmock('expo-updates');
});

describe('readCurrentAppRuntimeInfo', () => {
    it('reads native and OTA runtime details from Expo modules', async () => {
        vi.doMock('expo-constants', () => ({
            default: {
                expoConfig: {
                    version: '0.2.1',
                    updates: {
                        requestHeaders: {
                            'expo-channel-name': 'production',
                        },
                    },
                },
            },
        }));
        vi.doMock('expo-application', () => ({
            nativeApplicationVersion: '0.2.0',
            nativeBuildVersion: '101',
            applicationId: 'dev.happier.app',
        }));
        vi.doMock('expo-updates', () => ({
            channel: 'production',
            updateId: 'update-123',
            runtimeVersion: '18',
            createdAt: new Date('2026-04-06T12:34:56.000Z'),
            isEmbeddedLaunch: false,
        }));

        const { readCurrentAppRuntimeInfo } = await import('./readCurrentAppRuntimeInfo');

        expect(readCurrentAppRuntimeInfo()).toEqual({
            appVersion: '0.2.1',
            nativeApplicationVersion: '0.2.0',
            nativeBuildVersion: '101',
            applicationId: 'dev.happier.app',
            updateChannel: 'production',
            updateId: 'update-123',
            runtimeVersion: '18',
            updateCreatedAt: '2026-04-06T12:34:56.000Z',
            launchSource: 'ota',
        });
    });

    it('falls back to the configured Expo channel and marks embedded launches', async () => {
        vi.doMock('expo-constants', () => ({
            default: {
                expoConfig: {
                    version: '0.2.1',
                    updates: {
                        requestHeaders: {
                            'expo-channel-name': 'preview',
                        },
                    },
                },
            },
        }));
        vi.doMock('expo-application', () => ({
            nativeApplicationVersion: null,
            nativeBuildVersion: null,
            applicationId: null,
        }));
        vi.doMock('expo-updates', () => ({
            channel: null,
            updateId: null,
            runtimeVersion: null,
            createdAt: null,
            isEmbeddedLaunch: true,
        }));

        const { readCurrentAppRuntimeInfo } = await import('./readCurrentAppRuntimeInfo');

        expect(readCurrentAppRuntimeInfo()).toEqual({
            appVersion: '0.2.1',
            nativeApplicationVersion: null,
            nativeBuildVersion: null,
            applicationId: null,
            updateChannel: 'preview',
            updateId: null,
            runtimeVersion: null,
            updateCreatedAt: null,
            launchSource: 'embedded',
        });
    });

    it('uses the native application version when Expo reports the placeholder app version', async () => {
        vi.doMock('expo-constants', () => ({
            default: {
                expoConfig: {
                    version: '0.0.0',
                    updates: {
                        requestHeaders: {
                            'expo-channel-name': 'development',
                        },
                    },
                },
            },
        }));
        vi.doMock('expo-application', () => ({
            nativeApplicationVersion: '0.2.10',
            nativeBuildVersion: '101',
            applicationId: 'dev.happier.app',
        }));
        vi.doMock('expo-updates', () => ({
            channel: 'development',
            updateId: null,
            runtimeVersion: '0.2.1-native',
            createdAt: null,
            isEmbeddedLaunch: true,
        }));

        const { readCurrentAppRuntimeInfo } = await import('./readCurrentAppRuntimeInfo');

        expect(readCurrentAppRuntimeInfo()).toMatchObject({
            appVersion: '0.2.10',
            nativeApplicationVersion: '0.2.10',
            updateChannel: 'development',
            runtimeVersion: '0.2.1-native',
        });
    });
});
