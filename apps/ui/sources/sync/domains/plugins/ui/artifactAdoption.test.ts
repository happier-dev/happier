import { describe, expect, it, vi } from 'vitest';

import { DaemonPluginReactNativeBundleCacheIdentityV1Schema } from '@happier-dev/protocol';

import {
    PluginUiArtifactAdoptionOwner,
    readPluginUiDaemonProjectionSelection,
    readPluginUiReactNativeBundleCacheIdentity,
    resolvePluginUiRendererTechnicalAdmission,
} from './artifactAdoption';

describe('readPluginUiDaemonProjectionSelection', () => {
    it('reads only an explicit daemon-owned current projection stamp', () => {
        expect(readPluginUiDaemonProjectionSelection({
            artifactSelectionOwner: 'daemonProjection',
            occurrenceId: 'occurrence-a',
            contributionId: 'renderer-a',
            pluginVersion: '1.2.3',
        })).toEqual({
            occurrenceId: 'occurrence-a',
            contributionId: 'renderer-a',
            releaseVersion: '1.2.3',
        });
        expect(readPluginUiDaemonProjectionSelection({
            artifactSelectionOwner: 'accountRelease',
            occurrenceId: 'occurrence-a',
            contributionId: 'renderer-a',
            pluginVersion: '1.2.3',
        })).toBeNull();
        expect(readPluginUiDaemonProjectionSelection({
            artifactSelectionOwner: 'daemonProjection',
            contributionId: 'renderer-a',
            pluginVersion: '1.2.3',
        })).toBeNull();
    });

    it('carries the projecting daemon from an app-union origin stamp as the byte route', () => {
        expect(readPluginUiDaemonProjectionSelection({
            artifactSelectionOwner: 'daemonProjection',
            occurrenceId: 'occurrence-a',
            contributionId: 'renderer-a',
            pluginVersion: '1.2.3',
            hostOrigin: {
                machineId: 'machine-b',
                serverId: 'server-a',
                phase: 'current',
                interactionEnabled: true,
                generation: 3,
                executionOrigin: null,
            },
        })).toEqual({
            occurrenceId: 'occurrence-a',
            contributionId: 'renderer-a',
            releaseVersion: '1.2.3',
            transport: { machineId: 'machine-b', serverId: 'server-a' },
        });
    });

    it('uses compatible current renderer supplies for bytes without restoring execution authority', () => {
        const supply = { machineId: 'machine-b', serverId: 'server-a', phase: 'current', interactionEnabled: true,
            generation: 3, executionOrigin: null, occurrenceId: 'occurrence-b', pluginVersion: '1.2.3', sourceCustody: null };
        const contribution = { artifactSelectionOwner: 'daemonProjection', contributionId: 'renderer-a', pluginVersion: '1.2.3',
            hostOrigin: null, hostCompatibility: 'compatible',
            hostSupplies: [{ ...supply, machineId: 'machine-a', phase: 'retainedOffline', interactionEnabled: false }, supply] };
        expect(readPluginUiDaemonProjectionSelection(contribution)).toEqual({
            occurrenceId: 'occurrence-b', contributionId: 'renderer-a', releaseVersion: '1.2.3',
            transport: { machineId: 'machine-b', serverId: 'server-a' },
        });
        expect(readPluginUiDaemonProjectionSelection({ ...contribution, hostCompatibility: 'conflict' })).toBeNull();
        expect(readPluginUiDaemonProjectionSelection({ ...contribution, artifactSelectionOwner: 'accountRelease' })).toBeNull();
    });
});

type ArtifactHandle = Readonly<{
    isCurrent: () => boolean;
    dispose: () => void;
}>;

function available(handle: ArtifactHandle) {
    return Object.freeze({ kind: 'available' as const, handle });
}

describe('PluginUiArtifactAdoptionOwner', () => {
    it('cancels a pending acquisition on supersession and owner retirement', async () => {
        const owner = new PluginUiArtifactAdoptionOwner({ isCurrent: () => true });
        const signals: (AbortSignal | undefined)[] = [];
        const acquire = (signal?: AbortSignal) => new Promise<Readonly<{ kind: 'unavailable'; code: string }>>(resolve => {
            signals.push(signal);
            signal?.addEventListener('abort', () => resolve({ kind: 'unavailable', code: 'artifact_lease_revoked' }), { once: true });
        });
        const retired = owner.adopt({ kind: 'reactNative', desiredArtifactKey: 'first', acquire });
        const current = owner.adopt({ kind: 'reactNative', desiredArtifactKey: 'second', acquire });
        expect(signals[0]?.aborted).toBe(true);
        expect(signals[1]?.aborted).toBe(false);
        owner.dispose();
        expect(signals[1]?.aborted).toBe(true);
        await expect(retired).resolves.toEqual({ kind: 'unavailable', code: 'artifact_lease_revoked' });
        await expect(current).resolves.toEqual({ kind: 'unavailable', code: 'artifact_lease_revoked' });
    });

    it('uses structural host-method admission identically for hosted web and React Native', () => {
        const requiredHostMethods = ['context', 'readResource'] as const;
        const structuralHostMethods = ['context', 'readResource'] as const;
        const admittedArtifact = Object.freeze({ source: 'verified' });
        const renderers = ['hostedWeb', 'reactNative'] as const;

        // Live daemon availability can narrow the served set, but must not
        // de-admit an otherwise current surface whose structural contract has
        // already been established.
        const eligibilityDuringLiveAvailabilityChanges = [
            ['context', 'readResource'],
            ['context'],
        ].flatMap(() => renderers.map(() => resolvePluginUiRendererTechnicalAdmission({
            resolveSourceAdmission: () => admittedArtifact,
            requiredHostMethods,
            structuralHostMethods,
        })));

        expect(eligibilityDuringLiveAvailabilityChanges).toEqual([
            { kind: 'available', sourceAdmission: admittedArtifact },
            { kind: 'available', sourceAdmission: admittedArtifact },
            { kind: 'available', sourceAdmission: admittedArtifact },
            { kind: 'available', sourceAdmission: admittedArtifact },
        ]);

        const blockedArtifactResolvers = renderers.map(() => vi.fn(() => admittedArtifact));
        const blockedAdmissions = blockedArtifactResolvers.map((resolveSourceAdmission) => (
            resolvePluginUiRendererTechnicalAdmission({
                resolveSourceAdmission,
                requiredHostMethods: ['watchResource'],
                structuralHostMethods,
            })
        ));
        expect(blockedAdmissions).toEqual([
            { kind: 'unavailable', code: 'required_host_methods_unavailable' },
            { kind: 'unavailable', code: 'required_host_methods_unavailable' },
        ]);
        for (const resolveArtifactAdmission of blockedArtifactResolvers) {
            expect(resolveArtifactAdmission).not.toHaveBeenCalled();
        }
    });

    it('replaces an admitted renderer handle and retires each consumer exactly once', async () => {
        const owner = new PluginUiArtifactAdoptionOwner({ isCurrent: () => true });
        const nativeDispose = vi.fn();
        const reactNativeDispose = vi.fn();

        const native = await owner.adopt({
            kind: 'hostedWebNative',
            acquire: async () => available(Object.freeze({
                isCurrent: () => true,
                dispose: nativeDispose,
            })),
        });
        if (native.kind === 'available') native.adoption.commit();
        const reactNative = await owner.adopt({
            kind: 'reactNative',
            acquire: async () => available(Object.freeze({
                isCurrent: () => true,
                dispose: reactNativeDispose,
            })),
        });
        if (reactNative.kind === 'available') reactNative.adoption.commit();

        expect(native).toMatchObject({ kind: 'available', adoption: { kind: 'hostedWebNative' } });
        expect(reactNative).toMatchObject({ kind: 'available', adoption: { kind: 'reactNative' } });
        if (native.kind === 'available') {
            expect('dispose' in native.adoption.handle).toBe(false);
        }
        expect(nativeDispose).toHaveBeenCalledTimes(1);
        expect(reactNativeDispose).not.toHaveBeenCalled();

        owner.dispose();
        owner.dispose();

        expect(nativeDispose).toHaveBeenCalledTimes(1);
        expect(reactNativeDispose).toHaveBeenCalledTimes(1);
    });

    it('fails closed and disposes a late Artifact handle when the bound surface retires', async () => {
        let current = true;
        let resolveAcquisition: ((value: ReturnType<typeof available>) => void) | undefined;
        const dispose = vi.fn();
        const owner = new PluginUiArtifactAdoptionOwner({ isCurrent: () => current });
        const adoption = owner.adopt({
            kind: 'hostedWebNative',
            acquire: () => new Promise<ReturnType<typeof available>>((resolve) => {
                resolveAcquisition = resolve;
            }),
        });

        current = false;
        resolveAcquisition?.(available(Object.freeze({
            isCurrent: () => true,
            dispose,
        })));

        await expect(adoption).resolves.toEqual({
            kind: 'unavailable',
            code: 'artifact_lease_revoked',
        });
        expect(dispose).toHaveBeenCalledTimes(1);
    });

    it('preserves a typed unavailable result without creating a consumer lease', async () => {
        const owner = new PluginUiArtifactAdoptionOwner({ isCurrent: () => true });

        await expect(owner.adopt({
            kind: 'reactNative',
            acquire: async () => Object.freeze({
                kind: 'unavailable' as const,
                code: 'artifact_source_unavailable',
            }),
        })).resolves.toEqual({
            kind: 'unavailable',
            code: 'artifact_source_unavailable',
        });

        owner.dispose();
    });

    it('retains the applied artifact when a replacement candidate fails', async () => {
        const owner = new PluginUiArtifactAdoptionOwner({ isCurrent: () => true });
        const incumbentDispose = vi.fn();

        const incumbent = await owner.adopt({
            kind: 'reactNative',
            desiredArtifactKey: 'sha256:incumbent',
            acquire: async () => available(Object.freeze({
                isCurrent: () => true,
                dispose: incumbentDispose,
            })),
        });
        expect(incumbent).toMatchObject({ kind: 'available' });
        if (incumbent.kind === 'available') incumbent.adoption.commit();

        await expect(owner.adopt({
            kind: 'reactNative',
            desiredArtifactKey: 'sha256:candidate',
            acquire: async () => Object.freeze({
                kind: 'unavailable' as const,
                code: 'artifact_source_integrity_invalid',
            }),
        })).resolves.toEqual({
            kind: 'unavailable',
            code: 'artifact_source_integrity_invalid',
        });

        expect(incumbentDispose).not.toHaveBeenCalled();
        expect(owner.readDisposition()).toEqual({
            kind: 'retainedLastKnownGood',
            appliedArtifactKey: 'sha256:incumbent',
            desiredArtifactKey: 'sha256:candidate',
            failureCode: 'artifact_source_integrity_invalid',
        });
    });

    it('does not let an older in-flight candidate replace a newer applied artifact', async () => {
        const owner = new PluginUiArtifactAdoptionOwner({ isCurrent: () => true });
        let resolveOlder!: (result: ReturnType<typeof available>) => void;
        const olderDispose = vi.fn();
        const newerDispose = vi.fn();
        const older = owner.adopt({
            kind: 'reactNative',
            desiredArtifactKey: 'sha256:older',
            acquire: () => new Promise<ReturnType<typeof available>>((resolve) => { resolveOlder = resolve; }),
        });
        const newer = owner.adopt({
            kind: 'reactNative',
            desiredArtifactKey: 'sha256:newer',
            acquire: async () => available(Object.freeze({ isCurrent: () => true, dispose: newerDispose })),
        });

        const newerResult = await newer;
        expect(newerResult).toMatchObject({ kind: 'available' });
        if (newerResult.kind === 'available') newerResult.adoption.commit();
        resolveOlder(available(Object.freeze({ isCurrent: () => true, dispose: olderDispose })));
        await expect(older).resolves.toEqual({ kind: 'unavailable', code: 'artifact_lease_revoked' });

        expect(olderDispose).toHaveBeenCalledOnce();
        expect(newerDispose).not.toHaveBeenCalled();
        expect(owner.readDisposition()).toEqual({ kind: 'applied', appliedArtifactKey: 'sha256:newer' });
    });

    it('retires an applied artifact immediately for explicit disable or revocation', async () => {
        for (const reason of ['disabled', 'revoked'] as const) {
            const owner = new PluginUiArtifactAdoptionOwner({ isCurrent: () => true });
            const dispose = vi.fn();
            const incumbent = await owner.adopt({
                kind: 'hostedWebNative',
                desiredArtifactKey: 'sha256:incumbent',
                acquire: async () => available(Object.freeze({
                    isCurrent: () => true,
                    dispose,
                })),
            });
            if (incumbent.kind === 'available') incumbent.adoption.commit();

            owner.retire(reason);

            expect(dispose).toHaveBeenCalledOnce();
            expect(owner.readDisposition()).toEqual({ kind: 'retired', reason });
        }
    });

    it('keeps the applied incumbent until a prepared candidate commits and retires only a failed candidate', async () => {
        const owner = new PluginUiArtifactAdoptionOwner({ isCurrent: () => true });
        const incumbentDispose = vi.fn();
        const candidateDispose = vi.fn();
        const incumbent = await owner.adopt({
            kind: 'hostedWebNative',
            desiredArtifactKey: 'sha256:incumbent',
            acquire: async () => available(Object.freeze({ isCurrent: () => true, dispose: incumbentDispose })),
        });
        if (incumbent.kind !== 'available') throw new Error('expected incumbent');
        expect(incumbent.adoption.commit()).toBe(true);

        const candidate = await owner.adopt({
            kind: 'hostedWebNative',
            desiredArtifactKey: 'sha256:candidate',
            acquire: async () => available(Object.freeze({ isCurrent: () => true, dispose: candidateDispose })),
        });
        if (candidate.kind !== 'available') throw new Error('expected candidate');

        expect(incumbentDispose).not.toHaveBeenCalled();
        expect(owner.readDisposition()).toEqual({
            kind: 'updating',
            appliedArtifactKey: 'sha256:incumbent',
            desiredArtifactKey: 'sha256:candidate',
        });

        candidate.adoption.fail('frame_load_failed');

        expect(candidateDispose).toHaveBeenCalledOnce();
        expect(incumbentDispose).not.toHaveBeenCalled();
        expect(owner.readDisposition()).toEqual({
            kind: 'retainedLastKnownGood',
            appliedArtifactKey: 'sha256:incumbent',
            desiredArtifactKey: 'sha256:candidate',
            failureCode: 'frame_load_failed',
        });
    });
});

describe('readPluginUiReactNativeBundleCacheIdentity', () => {
    const canonicalIdentity = Object.freeze({
        artifactDigest: `sha256:${'a'.repeat(64)}`,
    });
    const context = Object.freeze({
        pluginId: 'com.acme.preview',
        contributionId: 'native-preview',
        artifactId: 'native-preview-artifact',
        platform: 'ios' as const,
    });

    it('admits exactly what the canonical daemon cache-identity schema admits', () => {
        // The producer validates `runtime.cacheIdentity` with
        // `DaemonPluginReactNativeBundleCacheIdentityV1Schema`
        // (`apps/cli/src/rpc/handlers/daemonContributionRegistryProjection.ts`).
        // A second, more lenient reader here silently accepts values that
        // producer can never emit, and derives a different cache key for them.
        const canonical = DaemonPluginReactNativeBundleCacheIdentityV1Schema.parse(canonicalIdentity);
        expect(readPluginUiReactNativeBundleCacheIdentity(canonicalIdentity, context)).toEqual({
            ...context,
            ...canonical,
        });

        // Unknown members: the canonical schema is `.strict()`.
        expect(DaemonPluginReactNativeBundleCacheIdentityV1Schema.safeParse({
            ...canonicalIdentity,
            unexpectedMember: 'x',
        }).success).toBe(false);
        expect(readPluginUiReactNativeBundleCacheIdentity({
            ...canonicalIdentity,
            unexpectedMember: 'x',
        }, context)).toBeNull();

        // Surrounding whitespace: the canonical schema normalizes it, so a
        // reader that keeps the raw value derives a divergent cache key for
        // the same identity.
        const padded = { artifactDigest: `  ${canonicalIdentity.artifactDigest}  ` };
        expect(DaemonPluginReactNativeBundleCacheIdentityV1Schema.parse(padded).artifactDigest)
            .toBe(canonicalIdentity.artifactDigest);
        expect(readPluginUiReactNativeBundleCacheIdentity(padded, context)?.artifactDigest)
            .toBe(canonicalIdentity.artifactDigest);

        // Semantic routing members are rejected by the byte identity rather
        // than silently participating in cache equality.
        expect(readPluginUiReactNativeBundleCacheIdentity({
            ...canonicalIdentity,
            contributionId: 'native-preview',
        }, context)).toBeNull();
    });
});
