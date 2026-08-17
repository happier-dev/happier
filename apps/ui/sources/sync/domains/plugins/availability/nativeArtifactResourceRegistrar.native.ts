import { requireNativeModule } from 'expo-modules-core';
import { Platform } from 'react-native';

import type {
    PluginNativeArtifactResourceRegistrar,
    PluginNativeArtifactResourceProfileIsolationCapability,
    PluginNativeArtifactResourceRegistrationResult,
} from './nativeArtifactResource';

type NativeArtifactRegistrarModule = Readonly<{
    registerArtifact?: (
        input: Parameters<PluginNativeArtifactResourceRegistrar['register']>[0],
    ) => Promise<unknown>;
    /** Expo `Function`, not `AsyncFunction`: revocation must acknowledge now. */
    unregisterArtifact?: (token: string) => unknown;
}>;

let nativeModule: NativeArtifactRegistrarModule | null | undefined;

const registered = Object.freeze({ kind: 'registered' as const });
const registrationFailed = Object.freeze({
    kind: 'unavailable' as const,
    code: 'native_artifact_resource_registration_failed' as const,
});

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactlyKeys(value: Readonly<Record<string, unknown>>, expected: readonly string[]): boolean {
    const actual = Object.keys(value);
    return actual.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}

function isProfileIsolationCapability(value: unknown): value is PluginNativeArtifactResourceProfileIsolationCapability {
    return value === 'MULTI_PROFILE'
        || value === 'DOCUMENT_START_SCRIPT'
        || value === 'WEB_MESSAGE_LISTENER';
}

function profileIsolationUnavailable(
    capability: PluginNativeArtifactResourceProfileIsolationCapability,
): PluginNativeArtifactResourceRegistrationResult {
    return Object.freeze({
        kind: 'unavailable' as const,
        code: 'hosted_web_profile_isolation_unavailable' as const,
        capability,
    });
}

function readRegistrationResult(value: unknown): PluginNativeArtifactResourceRegistrationResult {
    // iOS ships the incumbent Bool acknowledgement. Exact true remains a
    // successful registration only there during this bridge-result transition;
    // truthy values and every other legacy shape still fail closed.
    if (Platform.OS === 'ios' && value === true) return registered;
    if (!isRecord(value)) return registrationFailed;
    if (value.kind === 'registered' && hasExactlyKeys(value, ['kind'])) return registered;
    if (value.kind !== 'unavailable') return registrationFailed;
    if (
        value.code === 'hosted_web_profile_isolation_unavailable'
        && hasExactlyKeys(value, ['kind', 'code', 'capability'])
        && isProfileIsolationCapability(value.capability)
    ) {
        return profileIsolationUnavailable(value.capability);
    }
    if (value.code === 'native_artifact_resource_registration_failed' && hasExactlyKeys(value, ['kind', 'code'])) {
        return registrationFailed;
    }
    return registrationFailed;
}

function getNativeModule(): NativeArtifactRegistrarModule | null {
    if (nativeModule !== undefined) return nativeModule;
    try {
        nativeModule = requireNativeModule<NativeArtifactRegistrarModule>('HappierHostedWebFrame');
    } catch {
        nativeModule = null;
    }
    return nativeModule;
}

/**
 * The only JS adapter for the native token registry. `registerArtifact` has a
 * strict admission result; its exact legacy `true` acknowledgement remains
 * compatible only with iOS. A boolean `true` from `unregisterArtifact` means the
 * native handler has synchronously tombstoned the token. The Artifact owner
 * retains its handle/cache entry on false or a thrown error so it can surface
 * diagnostics and retry at a safe boundary.
 */
export function createExpoPluginNativeArtifactResourceRegistrar(): PluginNativeArtifactResourceRegistrar {
    return Object.freeze({
        register: async (input) => {
            const module = getNativeModule();
            if (!module?.registerArtifact) return registrationFailed;
            try {
                return readRegistrationResult(await module.registerArtifact(input));
            } catch {
                return registrationFailed;
            }
        },
        unregister: (token) => {
            const module = getNativeModule();
            if (!module?.unregisterArtifact) return false;
            try {
                // A Promise is deliberately not accepted: JS must not remove
                // its handle index before native requests are denied.
                return module.unregisterArtifact(token) === true;
            } catch {
                return false;
            }
        },
    });
}
