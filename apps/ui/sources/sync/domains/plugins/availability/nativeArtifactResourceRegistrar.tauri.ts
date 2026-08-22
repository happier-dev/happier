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
 * API module, so the synchronous `unregister` shape can dispatch its native
 * tombstone without reaching for an ambient guest global. The canonical JS
 * registry remains the immediate logical-retirement owner; physical Wry
 * teardown is best-effort and the Rust protocol handler denies a token once
 * its command has been observed.
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
                return readRegistrationResult(await dispatch(
                    'desktop_hosted_artifact_register',
                    { input: registration },
                ), registration.storagePartitionId);
            } catch {
                return registrationFailed;
            }
        },
        unregister: (token) => {
            const dispatch = invoke;
            if (!dispatch) return false;
            try {
                // REQ14 deliberately does not await guest/native teardown.
                // `registration.revoked` becomes false-before-return in the
                // canonical Artifact registry; this command only lets Rust
                // remove its per-view protocol registration when it arrives.
                void Promise.resolve(dispatch(
                    'desktop_hosted_artifact_unregister',
                    { token },
                )).catch(() => undefined);
                return true;
            } catch {
                return false;
            }
        },
    });
}
