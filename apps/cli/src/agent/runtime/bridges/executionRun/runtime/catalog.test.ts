import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
    ExecutionRunHostRuntime,
    ExecutionRunHostRuntimeMessageHandler,
} from '@/agent/runtime/bridges/executionRun/executionRunHostRuntime';

function createStubRuntime(): ExecutionRunHostRuntime & Readonly<{ disposeSpy: ReturnType<typeof vi.fn> }> {
    const disposeSpy = vi.fn(async () => undefined);
    let handler: ExecutionRunHostRuntimeMessageHandler | null = null;
    return {
        async readResumeSupport() {
            return false;
        },
        async provisionSession() {
            return { sessionId: 'session_1' } as never;
        },
        async sendPrompt() {},
        async cancel() {},
        subscribeMessages(next: ExecutionRunHostRuntimeMessageHandler) {
            handler = next;
            return () => {
                if (handler === next) {
                    handler = null;
                }
            };
        },
        dispose: disposeSpy,
        disposeSpy,
    };
}

afterEach(() => {
    vi.resetModules();
    delete process.env.HAPPIER_HOME_DIR;
    delete process.env.HAPPIER_SERVER_URL;
    delete process.env.HAPPIER_WEBAPP_URL;
});

describe('createCatalogProviderExecutionRunBackend', () => {
    it('removes late-unset explicit values and forwards unsets to the catalog runtime boundary', async () => {
        const { createCatalogProviderExecutionRunBackend } = await import('./catalog');
        const nativeRuntime = createStubRuntime();
        let capturedOptions: unknown = null;
        const runtime = createCatalogProviderExecutionRunBackend({
            agentId: 'codex',
            createRuntime: (options) => {
                capturedOptions = options;
                return nativeRuntime;
            },
        }, {
            cwd: '/tmp/catalog-execution-run',
            backendId: 'codex',
            permissionMode: 'read_only',
            // Boundary fixture exercises the new transport before the owning type is widened.
            isolation: {
                env: {
                    OPENAI_API_KEY: 'must-not-survive',
                    KEEP: 'visible',
                },
                unsetEnvKeys: ['openai_api_key'],
            } as unknown as NonNullable<Parameters<typeof createCatalogProviderExecutionRunBackend>[1]['isolation']>,
        });

        await runtime.provisionSession({ initialPrompt: 'boot' });

        expect(capturedOptions).toEqual(expect.objectContaining({
            env: { KEEP: 'visible' },
            unsetEnvKeys: ['openai_api_key'],
        }));
    });

    it('cleans up ephemeral isolation when backend construction throws', async () => {
        const homeDir = await mkdtemp(join(os.tmpdir(), 'happier-catalog-execution-run-home-'));
        try {
            process.env.HAPPIER_HOME_DIR = homeDir;
            process.env.HAPPIER_SERVER_URL = 'https://api.example.test';
            process.env.HAPPIER_WEBAPP_URL = 'https://app.example.test';

            const { reloadConfiguration, configuration } = await import('@/configuration');
            reloadConfiguration();

	            const { createCatalogProviderExecutionRunBackend } = await import('./catalog');
	            const runtime = createCatalogProviderExecutionRunBackend({
	                agentId: 'pi',
	                createRuntime: () => {
	                    throw new Error('catalog backend failed');
                },
            }, {
                cwd: '/tmp/catalog-execution-run',
                backendId: 'pi',
                runId: 'run_catalog_throw',
                permissionMode: 'read_only',
                start: {
                    intent: 'review',
                    retentionPolicy: 'ephemeral',
                },
            });
            const root = join(configuration.activeServerDir, 'isolation', 'pi', 'execution_run', 'run_catalog_throw');

            await expect(runtime.provisionSession({ initialPrompt: 'boot' })).rejects.toThrow('catalog backend failed');
            await expect.poll(() => existsSync(root)).toBe(false);
        } finally {
            await rm(homeDir, { recursive: true, force: true });
        }
    });

    it('awaits async provider runtime factories before validating the host runtime surface', async () => {
        const homeDir = await mkdtemp(join(os.tmpdir(), 'happier-catalog-execution-run-home-'));
        try {
            process.env.HAPPIER_HOME_DIR = homeDir;
            process.env.HAPPIER_SERVER_URL = 'https://api.example.test';
            process.env.HAPPIER_WEBAPP_URL = 'https://app.example.test';

            const { reloadConfiguration } = await import('@/configuration');
            reloadConfiguration();

	            const { createCatalogProviderExecutionRunBackend } = await import('./catalog');
	            const nativeRuntime = createStubRuntime();
	            const runtime = createCatalogProviderExecutionRunBackend({
	                agentId: 'qwen',
	                createRuntime: async () => nativeRuntime,
            }, {
                cwd: '/tmp/catalog-execution-run',
                backendId: 'qwen',
                runId: 'run_catalog_async_runtime',
                permissionMode: 'read_only',
                start: {
                    intent: 'review',
                    retentionPolicy: 'ephemeral',
                },
            });

            await expect(runtime.readResumeSupport()).resolves.toBe(false);
            await expect(runtime.provisionSession({ initialPrompt: 'boot' })).resolves.toEqual({ sessionId: 'session_1' });
        } finally {
            await rm(homeDir, { recursive: true, force: true });
        }
    });

    it('fails closed and cleans up ephemeral isolation when the provider runtime is not execution-run compatible', async () => {
        const homeDir = await mkdtemp(join(os.tmpdir(), 'happier-catalog-execution-run-home-'));
        try {
            process.env.HAPPIER_HOME_DIR = homeDir;
            process.env.HAPPIER_SERVER_URL = 'https://api.example.test';
            process.env.HAPPIER_WEBAPP_URL = 'https://app.example.test';

            const { reloadConfiguration, configuration } = await import('@/configuration');
            reloadConfiguration();

	            const { createCatalogProviderExecutionRunBackend } = await import('./catalog');
	            const runtime = createCatalogProviderExecutionRunBackend({
	                agentId: 'qwen',
	                createRuntime: () => ({ dispose: async () => undefined }) as unknown as ExecutionRunHostRuntime,
            }, {
                cwd: '/tmp/catalog-execution-run',
                backendId: 'qwen',
                runId: 'run_catalog_invalid_runtime',
                permissionMode: 'read_only',
                start: {
                    intent: 'review',
                    retentionPolicy: 'ephemeral',
                },
            });
            const root = join(configuration.activeServerDir, 'isolation', 'qwen', 'execution_run', 'run_catalog_invalid_runtime');

            await expect(runtime.provisionSession({ initialPrompt: 'boot' })).rejects.toThrow(
                'qwen execution-run backend must implement ExecutionRunHostRuntime',
            );
            await expect.poll(() => existsSync(root)).toBe(false);
        } finally {
            await rm(homeDir, { recursive: true, force: true });
        }
    });

    it('cleans up ephemeral isolation on dispose after successful backend construction', async () => {
        const homeDir = await mkdtemp(join(os.tmpdir(), 'happier-catalog-execution-run-home-'));
        try {
            process.env.HAPPIER_HOME_DIR = homeDir;
            process.env.HAPPIER_SERVER_URL = 'https://api.example.test';
            process.env.HAPPIER_WEBAPP_URL = 'https://app.example.test';

            const { reloadConfiguration, configuration } = await import('@/configuration');
            reloadConfiguration();

	            const { createCatalogProviderExecutionRunBackend } = await import('./catalog');
	            const nativeRuntime = createStubRuntime();
	            const runtime = createCatalogProviderExecutionRunBackend({
	                agentId: 'pi',
	                createRuntime: () => nativeRuntime,
            }, {
                cwd: '/tmp/catalog-execution-run',
                backendId: 'pi',
                runId: 'run_catalog_success',
                permissionMode: 'read_only',
                start: {
                    intent: 'review',
                    retentionPolicy: 'ephemeral',
                },
            });
            const root = join(configuration.activeServerDir, 'isolation', 'pi', 'execution_run', 'run_catalog_success');

            expect(existsSync(root)).toBe(true);
            await expect(runtime.provisionSession({ initialPrompt: 'boot' })).resolves.toEqual({ sessionId: 'session_1' });

            await runtime.dispose();

            expect(nativeRuntime.disposeSpy).toHaveBeenCalledTimes(1);
            await expect.poll(() => existsSync(root)).toBe(false);
        } finally {
            await rm(homeDir, { recursive: true, force: true });
        }
    });

    it('routes respondToPermission calls to the injected permission handler when present', async () => {
        const homeDir = await mkdtemp(join(os.tmpdir(), 'happier-catalog-execution-run-home-'));
        try {
            process.env.HAPPIER_HOME_DIR = homeDir;
            process.env.HAPPIER_SERVER_URL = 'https://api.example.test';
            process.env.HAPPIER_WEBAPP_URL = 'https://app.example.test';

            const { reloadConfiguration } = await import('@/configuration');
            reloadConfiguration();

            const { createCatalogProviderExecutionRunBackend } = await import('./catalog');
            let capturedHandler: any = null;
            const nativeRuntime = createStubRuntime();

	            const runtime = createCatalogProviderExecutionRunBackend({
	                agentId: 'pi',
	                createRuntime: (opts) => {
                    capturedHandler = opts.permissionHandler;
                    return nativeRuntime;
                },
            }, {
                cwd: '/tmp/catalog-execution-run',
                backendId: 'pi',
                runId: 'run_catalog_permissions',
                permissionMode: 'safe-yolo',
                start: {
                    intent: 'delegate',
                    retentionPolicy: 'ephemeral',
                },
            });

            await expect(runtime.provisionSession({ initialPrompt: 'boot' })).resolves.toEqual({ sessionId: 'session_1' });
            expect(capturedHandler).toBeTruthy();
            expect(runtime.permissionCapability).toBe('responds');

            // Safe-yolo write-like tools should block until a response is provided via respondToPermission.
            const pending = capturedHandler.handleToolCall('perm-1', 'bash', { command: 'bash -lc \"echo hi\"' });
            await expect(runtime.respondToPermission?.('perm-1', true)).resolves.toEqual({ delivered: true });
            await expect(pending).resolves.toEqual({ decision: 'approved' });
        } finally {
            await rm(homeDir, { recursive: true, force: true });
        }
    });
});
