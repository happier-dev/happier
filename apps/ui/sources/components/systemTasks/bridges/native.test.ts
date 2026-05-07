import { describe, expect, it, vi } from 'vitest';

const buildPolicyState = vi.hoisted(() => ({
    deniedFeatureIds: new Set<string>(),
}));

vi.mock('@/sync/domains/features/featureBuildPolicy', () => ({
    getFeatureBuildPolicyDecision: (featureId: string) =>
        buildPolicyState.deniedFeatureIds.has(featureId) ? 'deny' : 'allow',
}));

describe('native SSH system-task capability', () => {
    it('fails closed when remote SSH machine setup is denied by build policy', async () => {
        buildPolicyState.deniedFeatureIds = new Set(['setup.machine.allowRemoteSshMachineSetup']);
        const loaded = await import('./native').catch(() => null);
        expect(loaded).not.toBeNull();

        expect(loaded!.resolveDefaultNativeSshSystemTaskCapability({
            nativeModule: {
                getAvailability: () => ({
                    available: true,
                    platform: 'android',
                    engine: 'russh',
                    moduleVersion: '0.0.0',
                    supportsLoopbackTunnel: true,
                    supportsPersistentHostKeyStorage: false,
                } as const),
                exec: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
                cancelRequest: async () => undefined,
            },
        })).toEqual(expect.objectContaining({
            available: false,
            unavailableReason: 'feature-disabled',
        }));
    });
});
