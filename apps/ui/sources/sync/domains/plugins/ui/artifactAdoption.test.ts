import { describe, expect, it, vi } from 'vitest';

import {
    PluginUiArtifactAdoptionOwner,
    resolvePluginUiRendererTechnicalAdmission,
} from './artifactAdoption';

type ArtifactHandle = Readonly<{
    isCurrent: () => boolean;
    dispose: () => void;
}>;

function available(handle: ArtifactHandle) {
    return Object.freeze({ kind: 'available' as const, handle });
}

describe('PluginUiArtifactAdoptionOwner', () => {
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
            resolveArtifactAdmission: () => admittedArtifact,
            requiredHostMethods,
            structuralHostMethods,
        })));

        expect(eligibilityDuringLiveAvailabilityChanges).toEqual([
            { kind: 'available', artifactAdmission: admittedArtifact },
            { kind: 'available', artifactAdmission: admittedArtifact },
            { kind: 'available', artifactAdmission: admittedArtifact },
            { kind: 'available', artifactAdmission: admittedArtifact },
        ]);

        const blockedArtifactResolvers = renderers.map(() => vi.fn(() => admittedArtifact));
        const blockedAdmissions = blockedArtifactResolvers.map((resolveArtifactAdmission) => (
            resolvePluginUiRendererTechnicalAdmission({
                resolveArtifactAdmission,
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

    it('adopts each admitted renderer handle and retires every consumer exactly once', async () => {
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
        const reactNative = await owner.adopt({
            kind: 'reactNative',
            acquire: async () => available(Object.freeze({
                isCurrent: () => true,
                dispose: reactNativeDispose,
            })),
        });

        expect(native).toMatchObject({ kind: 'available', adoption: { kind: 'hostedWebNative' } });
        expect(reactNative).toMatchObject({ kind: 'available', adoption: { kind: 'reactNative' } });
        if (native.kind === 'available') {
            expect('dispose' in native.adoption.handle).toBe(false);
        }

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
});
