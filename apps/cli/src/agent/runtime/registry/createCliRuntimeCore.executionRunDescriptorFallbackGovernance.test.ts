import { readFileSync } from 'node:fs';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type {
    ExecutionRunHostRuntime,
    ExecutionRunHostRuntimeMessageHandler,
} from '@/agent/runtime/bridges/executionRun/executionRunHostRuntime';
import type { ResolvedAgentRuntimeContribution } from '@/plugins/projection/registry/types';


function createStubRuntime(): ExecutionRunHostRuntime {
    let handler: ExecutionRunHostRuntimeMessageHandler | null = null;
    return {
        async readResumeSupport() {
            return false;
        },
        async provisionSession() {
            handler?.({ type: 'model-output', fullText: 'started' });
            return { sessionId: 's1' };
        },
        async sendPrompt() {},
        async cancel() {},
        subscribeMessages(next) {
            handler = next;
            return () => {
                if (handler === next) handler = null;
            };
        },
        async dispose() {},
    };
}

function createBuiltInBackendContribution(backendId: string): ResolvedAgentRuntimeContribution {
    return {
        id: backendId,
        agentId: 'built-in-provider',
        provenance: 'first_party',
        source: { kind: 'bundled' },
        definition: { kindVersion: 1, id: backendId, agentId: 'built-in-provider' },
        runtimeKind: 'native',
    };
}

describe('createCliRuntimeCore execution-run descriptor fallback governance', () => {
    beforeEach(() => {
        vi.resetModules();
    });

    it('fails closed for non-review execution runs when no bound runtimeCore exist even if terminalRuntime launch is available', async () => {
        const descriptorFactory = vi.fn(() => createStubRuntime());

        const launch = vi.fn(async () => createStubRuntime());

        const { createMissingCliEngineAdapter } = await import('./createCliRuntimeCore');
        const runtimeCore = createMissingCliEngineAdapter({
            backend: createBuiltInBackendContribution('codex'),
        }).runtimeCore;

        expect(() => runtimeCore.createExecutionRunBackend({
            cwd: '/tmp',
            backendId: 'codex',
            permissionMode: 'read_only',
        })).toThrow(/bound host runtimeCore/i);

        expect(launch).not.toHaveBeenCalled();
        expect(descriptorFactory).not.toHaveBeenCalled();
    });

    it('fails closed for interactive sessions when no bound runtimeCore exist even if terminalRuntime launch is available', async () => {
        const launch = vi.fn(async () => createStubRuntime());

        const { createMissingCliEngineAdapter } = await import('./createCliRuntimeCore');
        const runtimeCore = createMissingCliEngineAdapter({
            backend: createBuiltInBackendContribution('codex'),
        }).runtimeCore;

        await expect(
            runtimeCore.createSessionRuntime({
                cwd: '/tmp',
            }),
        ).rejects.toThrow(/bound host runtimeCore/i);

        expect(launch).not.toHaveBeenCalled();
    });

    it('does not keep descriptor-backed execution-run creation in createCliRuntimeCore', () => {
        const source = readFileSync(new URL('./createCliRuntimeCore.ts', import.meta.url), 'utf8');

        expect(source).not.toContain('executionRunBackendRegistry');
        expect(source).not.toContain('createDescriptorBackend');
    });
});
