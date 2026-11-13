import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readActionOutputDiagnostic } from '@happier-dev/protocol/actions/executor/actionFailureDiagnostic';

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
    storage: {
        kind: 'persistent' as const,
        locator: {
            namespace: 'happier-plugin-ui-artifacts-v1' as const,
            accountKeyHash: 'b'.repeat(64),
            artifactKeyHash: 'c'.repeat(64),
        },
        resources: [],
    },
    policyTable: { version: 1, routes: [] },
} satisfies Parameters<PluginNativeArtifactResourceRegistrar['register']>[0];

const nativeRegistration = Object.freeze({
    token: registration.token,
    storagePartitionId: registration.storagePartitionId,
    storage: registration.storage,
    policyTable: registration.policyTable,
});

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
            throw new Error('private native module /account/location unavailable');
        });
        const { createExpoPluginNativeArtifactResourceRegistrar } = await import('./nativeArtifactResourceRegistrar.native');
        const registrar = createExpoPluginNativeArtifactResourceRegistrar();

        const result = await registrar.register(registration);
        expect(result).toEqual(registrationFailed);
        expect(readActionOutputDiagnostic(result)).toMatchObject({ failureCause: {
            phase: 'plugin_availability.native_module_load', errorClass: 'Error', errorCode: null, httpStatus: null,
        } });
        expect(JSON.stringify(readActionOutputDiagnostic(result))).not.toContain('private native');
        const repeated = await registrar.register(registration);
        expect(readActionOutputDiagnostic(repeated)).toEqual(readActionOutputDiagnostic(result));
        expect(nativeModuleMock.requireNativeModule).toHaveBeenCalledOnce();
        expect(registrar.unregister(registration.token)).toBe(false);
    });

    it('preserves a rejected native registration without private bridge prose', async () => {
        nativeModuleMock.requireNativeModule.mockReturnValueOnce({
            registerArtifact: async () => { throw Object.assign(new Error('private native /account/location'), { code: 'EACCES' }); },
        });
        const { createExpoPluginNativeArtifactResourceRegistrar } = await import('./nativeArtifactResourceRegistrar.native');
        const result = await createExpoPluginNativeArtifactResourceRegistrar().register(registration);
        expect(result).toEqual(registrationFailed);
        const diagnostic = readActionOutputDiagnostic(result);
        expect(diagnostic).toMatchObject({ failureCause: { phase: 'plugin_availability.native_register',
            errorClass: 'Error', errorCode: 'EACCES', httpStatus: null } });
        expect(JSON.stringify(diagnostic)).not.toContain('private');
    });

    it('projects verified current-load bytes through the existing Expo native token registration', async () => {
        const registerArtifact = vi.fn(async () => ({ kind: 'registered' }));
        nativeModuleMock.requireNativeModule.mockReturnValueOnce({
            registerArtifact,
            unregisterArtifact: vi.fn(() => true),
        });
        const { createExpoPluginNativeArtifactResourceRegistrar } = await import('./nativeArtifactResourceRegistrar.native');
        const registrar = createExpoPluginNativeArtifactResourceRegistrar();

        const currentLoadRegistration = {
            token: registration.token,
            storagePartitionId: registration.storagePartitionId,
            storage: {
                kind: 'currentLoad' as const,
                resources: [{
                    resourceId: 'r0',
                    digest: `sha256:${'d'.repeat(64)}` as const,
                    byteSize: 1,
                    bytes: new Uint8Array([1]),
                }],
            },
            policyTable: registration.policyTable,
        };
        await expect(registrar.register(currentLoadRegistration)).resolves.toEqual(registered);
        expect(registerArtifact).toHaveBeenCalledExactlyOnceWith({
            token: currentLoadRegistration.token,
            storagePartitionId: currentLoadRegistration.storagePartitionId,
            storage: {
                kind: 'currentLoad',
                resources: [{
                    resourceId: 'r0',
                    digest: `sha256:${'d'.repeat(64)}`,
                    byteSize: 1,
                    bytesBase64: 'AQ==',
                }],
            },
            policyTable: currentLoadRegistration.policyTable,
        });
    });

    it('admits the one strict registration result and its synchronous tombstone acknowledgement', async () => {
        const registerArtifact = vi.fn(async () => ({ kind: 'registered' }));
        const unregisterArtifact = vi.fn(() => true);
        nativeModuleMock.requireNativeModule.mockReturnValueOnce({ registerArtifact, unregisterArtifact });
        const { createExpoPluginNativeArtifactResourceRegistrar } = await import('./nativeArtifactResourceRegistrar.native');
        const registrar = createExpoPluginNativeArtifactResourceRegistrar();

        await expect(registrar.register(registration)).resolves.toEqual(registered);
        expect(registerArtifact).toHaveBeenCalledExactlyOnceWith(nativeRegistration);
        expect(registrar.unregister(registration.token)).toBe(true);
        expect(unregisterArtifact).toHaveBeenCalledExactlyOnceWith(registration.token);
    });

    it.each(['ios', 'android'] as const)('rejects a bare boolean acknowledgement on %s', async (os) => {
        platformState.os = os;
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
        expect(registerArtifact).toHaveBeenNthCalledWith(1, nativeRegistration);
        expect(registerArtifact).toHaveBeenNthCalledWith(2, nativeRegistration);
        expect(registerArtifact).toHaveBeenNthCalledWith(3, nativeRegistration);
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
