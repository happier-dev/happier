import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { CodexRolloutFollowerRuntime } from './CodexRolloutFollowerRuntime';
import type { JsonlFollowPolicyInputV1 } from '@/api/session/fileBackedTranscripts/jsonl/followPolicy';

const tempDirs = new Set<string>();

function rememberTempDir(path: string): string {
    tempDirs.add(path);
    return path;
}

function sessionMetaLine(payload: Record<string, unknown>): string {
    return `${JSON.stringify({ type: 'session_meta', payload })}\n`;
}

function responseItemLine(params: { timestamp: string; payload: Record<string, unknown> }): string {
    return `${JSON.stringify({ type: 'response_item', timestamp: params.timestamp, payload: params.payload })}\n`;
}

async function waitUntil(predicate: () => boolean, timeoutMs = 500): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate() && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
}

afterEach(async () => {
    for (const dir of tempDirs) {
        await rm(dir, { recursive: true, force: true });
    }
    tempDirs.clear();
});

describe('CodexRolloutFollowerRuntime', () => {
    it('closes a completed subagent follower without dropping retained runtime state', async () => {
        const root = rememberTempDir(await mkdtemp(join(tmpdir(), 'happier-codex-rollout-follower-runtime-')));
        const codexHome = join(root, 'codex-home');
        const sessionsDir = join(codexHome, 'sessions');
        await mkdir(sessionsDir, { recursive: true });

        const parentThreadId = 'parent-thread';
        const childThreadId = 'child-thread';
        const parentFilePath = join(sessionsDir, `rollout-2026-01-02T00-00-00-${parentThreadId}.jsonl`);
        const childFilePath = join(sessionsDir, `rollout-2026-01-02T00-00-01-${childThreadId}.jsonl`);
        await writeFile(parentFilePath, sessionMetaLine({ id: parentThreadId }), 'utf8');
        await writeFile(
            childFilePath,
            sessionMetaLine({ id: childThreadId })
            + responseItemLine({
                timestamp: '2026-01-02T00:00:01.000Z',
                payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'child first' }] },
            }),
            'utf8',
        );

        const subagentRows: unknown[] = [];
        const runtime = new CodexRolloutFollowerRuntime({
            filePath: parentFilePath,
            codexHome,
            pollIntervalMs: 10,
            onMainJson: () => undefined,
            onSubagentJson: (_threadId, value) => {
                subagentRows.push(value);
            },
        });

        try {
            await runtime.start();
            await runtime.ensureSubagentFollower(childThreadId);
            await waitUntil(() => subagentRows.length >= 2);

            expect(subagentRows).toHaveLength(2);
            expect(runtime.closeSubagentFollower).toEqual(expect.any(Function));
            await runtime.closeSubagentFollower(childThreadId, { graceMs: 0 });

            await appendFile(
                childFilePath,
                responseItemLine({
                    timestamp: '2026-01-02T00:00:02.000Z',
                    payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'after close' }] },
                }),
                'utf8',
            );
            await new Promise((resolve) => setTimeout(resolve, 50));

            expect(JSON.stringify(subagentRows)).not.toContain('after close');
        } finally {
            await runtime.stop();
        }
    });

    it('bounds active subagent followers by policy at registration time', async () => {
        const root = rememberTempDir(await mkdtemp(join(tmpdir(), 'happier-codex-rollout-follower-runtime-cap-')));
        const codexHome = join(root, 'codex-home');
        const sessionsDir = join(codexHome, 'sessions');
        await mkdir(sessionsDir, { recursive: true });

        const parentThreadId = 'parent-thread';
        const firstChildThreadId = 'child-one';
        const secondChildThreadId = 'child-two';
        const parentFilePath = join(sessionsDir, `rollout-2026-01-02T00-00-00-${parentThreadId}.jsonl`);
        const firstChildFilePath = join(sessionsDir, `rollout-2026-01-02T00-00-01-${firstChildThreadId}.jsonl`);
        const secondChildFilePath = join(sessionsDir, `rollout-2026-01-02T00-00-02-${secondChildThreadId}.jsonl`);
        await writeFile(parentFilePath, sessionMetaLine({ id: parentThreadId }), 'utf8');
        await writeFile(firstChildFilePath, sessionMetaLine({ id: firstChildThreadId }), 'utf8');
        await writeFile(secondChildFilePath, sessionMetaLine({ id: secondChildThreadId }), 'utf8');

        const subagentThreads: string[] = [];
        const runtime = new CodexRolloutFollowerRuntime({
            filePath: parentFilePath,
            codexHome,
            pollIntervalMs: 10,
            followPolicy: { maxActiveFollowersPerSession: 1 } satisfies JsonlFollowPolicyInputV1,
            onMainJson: () => undefined,
            onSubagentJson: (threadId) => {
                subagentThreads.push(threadId);
            },
        });

        try {
            await runtime.start();
            await runtime.ensureSubagentFollower(firstChildThreadId);
            await runtime.ensureSubagentFollower(secondChildThreadId);
            await waitUntil(() => subagentThreads.length >= 1);

            expect(subagentThreads).toEqual([firstChildThreadId]);
        } finally {
            await runtime.stop();
        }
    });
});
