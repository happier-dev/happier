import { describe, expect, it, vi } from 'vitest';

vi.mock('@/packagedRuntime/managedTools/requireProviderCliLaunchSpec', () => ({
    requireProviderCliLaunchSpec: vi.fn(() => ({ command: 'opencode', args: [] })),
}));

import { importOpenCodeSessionBundle } from './importOpenCodeSessionBundle';

function encodeExportPayload(value: unknown): string {
    return Buffer.from(JSON.stringify(value), 'utf8').toString('base64');
}

describe('importOpenCodeSessionBundle', () => {
    it('returns canonical runtimeDescriptorV1 metadata for imported OpenCode sessions', async () => {
        const execFile = vi.fn(async () => ({ stdout: '', stderr: '' }));

        const result = await importOpenCodeSessionBundle({
            bundle: {
                providerId: 'opencode',
                remoteSessionId: 'oc-import-1',
                exportJsonBase64: encodeExportPayload({ id: 'oc-import-1' }),
                affinity: {
                    backendMode: 'server',
                    serverBaseUrl: 'http://127.0.0.1:4096/',
                    serverBaseUrlExplicit: true,
                },
            },
            targetPath: '/repo',
            execFile,
        });

        expect(result).toMatchObject({
            remoteSessionId: 'oc-import-1',
            runtimeDescriptorV1: {
                v: 1,
                providerId: 'opencode',
                provider: {
                    backendMode: 'server',
                    vendorSessionId: 'oc-import-1',
                    providerExtra: {
                        runtimeHandle: {
                            backendMode: 'server',
                            vendorSessionId: 'oc-import-1',
                            serverBaseUrl: 'http://127.0.0.1:4096/',
                            serverBaseUrlExplicit: true,
                        },
                    },
                },
            },
        });
        expect(result).not.toHaveProperty('agentRuntimeDescriptorV1');
    });
});
