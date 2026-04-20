import { afterEach, describe, expect, it } from 'vitest';

import type { ExecutionRunHostRuntime } from '@/agent/runtime/bridges/executionRun/executionRunHostRuntime';

import { createCodexAcpBackend } from '../acp/backend';

describe('Codex ACP execution-run backend', () => {
    const originalEnv = { ...process.env };

    afterEach(() => {
        process.env = { ...originalEnv };
    });

    it('exposes the Codex ACP backend as an execution-run host runtime at the provider boundary', () => {
        process.env.HAPPIER_CODEX_ACP_BIN = '/bin/echo';

        const created = createCodexAcpBackend({
            cwd: process.cwd(),
            env: {},
        });

        const runtime: ExecutionRunHostRuntime = created.backend;
        expect(runtime).toBe(created.backend);
        expect(typeof created.backend.readResumeSupport).toBe('function');
        expect(typeof created.backend.provisionSession).toBe('function');
        expect(typeof created.backend.subscribeMessages).toBe('function');
        expect(typeof created.backend.dispose).toBe('function');
    });
});
