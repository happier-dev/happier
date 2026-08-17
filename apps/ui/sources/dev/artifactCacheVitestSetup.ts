import { vi } from 'vitest';

vi.mock('expo-constants', () => ({
    default: {
        expoConfig: { extra: {} },
        manifest: null,
        manifest2: null,
    },
}));

vi.mock('expo-updates', () => ({
    channel: null,
    createdAt: null,
    isEmbeddedLaunch: true,
    runtimeVersion: null,
    updateId: null,
}));

vi.mock('expo-application', () => ({
    applicationId: null,
    nativeApplicationVersion: null,
    nativeBuildVersion: null,
}));
