import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { resolveBackendExecutionSurfaces, directCodexImportBundle } = vi.hoisted(() => ({
    resolveBackendExecutionSurfaces: vi.fn(),
    directCodexImportBundle: vi.fn(),
}));

vi.mock('@/backends/catalog', () => ({
    resolveBackendExecutionSurfaces,
}));

vi.mock('../../backends/codex/handoff/importCodexSessionBundle', () => ({
    importCodexSessionBundle: directCodexImportBundle,
}));

describe('importSessionHandoffProviderBundle', () => {
    beforeEach(() => {
        resolveBackendExecutionSurfaces.mockReset();
        directCodexImportBundle.mockReset();
    });

    afterEach(() => {
        vi.resetModules();
    });

    it('resolves provider import through the generic backend execution surface for supported bundles', async () => {
        const importBundle = vi.fn(async () => ({
            remoteSessionId: 'codex_1',
            directSource: {
                kind: 'codexHome',
                codexHome: '/tmp/codex',
            },
            resume: {
                directory: '/repo',
                agent: 'codex',
                resume: 'codex_1',
                transcriptStorage: 'persisted',
                approvedNewDirectoryCreation: true,
            },
        }));
        resolveBackendExecutionSurfaces.mockResolvedValueOnce({
            terminalRuntime: null,
            directSessions: null,
            attach: null,
            sessionHandoff: {
                exportBundle: vi.fn(),
                importBundle,
            },
        });
        directCodexImportBundle.mockImplementation(() => {
            throw new Error('direct codex import should not be called');
        });

        const { importSessionHandoffProviderBundle } = await import('./importSessionHandoffProviderBundle');

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
                codexHome: '/tmp/codex',
            },
            resume: {
                directory: '/repo',
                agent: 'codex',
                resume: 'codex_1',
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
            targetPath: '/repo',
            sessionStorageMode: 'persisted',
        });
        expect(directCodexImportBundle).not.toHaveBeenCalled();
    });
});
