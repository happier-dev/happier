import { encodeBase64 } from '@happier-dev/protocol/crypto/base64';

import type {
    PluginNativeArtifactResourceProfileIsolationCapability,
    PluginNativeArtifactResourceRegistrar,
    PluginNativeArtifactResourceRegistrationResult,
} from './nativeArtifactResource';

export type TauriHostedArtifactCommandInvoke = <T>(
    command: string,
    args?: Record<string, unknown>,
) => Promise<T>;

const registered = Object.freeze({ kind: 'registered' as const });
const registrationFailed = Object.freeze({
    kind: 'unavailable' as const,
    code: 'native_artifact_resource_registration_failed' as const,
});

function windowsWryArtifactFrameOrigin(storagePartitionId: string): string {
    // Wry's Windows custom-protocol transport maps
    // `happier-hosted-artifact://<partition>` to this HTTPS origin when the
    // restricted child enables `with_https_scheme(true)`.
    return `https://happier-hosted-artifact.${storagePartitionId}`;
}

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

function readRegistrationResult(
    value: unknown,
    storagePartitionId: string,
): PluginNativeArtifactResourceRegistrationResult {
    if (!isRecord(value)) return registrationFailed;
    if (value.kind === 'registered' && hasExactlyKeys(value, ['kind'])) return registered;
    if (
        value.kind === 'registered'
        && typeof value.frameOrigin === 'string'
        && value.frameOrigin === windowsWryArtifactFrameOrigin(storagePartitionId)
        && hasExactlyKeys(value, ['kind', 'frameOrigin'])
    ) {
        return Object.freeze({
            kind: 'registered' as const,
            frameOrigin: value.frameOrigin,
        });
    }
    if (
        value.kind === 'unavailable'
        && value.code === 'hosted_web_profile_isolation_unavailable'
        && value.capability !== undefined
        && hasExactlyKeys(value, ['kind', 'code', 'capability'])
        && isProfileIsolationCapability(value.capability)
    ) {
        return Object.freeze({
            kind: 'unavailable' as const,
            code: 'hosted_web_profile_isolation_unavailable' as const,
            capability: value.capability,
        });
    }
    return registrationFailed;
}

/**
 * The desktop transport is intentionally a narrow Tauri-command adapter, not
 * an Artifact/currentness owner. Registration first loads the official Tauri
 * API module, so `unregister` can dispatch its native tombstone without
 * reaching for an ambient guest global and settle the acknowledgement the
 * canonical registry now waits for. The registry still makes the token
 * unavailable to JS immediately on revocation; this command's settled result
 * only decides when the canonical registry drops its bookkeeping, and a
 * resolved false or rejected command re-enters its existing
 * diagnostics/retry owner instead of being swallowed.
 */
export function createTauriPluginNativeArtifactResourceRegistrar(input: Readonly<{
    invoke?: TauriHostedArtifactCommandInvoke;
}> = {}): PluginNativeArtifactResourceRegistrar {
    let invoke = input.invoke;
    let loadingInvoke: Promise<TauriHostedArtifactCommandInvoke> | null = null;

    const resolveInvoke = async (): Promise<TauriHostedArtifactCommandInvoke> => {
        if (invoke) return invoke;
        loadingInvoke ??= import('@tauri-apps/api/core').then((module) => module.invoke);
        invoke = await loadingInvoke;
        return invoke;
    };

    return Object.freeze({
        register: async (registration) => {
            let dispatch: TauriHostedArtifactCommandInvoke;
            try {
                dispatch = await resolveInvoke();
            } catch {
                return registrationFailed;
            }
            try {
                const storage = registration.storage.kind === 'persistent'
                    ? registration.storage
                    : Object.freeze({
                        kind: 'currentLoad' as const,
                        resources: Object.freeze(registration.storage.resources.map((resource) => Object.freeze({
                            resourceId: resource.resourceId,
                            digest: resource.digest,
                            byteSize: resource.byteSize,
                            bytesBase64: encodeBase64(resource.bytes, 'base64'),
                        }))),
                    });
                return readRegistrationResult(await dispatch(
                    'desktop_hosted_artifact_register',
                    {
                        input: {
                            token: registration.token,
                            storagePartitionId: registration.storagePartitionId,
                            storage,
                            policyTable: registration.policyTable,
                        },
                    },
                ), registration.storagePartitionId);
            } catch {
                return registrationFailed;
            }
        },
        unregister: (token) => {
            const dispatch = invoke;
            if (!dispatch) return false;
            // The command result is the acknowledgement the canonical registry
            // keeps its registration indexed for; it is deliberately not
            // swallowed here. Account/currentness retirement still does not
            // await it (REQ14): revocation is synchronous, only the
            // bookkeeping drop follows the settled native fact.
            return dispatch('desktop_hosted_artifact_unregister', { token })
                .then((acknowledged) => acknowledged === true)
                .catch(() => false);
        },
    });
}
