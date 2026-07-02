import { existsSync, rmSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
    ExecutionRunHostRuntime,
    ExecutionRunHostRuntimeMessageHandler,
} from '@/agent/runtime/bridges/executionRun/executionRunHostRuntime';
import type { CreateCliExecutionRunBackendParams } from '@/agent/runtime/registry/engineRegistryTypes';

const TEST_PRIMARY_BACKEND_ID = `${'primary'}.${'backend'}`;

function createStubRuntime(): ExecutionRunHostRuntime & Readonly<{ disposeSpy: ReturnType<typeof vi.fn> }> {
    const disposeSpy = vi.fn(async () => {});
    let _handler: ExecutionRunHostRuntimeMessageHandler | null = null;
    return {
        async readResumeSupport() {
            return false;
        },
        async provisionSession() {
            return { sessionId: 'session_1' };
        },
        async sendPrompt() {},
        async cancel() {},
        subscribeMessages(handler) {
            _handler = handler;
            return () => {
                if (_handler === handler) {
                    _handler = null;
                }
            };
        },
        dispose: disposeSpy,
        disposeSpy,
    };
}

class ClassExecutionRunRuntime implements ExecutionRunHostRuntime {
    private handler: ExecutionRunHostRuntimeMessageHandler | null = null;
    readonly disposeSpy = vi.fn(async () => {});

    async readResumeSupport() {
        return false;
    }

    async provisionSession() {
        this.handler?.({ type: 'model-output', fullText: 'class-runtime-ready' });
        return { sessionId: 'class-session-1' };
    }

    async sendPrompt() {}

    async cancel() {}

    subscribeMessages(handler: ExecutionRunHostRuntimeMessageHandler) {
        this.handler = handler;
        return () => {
            if (this.handler === handler) {
                this.handler = null;
            }
        };
    }

    async dispose() {
        await this.disposeSpy();
    }
}

function createExecutionRunOpts(runId: string): CreateCliExecutionRunBackendParams {
    return {
        cwd: '/tmp/execution-run',
        runId,
        backendId: TEST_PRIMARY_BACKEND_ID,
        permissionMode: 'read_only',
        start: {
            intent: 'review',
            retentionPolicy: 'ephemeral',
        },
    };
}

afterEach(() => {
    vi.resetModules();
    delete process.env.HAPPIER_HOME_DIR;
    delete process.env.HAPPIER_SERVER_URL;
    delete process.env.HAPPIER_WEBAPP_URL;
});

describe('createDescriptorExecutionRunHostRuntime', () => {
    it('cleans up ephemeral isolation when resolveIsolation throws after creating the base bundle', async () => {
        const homeDir = await mkdtemp(join(os.tmpdir(), 'happier-execution-run-home-'));
        try {
            process.env.HAPPIER_HOME_DIR = homeDir;
            process.env.HAPPIER_SERVER_URL = 'https://api.example.test';
            process.env.HAPPIER_WEBAPP_URL = 'https://app.example.test';

            const { reloadConfiguration, configuration } = await import('@/configuration');
            reloadConfiguration();

            const { createDescriptorExecutionRunHostRuntime } = await import('./descriptor');
            const root = join(configuration.activeServerDir, 'isolation', TEST_PRIMARY_BACKEND_ID, 'execution_run', 'run_resolve_throw');

            const createdRuntime = createDescriptorExecutionRunHostRuntime(createExecutionRunOpts('run_resolve_throw'), {
                resolveIsolation() {
                    throw new Error('resolve isolation failed');
                },
                factory: () => createStubRuntime(),
            });

            expect(createdRuntime).not.toBeNull();
            await expect(createdRuntime?.provisionSession()).rejects.toThrow('resolve isolation failed');
            expect(existsSync(root)).toBe(false);
        } finally {
            await rm(homeDir, { recursive: true, force: true });
        }
    });

    it('awaits ephemeral isolation cleanup before surfacing descriptor factory failure', async () => {
        const homeDir = await mkdtemp(join(os.tmpdir(), 'happier-execution-run-home-'));
        try {
            process.env.HAPPIER_HOME_DIR = homeDir;
            process.env.HAPPIER_SERVER_URL = 'https://api.example.test';
            process.env.HAPPIER_WEBAPP_URL = 'https://app.example.test';

            const { reloadConfiguration, configuration } = await import('@/configuration');
            reloadConfiguration();

            const { createDescriptorExecutionRunHostRuntime } = await import('./descriptor');
            const root = join(configuration.activeServerDir, 'isolation', TEST_PRIMARY_BACKEND_ID, 'execution_run', 'run_factory_throw');
            let cleanupCalls = 0;
            let cleanupFinished = false;

            const createdRuntime = createDescriptorExecutionRunHostRuntime(createExecutionRunOpts('run_factory_throw'), {
                resolveIsolation(_request, baseBundle) {
                    return {
                        ...baseBundle,
                        cleanup: async () => {
                            cleanupCalls += 1;
                            await Promise.resolve();
                            rmSync(root, { recursive: true, force: true });
                            cleanupFinished = true;
                        },
                    };
                },
                factory: () => {
                    throw new Error('factory failed');
                },
            });

            expect(createdRuntime).not.toBeNull();
            await expect(createdRuntime?.provisionSession()).rejects.toThrow('factory failed');
            expect(cleanupCalls).toBe(1);
            expect(cleanupFinished).toBe(true);
            expect(existsSync(root)).toBe(false);
        } finally {
            await rm(homeDir, { recursive: true, force: true });
        }
    });

    it('keeps cleanup attached to dispose for successful ephemeral runtimes', async () => {
        const homeDir = await mkdtemp(join(os.tmpdir(), 'happier-execution-run-home-'));
        try {
            process.env.HAPPIER_HOME_DIR = homeDir;
            process.env.HAPPIER_SERVER_URL = 'https://api.example.test';
            process.env.HAPPIER_WEBAPP_URL = 'https://app.example.test';

            const { reloadConfiguration, configuration } = await import('@/configuration');
            reloadConfiguration();

            const { createDescriptorExecutionRunHostRuntime } = await import('./descriptor');
            const root = join(configuration.activeServerDir, 'isolation', TEST_PRIMARY_BACKEND_ID, 'execution_run', 'run_success');
            const runtime = createStubRuntime();
            let cleanupCalls = 0;

            const createdRuntime = createDescriptorExecutionRunHostRuntime(createExecutionRunOpts('run_success'), {
                resolveIsolation(_request, baseBundle) {
                    return {
                        ...baseBundle,
                        cleanup: () => {
                            cleanupCalls += 1;
                            rmSync(root, { recursive: true, force: true });
                        },
                    };
                },
                factory: () => runtime,
            });

            expect(createdRuntime).not.toBeNull();
            await expect(createdRuntime?.provisionSession()).resolves.toEqual({ sessionId: 'session_1' });
            expect(existsSync(root)).toBe(true);

            await createdRuntime?.dispose();

            expect(runtime.disposeSpy).toHaveBeenCalledTimes(1);
            expect(cleanupCalls).toBe(1);
            expect(existsSync(root)).toBe(false);
        } finally {
            await rm(homeDir, { recursive: true, force: true });
        }
    });

    it('preserves class-based runtime methods when attaching cleanup to successful ephemeral runtimes', async () => {
        const homeDir = await mkdtemp(join(os.tmpdir(), 'happier-execution-run-home-'));
        try {
            process.env.HAPPIER_HOME_DIR = homeDir;
            process.env.HAPPIER_SERVER_URL = 'https://api.example.test';
            process.env.HAPPIER_WEBAPP_URL = 'https://app.example.test';

            const { reloadConfiguration, configuration } = await import('@/configuration');
            reloadConfiguration();

            const { createDescriptorExecutionRunHostRuntime } = await import('./descriptor');
            const root = join(configuration.activeServerDir, 'isolation', TEST_PRIMARY_BACKEND_ID, 'execution_run', 'run_class_success');
            const runtime = new ClassExecutionRunRuntime();
            const messages: string[] = [];

            const createdRuntime = createDescriptorExecutionRunHostRuntime(createExecutionRunOpts('run_class_success'), {
                resolveIsolation(_request, baseBundle) {
                    return {
                        ...baseBundle,
                        cleanup: () => {
                            rmSync(root, { recursive: true, force: true });
                        },
                    };
                },
                factory: () => runtime,
            });

            expect(createdRuntime).not.toBeNull();
            const unsubscribe = createdRuntime!.subscribeMessages((message) => {
                if (message.type === 'model-output' && typeof message.fullText === 'string') {
                    messages.push(message.fullText);
                }
            });

            await expect(createdRuntime?.provisionSession()).resolves.toEqual({ sessionId: 'class-session-1' });
            unsubscribe();
            expect(messages).toEqual(['class-runtime-ready']);
            await createdRuntime?.dispose();
            expect(runtime.disposeSpy).toHaveBeenCalledTimes(1);
            expect(existsSync(root)).toBe(false);
        } finally {
            await rm(homeDir, { recursive: true, force: true });
        }
    });
});
