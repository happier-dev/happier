import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { PluginNativeArtifactResourceRegistrar } from './nativeArtifactResource';

const nativeModuleMock = vi.hoisted(() => ({
    requireNativeModule: vi.fn(),
}));
const platformState = vi.hoisted(() => ({
    os: 'android' as 'android' | 'ios',
}));

vi.mock('expo-modules-core', () => ({
    requireNativeModule: nativeModuleMock.requireNativeModule,
}));
vi.mock('react-native', () => ({
    Platform: {
        get OS() {
            return platformState.os;
        },
    },
}));

const registration = {
    token: 'hpat_test_token',
    storagePartitionId: `hpa_${'a'.repeat(64)}`,
    storageLocator: {
        namespace: 'happier-plugin-ui-artifacts-v1',
        accountKeyHash: 'b'.repeat(64),
        artifactKeyHash: 'c'.repeat(64),
    },
    resources: [],
    policyTable: { version: 1, routes: [] },
} satisfies Parameters<PluginNativeArtifactResourceRegistrar['register']>[0];

const registered = Object.freeze({ kind: 'registered' as const });
const registrationFailed = Object.freeze({
    kind: 'unavailable' as const,
    code: 'native_artifact_resource_registration_failed' as const,
});
const profileIsolationUnavailable = Object.freeze({
    kind: 'unavailable' as const,
    code: 'hosted_web_profile_isolation_unavailable' as const,
    capability: 'MULTI_PROFILE' as const,
});
const documentStartScriptUnavailable = Object.freeze({
    kind: 'unavailable' as const,
    code: 'hosted_web_profile_isolation_unavailable' as const,
    capability: 'DOCUMENT_START_SCRIPT' as const,
});
const webMessageListenerUnavailable = Object.freeze({
    kind: 'unavailable' as const,
    code: 'hosted_web_profile_isolation_unavailable' as const,
    capability: 'WEB_MESSAGE_LISTENER' as const,
});

describe('Expo native Artifact registrar', () => {
    beforeEach(() => {
        vi.resetModules();
        nativeModuleMock.requireNativeModule.mockReset();
        platformState.os = 'android';
    });

    it('fails closed when the packaged native registrar is unavailable', async () => {
        nativeModuleMock.requireNativeModule.mockImplementationOnce(() => {
            throw new Error('native module unavailable');
        });
        const { createExpoPluginNativeArtifactResourceRegistrar } = await import('./nativeArtifactResourceRegistrar.native');
        const registrar = createExpoPluginNativeArtifactResourceRegistrar();

        await expect(registrar.register(registration)).resolves.toEqual(registrationFailed);
        expect(registrar.unregister(registration.token)).toBe(false);
    });

    it('accepts the incumbent legacy true acknowledgement only from the iOS module', async () => {
        platformState.os = 'ios';
        const registerArtifact = vi.fn(async () => true);
        const unregisterArtifact = vi.fn(() => true);
        nativeModuleMock.requireNativeModule.mockReturnValueOnce({ registerArtifact, unregisterArtifact });
        const { createExpoPluginNativeArtifactResourceRegistrar } = await import('./nativeArtifactResourceRegistrar.native');
        const registrar = createExpoPluginNativeArtifactResourceRegistrar();

        await expect(registrar.register(registration)).resolves.toEqual(registered);
        expect(registerArtifact).toHaveBeenCalledExactlyOnceWith(registration);
        expect(registrar.unregister(registration.token)).toBe(true);
        expect(unregisterArtifact).toHaveBeenCalledExactlyOnceWith(registration.token);
    });

    it('rejects a legacy true acknowledgement from Android', async () => {
        nativeModuleMock.requireNativeModule.mockReturnValueOnce({
            registerArtifact: async () => true,
            unregisterArtifact: () => true,
        });
        const { createExpoPluginNativeArtifactResourceRegistrar } = await import('./nativeArtifactResourceRegistrar.native');
        const registrar = createExpoPluginNativeArtifactResourceRegistrar();

        await expect(registrar.register(registration)).resolves.toEqual(registrationFailed);
    });

    it('does not mistake an asynchronous or truthy teardown result for the required synchronous tombstone acknowledgement', async () => {
        nativeModuleMock.requireNativeModule.mockReturnValueOnce({
            registerArtifact: async () => ({ accepted: true }),
            unregisterArtifact: () => Promise.resolve(true),
        });
        const { createExpoPluginNativeArtifactResourceRegistrar } = await import('./nativeArtifactResourceRegistrar.native');
        const registrar = createExpoPluginNativeArtifactResourceRegistrar();

        await expect(registrar.register(registration)).resolves.toEqual(registrationFailed);
        expect(registrar.unregister(registration.token)).toBe(false);
    });

    it('preserves each factual Android profile-isolation capability through the native registrar boundary', async () => {
        const registerArtifact = vi.fn()
            .mockResolvedValueOnce(profileIsolationUnavailable)
            .mockResolvedValueOnce(documentStartScriptUnavailable)
            .mockResolvedValueOnce(webMessageListenerUnavailable);
        nativeModuleMock.requireNativeModule.mockReturnValueOnce({
            registerArtifact,
            unregisterArtifact: () => true,
        });
        const { createExpoPluginNativeArtifactResourceRegistrar } = await import('./nativeArtifactResourceRegistrar.native');
        const registrar = createExpoPluginNativeArtifactResourceRegistrar();

        await expect(registrar.register(registration)).resolves.toEqual(profileIsolationUnavailable);
        await expect(registrar.register(registration)).resolves.toEqual(documentStartScriptUnavailable);
        await expect(registrar.register(registration)).resolves.toEqual(webMessageListenerUnavailable);
        expect(registerArtifact).toHaveBeenCalledTimes(3);
        expect(registerArtifact).toHaveBeenNthCalledWith(1, registration);
        expect(registerArtifact).toHaveBeenNthCalledWith(2, registration);
        expect(registerArtifact).toHaveBeenNthCalledWith(3, registration);
    });

    it('rejects an Android profile-isolation map that omits the factual capability', async () => {
        nativeModuleMock.requireNativeModule.mockReturnValueOnce({
            registerArtifact: async () => ({
                kind: 'unavailable',
                code: 'hosted_web_profile_isolation_unavailable',
            }),
            unregisterArtifact: () => true,
        });
        const { createExpoPluginNativeArtifactResourceRegistrar } = await import('./nativeArtifactResourceRegistrar.native');
        const registrar = createExpoPluginNativeArtifactResourceRegistrar();

        await expect(registrar.register(registration)).resolves.toEqual(registrationFailed);
    });
});
