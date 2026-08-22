import { describe, expect, it } from 'vitest';

import type { PluginNativeArtifactResourceRegistrar } from './nativeArtifactResource';
import {
    createTauriPluginNativeArtifactResourceRegistrar,
    type TauriHostedArtifactCommandInvoke,
} from './nativeArtifactResourceRegistrar.tauri';

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

describe('Tauri desktop Artifact registrar', () => {
    it('removes the JS-visible token synchronously after registration while native teardown stays fire-and-forget', async () => {
        let rejectNativeTeardown: ((error: Error) => void) | undefined;
        const nativeTeardown = new Promise<never>((_resolve, reject) => {
            rejectNativeTeardown = reject;
        });
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
                return nativeTeardown;
            }
            return undefined as T;
        };
        const registrar = createTauriPluginNativeArtifactResourceRegistrar({ invoke });

        await expect(registrar.register(registration)).resolves.toEqual({ kind: 'registered' });
        expect(registrar.unregister(registration.token)).toBe(true);
        expect(calls[0]).toEqual(['desktop_hosted_artifact_register', {
            input: registration,
        }]);
        expect(calls[1]).toEqual(['desktop_hosted_artifact_unregister', {
            token: registration.token,
        }]);

        // Physical teardown is deliberately not awaited by Account/currentness
        // retirement. A late native failure is observed only at the native
        // handler, while the canonical Artifact registry has already made the
        // token unavailable to every JS consumer.
        rejectNativeTeardown?.(new Error('native view already gone'));
        await Promise.resolve();
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
