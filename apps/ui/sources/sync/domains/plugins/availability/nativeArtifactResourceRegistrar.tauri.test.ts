import { describe, expect, it, vi } from 'vitest';
import { readActionOutputDiagnostic } from '@happier-dev/protocol/actions/executor/actionFailureDiagnostic';

import type { PluginNativeArtifactResourceRegistrar } from './nativeArtifactResource';
import {
    createTauriPluginNativeArtifactResourceRegistrar,
    type TauriHostedArtifactCommandInvoke,
} from './nativeArtifactResourceRegistrar.tauri';

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

describe('Tauri desktop Artifact registrar', () => {
    it('preserves an official Tauri module-loader failure without private loader prose', async () => {
        // The official platform SDK module acquisition is the system boundary.
        vi.doMock('@tauri-apps/api/core', () => ({
            get invoke() { throw new TypeError('private platform loader payload'); },
        }));
        try {
            const result = await createTauriPluginNativeArtifactResourceRegistrar().register(registration);
            expect(result).toEqual({ kind: 'unavailable', code: 'native_artifact_resource_registration_failed' });
            const diagnostic = readActionOutputDiagnostic(result);
            expect(diagnostic).toMatchObject({ failureCause: { phase: 'plugin_availability.native_module_load',
                errorClass: 'TypeError', errorCode: null, httpStatus: null } });
            expect(JSON.stringify(diagnostic)).not.toContain('private platform');
        } finally {
            vi.doUnmock('@tauri-apps/api/core');
        }
    });
    it('preserves a rejected native registration command without private bridge prose', async () => {
        const registrar = createTauriPluginNativeArtifactResourceRegistrar({
            invoke: async () => { throw Object.assign(new Error('private native /account/location'), { code: 'EACCES' }); },
        });
        const result = await registrar.register(registration);
        expect(result).toEqual({ kind: 'unavailable', code: 'native_artifact_resource_registration_failed' });
        const diagnostic = readActionOutputDiagnostic(result);
        expect(diagnostic).toMatchObject({ failureCause: { phase: 'plugin_availability.native_register',
            errorClass: 'Error', errorCode: 'EACCES', httpStatus: null } });
        expect(JSON.stringify(diagnostic)).not.toContain('private');
    });
    it('settles the native acknowledgement the canonical registry keeps its registration for', async () => {
        const deferredAcknowledgements: Array<Promise<boolean>> = [];
        let nextAcknowledgement: ((value: boolean | PromiseLike<boolean>) => void) | undefined;
        const pendingAcknowledgement = new Promise<boolean>((resolve) => {
            nextAcknowledgement = resolve;
        });
        deferredAcknowledgements.push(pendingAcknowledgement);
        const calls: Array<readonly [string, Record<string, unknown> | undefined]> = [];
        const invoke: TauriHostedArtifactCommandInvoke = async <T>(
            command: string,
            args?: Record<string, unknown>,
        ): Promise<T> => {
            calls.push([command, args]);
            if (command === 'desktop_hosted_artifact_register') {
                // Test boundary fixture: this command's concrete wire result is
                // intentionally narrowed by the production adapter.
                return { kind: 'registered' } as unknown as T;
            }
            if (command === 'desktop_hosted_artifact_unregister') {
                const queued = deferredAcknowledgements.shift();
                return (queued ?? Promise.resolve(false)) as unknown as T;
            }
            return undefined as T;
        };
        const registrar = createTauriPluginNativeArtifactResourceRegistrar({ invoke });

        await expect(registrar.register(registration)).resolves.toEqual({ kind: 'registered' });
        const firstAcknowledgement = registrar.unregister(registration.token);
        expect(calls[0]).toEqual(['desktop_hosted_artifact_register', {
            input: registration,
        }]);
        expect(calls[1]).toEqual(['desktop_hosted_artifact_unregister', {
            token: registration.token,
        }]);
        nextAcknowledgement?.(true);
        await expect(firstAcknowledgement).resolves.toBe(true);

        // A resolved false is a real native fact, not a swallowed one: the
        // adapter must surface it so the canonical registry keeps the stale
        // token indexed for its diagnostics/retry owner.
        const refusedAcknowledgement = new Promise<boolean>((resolve) => {
            nextAcknowledgement = resolve;
        });
        deferredAcknowledgements.push(refusedAcknowledgement);
        const secondAcknowledgement = registrar.unregister(registration.token);
        nextAcknowledgement?.(false);
        await expect(secondAcknowledgement).resolves.toBe(false);
    });

    it('settles a rejected native teardown to an unacknowledged result', async () => {
        const registrar = createTauriPluginNativeArtifactResourceRegistrar({
            invoke: async <T>(command: string): Promise<T> => {
                if (command === 'desktop_hosted_artifact_unregister') {
                    throw new Error('native view already gone');
                }
                return undefined as T;
            },
        });

        await expect(registrar.unregister(registration.token)).resolves.toBe(false);
    });

    it('encodes current-load bytes only at the exact Tauri command boundary', async () => {
        const calls: Array<readonly [string, Record<string, unknown> | undefined]> = [];
        const registrar = createTauriPluginNativeArtifactResourceRegistrar({
            invoke: async <T>(command: string, args?: Record<string, unknown>): Promise<T> => {
                calls.push([command, args]);
                return { kind: 'registered' } as unknown as T;
            },
        });
        const bytes = new Uint8Array([0, 1, 2, 255]);

        await expect(registrar.register({
            token: registration.token,
            storagePartitionId: registration.storagePartitionId,
            storage: {
                kind: 'currentLoad',
                resources: [{
                    resourceId: 'r0',
                    digest: `sha256:${'d'.repeat(64)}`,
                    byteSize: bytes.byteLength,
                    bytes,
                }],
            },
            policyTable: registration.policyTable,
        })).resolves.toEqual({ kind: 'registered' });

        expect(calls[0]).toEqual(['desktop_hosted_artifact_register', {
            input: {
                token: registration.token,
                storagePartitionId: registration.storagePartitionId,
                storage: {
                    kind: 'currentLoad',
                    resources: [{
                        resourceId: 'r0',
                        digest: `sha256:${'d'.repeat(64)}`,
                        byteSize: 4,
                        bytesBase64: 'AAEC/w==',
                    }],
                },
                policyTable: registration.policyTable,
            },
        }]);
    });

    it('fails closed when the native registrar does not return its strict result shape', async () => {
        const registrar = createTauriPluginNativeArtifactResourceRegistrar({
            // Test boundary fixture: production must reject this unknown-key
            // shape before treating it as a registrar result.
            invoke: async <T>(): Promise<T> => ({ kind: 'registered', unexpected: true } as unknown as T),
        });

        await expect(registrar.register(registration)).resolves.toEqual({
            kind: 'unavailable',
            code: 'native_artifact_resource_registration_failed',
        });
    });

    it('preserves only the Windows Wry origin bound to the registered Artifact partition', async () => {
        const frameOrigin = `https://happier-hosted-artifact.${registration.storagePartitionId}`;
        const registrar = createTauriPluginNativeArtifactResourceRegistrar({
            // Test boundary fixture: Windows Wry maps the registered custom
            // scheme to this exact HTTPS origin before guest bootstrap runs.
            invoke: async <T>(): Promise<T> => ({
                kind: 'registered',
                frameOrigin,
            } as unknown as T),
        });

        await expect(registrar.register(registration)).resolves.toEqual({
            kind: 'registered',
            frameOrigin,
        });

        const mismatchedPartitionRegistrar = createTauriPluginNativeArtifactResourceRegistrar({
            // The origin is authority-bearing bridge input, not an arbitrary
            // native string: it must be tied to this registration's partition.
            invoke: async <T>(): Promise<T> => ({
                kind: 'registered',
                frameOrigin: `https://happier-hosted-artifact.hpa_${'z'.repeat(64)}`,
            } as unknown as T),
        });
        await expect(mismatchedPartitionRegistrar.register(registration)).resolves.toEqual({
            kind: 'unavailable',
            code: 'native_artifact_resource_registration_failed',
        });
    });

    it('preserves the typed multi-profile unavailability returned by unsupported desktop targets', async () => {
        const registrar = createTauriPluginNativeArtifactResourceRegistrar({
            // Test boundary fixture for the strict native registration union.
            invoke: async <T>(): Promise<T> => ({
                kind: 'unavailable',
                code: 'hosted_web_profile_isolation_unavailable',
                capability: 'MULTI_PROFILE',
            } as unknown as T),
        });

        await expect(registrar.register(registration)).resolves.toEqual({
            kind: 'unavailable',
            code: 'hosted_web_profile_isolation_unavailable',
            capability: 'MULTI_PROFILE',
        });
    });
});
