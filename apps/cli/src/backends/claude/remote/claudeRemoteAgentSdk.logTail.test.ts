import { describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';

import { claudeRemoteAgentSdk } from './claudeRemoteAgentSdk';
import { makeMode } from './claudeRemoteAgentSdk.testkit';

describe('claudeRemoteAgentSdk error artifacts', () => {
    it('attaches tail text for debug/stderr logs (bounded) when the Agent SDK runner throws', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'happier-claude-agent-sdk-logtail-'));
        const artifactsDir = join(dir, 'artifacts');
        await mkdir(artifactsDir, { recursive: true });

        const prevArtifactsDir = process.env.HAPPIER_CLAUDE_DEBUG_ARTIFACTS_DIR;
        const prevArtifactsEnabled = process.env.HAPPIER_SUBPROCESS_ARTIFACTS_ENABLED;
        const prevStderrMaxBytes = process.env.HAPPIER_SUBPROCESS_STDERR_MAX_BYTES;
        process.env.HAPPIER_CLAUDE_DEBUG_ARTIFACTS_DIR = artifactsDir;
        process.env.HAPPIER_SUBPROCESS_ARTIFACTS_ENABLED = '1';
        process.env.HAPPIER_SUBPROCESS_STDERR_MAX_BYTES = '1000000';

        try {
            let didSendFirst = false;
            const nextMessage = vi.fn(async () => {
                if (didSendFirst) return null;
                didSendFirst = true;
                return { message: 'hello', mode: makeMode({ claudeRemoteAgentSdkEnabled: true } as any) };
            });

            const createQuery = vi.fn((params: any) => {
                const opts = params?.options ?? {};
                const debugFile = typeof opts.debugFile === 'string' ? String(opts.debugFile) : '';

                const begin = 'BEGIN_MARKER';
                const end = 'END_MARKER';
                const pad = 'x'.repeat(3_000_000); // > default filesReadMaxBytes
                const debugText = `${begin}\n${pad}\n${end}\n`;

                if (debugFile) {
                    writeFileSync(debugFile, debugText, 'utf8');
                }

                if (typeof opts.stderr === 'function') {
                    opts.stderr('STDERR_MARKER\n');
                }

                return {
                    async *[Symbol.asyncIterator]() {
                        throw new Error('boom');
                    },
                    close: vi.fn(),
                    setPermissionMode: vi.fn(),
                    setModel: vi.fn(),
                    setMaxThinkingTokens: vi.fn(),
                    supportedCommands: vi.fn(async () => []),
                    supportedModels: vi.fn(async () => []),
                } as any;
            });

            let caught: any = null;
            await claudeRemoteAgentSdk({
                sessionId: null,
                transcriptPath: null,
                path: dir,
                claudeArgs: [],
                jsRuntime: 'node',
                claudeExecutablePath: '/tmp/claude',
                canCallTool: async () => ({ behavior: 'allow', updatedInput: {} }),
                isAborted: () => false,
                nextMessage,
                onReady: () => {},
                onSessionFound: () => {},
                onMessage: () => {},
                createQuery,
            } as any).catch((e) => {
                caught = e;
            });

            expect(caught).toBeTruthy();
            expect(String(caught?.message ?? '')).toContain('boom');
            const artifacts = caught?.happierClaudeCodeArtifacts ?? null;
            expect(typeof artifacts?.debugFilePath).toBe('string');
            expect(typeof artifacts?.stderrFilePath).toBe('string');
            expect(typeof artifacts?.debugTail).toBe('string');
            expect(typeof artifacts?.stderrTail).toBe('string');

            expect(String(artifacts.debugTail)).toContain('END_MARKER');
            expect(String(artifacts.debugTail)).not.toContain('BEGIN_MARKER');
            expect(String(artifacts.stderrTail)).toContain('STDERR_MARKER');
        } finally {
            if (prevArtifactsDir === undefined) delete process.env.HAPPIER_CLAUDE_DEBUG_ARTIFACTS_DIR;
            else process.env.HAPPIER_CLAUDE_DEBUG_ARTIFACTS_DIR = prevArtifactsDir;
            if (prevArtifactsEnabled === undefined) delete process.env.HAPPIER_SUBPROCESS_ARTIFACTS_ENABLED;
            else process.env.HAPPIER_SUBPROCESS_ARTIFACTS_ENABLED = prevArtifactsEnabled;
            if (prevStderrMaxBytes === undefined) delete process.env.HAPPIER_SUBPROCESS_STDERR_MAX_BYTES;
            else process.env.HAPPIER_SUBPROCESS_STDERR_MAX_BYTES = prevStderrMaxBytes;
        }
    }, 30_000);
});

