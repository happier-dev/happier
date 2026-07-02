import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { resolveBackendExecutionSurfaces } = vi.hoisted(() => ({
    resolveBackendExecutionSurfaces: vi.fn(),
}));

vi.mock('@/agent/runtime/registry/engineRegistry', () => ({
    resolveBackendExecutionSurfaces,
}));

describe('importSessionHandoffProviderBundle', () => {
    beforeEach(() => {
        resolveBackendExecutionSurfaces.mockReset();
    });

    afterEach(() => {
        vi.resetModules();
    });

	    it('resolves provider import through the generic backend execution surface for supported bundles', async () => {
	        const importBundle = vi.fn(async () => ({
	            ok: true,
	            value: {
	                providerSessionId: 'codex_1',
	                source: {
	                    kind: 'codexHome',
	                    home: 'user',
	                    homePath: '/tmp/codex',
	                },
	                launch: {
	                    directory: '/repo',
	                    environmentVariables: { CODEX_HOME: '/tmp/codex' },
	                    sessionStateUpdates: [
	                        {
	                            fieldId: 'identity.runtimeDescriptor',
	                            value: {
	                                v: 1,
	                                providerId: 'codex',
	                                provider: {
	                                    backendMode: 'appServer',
	                                    providerSessionId: 'codex_1',
	                                },
	                            },
	                        },
	                    ],
	                },
	            },
	        }));
	        resolveBackendExecutionSurfaces.mockResolvedValueOnce({
	            terminalRuntime: null,
	            externalSession: null,
	            attach: null,
	            handoff: {
	                exportBundle: vi.fn(),
	                importBundle,
	            },
	            fork: null,
	            checkpoint: null,
	        });
        const { importSessionHandoffProviderBundle } = await import('./import');

        await expect(importSessionHandoffProviderBundle({
            bundle: {
                providerId: 'codex',
                remoteSessionId: 'codex_1',
                files: [],
            },
            targetPath: '/repo',
            sessionStorageMode: 'persisted',
        })).resolves.toEqual({
	            remoteSessionId: 'codex_1',
	            directSource: {
	                kind: 'codexHome',
	                home: 'user',
	                homePath: '/tmp/codex',
	            },
	            runtimeDescriptorV1: {
	                v: 1,
	                providerId: 'codex',
	                provider: {
	                    backendMode: 'appServer',
	                    providerSessionId: 'codex_1',
	                },
	            },
	            resume: {
	                directory: '/repo',
	                agent: 'codex',
                resume: 'codex_1',
                codexBackendMode: 'appServer',
                environmentVariables: { CODEX_HOME: '/tmp/codex' },
                transcriptStorage: 'persisted',
                approvedNewDirectoryCreation: true,
            },
        });

        expect(resolveBackendExecutionSurfaces).toHaveBeenCalledWith('codex');
	        expect(importBundle).toHaveBeenCalledWith({
	            bundle: {
	                providerId: 'codex',
	                remoteSessionId: 'codex_1',
	                files: [],
            },
            targetDirectory: '/repo',
        });
    });
});
