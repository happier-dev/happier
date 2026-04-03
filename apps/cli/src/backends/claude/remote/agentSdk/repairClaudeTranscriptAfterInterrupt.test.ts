import { appendFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';
import { getProjectPath } from '@/backends/claude/utils/path';

describe('repairClaudeTranscriptAfterInterrupt', () => {
    it('repairs transcripts without relying on full-file reads (tail-read)', async () => {
        vi.resetModules();
        vi.doMock('node:fs/promises', async (importOriginal) => {
            const original = (await importOriginal()) as typeof import('node:fs/promises');
            return {
                ...original,
                // If the implementation still uses readFile(), it will fail to repair and this test should fail.
                readFile: vi.fn(async () => {
                    throw new Error('readFile disabled by test');
                }),
            };
        });

        const baseDir = await mkdtemp(join(tmpdir(), 'happier-claude-repair-tail-read-'));
        const claudeConfigDir = join(baseDir, 'claude-config');
        const workDir = join(baseDir, 'work');
        await mkdir(claudeConfigDir, { recursive: true });
        await mkdir(workDir, { recursive: true });
        const projectDir = getProjectPath(workDir, claudeConfigDir);
        await mkdir(projectDir, { recursive: true });
        const transcriptPath = join(projectDir, 'sess_1.jsonl');

        await writeFile(
            transcriptPath,
            JSON.stringify({
                type: 'assistant',
                uuid: 'asst_1',
                isSidechain: false,
                message: {
                    role: 'assistant',
                    content: [
                        {
                            type: 'tool_use',
                            id: 'toolu_1',
                            name: 'Bash',
                            input: { command: 'sleep 1000' },
                        },
                    ],
                },
            }) + '\n',
            'utf8',
        );

        const { repairClaudeTranscriptAfterInterrupt } = await import('./repairClaudeTranscriptAfterInterrupt');

        await repairClaudeTranscriptAfterInterrupt({
            sessionId: 'sess_1',
            transcriptPath,
            workDir,
            claudeConfigDir,
        });

        const updated = await readFile(transcriptPath, 'utf8');
        expect(updated).toContain('\"type\":\"tool_result\"');
        expect(updated).toContain('\"tool_use_id\":\"toolu_1\"');
        expect(updated).toContain('Interrupted');
    });

    it('waits briefly for an in-flight tool_result to land and avoids appending a duplicate interrupted tool_result', async () => {
        const previousTimeout = process.env.HAPPIER_CLAUDE_TRANSCRIPT_REPAIR_WAIT_TOOL_USE_IDS_TIMEOUT_MS;
        const previousPoll = process.env.HAPPIER_CLAUDE_TRANSCRIPT_REPAIR_WAIT_TOOL_USE_IDS_POLL_INTERVAL_MS;
        process.env.HAPPIER_CLAUDE_TRANSCRIPT_REPAIR_WAIT_TOOL_USE_IDS_TIMEOUT_MS = '250';
        process.env.HAPPIER_CLAUDE_TRANSCRIPT_REPAIR_WAIT_TOOL_USE_IDS_POLL_INTERVAL_MS = '10';
        try {
            vi.resetModules();
            const baseDir = await mkdtemp(join(tmpdir(), 'happier-claude-repair-wait-dupe-'));
            const claudeConfigDir = join(baseDir, 'claude-config');
            const workDir = join(baseDir, 'work');
            await mkdir(claudeConfigDir, { recursive: true });
            await mkdir(workDir, { recursive: true });
            const projectDir = getProjectPath(workDir, claudeConfigDir);
            await mkdir(projectDir, { recursive: true });
            const transcriptPath = join(projectDir, 'sess_1.jsonl');

            await writeFile(
                transcriptPath,
                `${JSON.stringify({
                    type: 'assistant',
                    uuid: 'asst_1',
                    isSidechain: false,
                    message: {
                        role: 'assistant',
                        content: [
                            {
                                type: 'tool_use',
                                id: 'toolu_1',
                                name: 'Bash',
                                input: { command: 'sleep 1000' },
                            },
                        ],
                    },
                })}\n`,
                'utf8',
            );

            void (async () => {
                await new Promise((resolve) => setTimeout(resolve, 25));
                await appendFile(
                    transcriptPath,
                    `${JSON.stringify({
                        type: 'user',
                        uuid: 'user_1',
                        isSidechain: false,
                        message: {
                            role: 'user',
                            content: [
                                {
                                    type: 'tool_result',
                                    tool_use_id: 'toolu_1',
                                    content: 'Real tool result',
                                    is_error: false,
                                },
                            ],
                        },
                    })}\n`,
                    'utf8',
                );
            })();

            const { repairClaudeTranscriptAfterInterrupt } = await import('./repairClaudeTranscriptAfterInterrupt');
            await repairClaudeTranscriptAfterInterrupt({
                sessionId: 'sess_1',
                transcriptPath,
                workDir,
                claudeConfigDir,
            });

            const updated = await readFile(transcriptPath, 'utf8');
            const entries = updated
                .split('\n')
                .map((line) => line.trim())
                .filter(Boolean)
                .map((line) => JSON.parse(line) as any);

            const toolResultsForTool = entries.filter((entry) => {
                const blocks = entry?.message?.content;
                if (!Array.isArray(blocks)) return false;
                return blocks.some((b: any) => b?.type === 'tool_result' && b?.tool_use_id === 'toolu_1');
            });
            expect(toolResultsForTool).toHaveLength(1);
            expect(updated).not.toContain('Interrupted');
        } finally {
            if (previousTimeout === undefined) {
                delete process.env.HAPPIER_CLAUDE_TRANSCRIPT_REPAIR_WAIT_TOOL_USE_IDS_TIMEOUT_MS;
            } else {
                process.env.HAPPIER_CLAUDE_TRANSCRIPT_REPAIR_WAIT_TOOL_USE_IDS_TIMEOUT_MS = previousTimeout;
            }
            if (previousPoll === undefined) {
                delete process.env.HAPPIER_CLAUDE_TRANSCRIPT_REPAIR_WAIT_TOOL_USE_IDS_POLL_INTERVAL_MS;
            } else {
                process.env.HAPPIER_CLAUDE_TRANSCRIPT_REPAIR_WAIT_TOOL_USE_IDS_POLL_INTERVAL_MS = previousPoll;
            }
        }
    });

    it('waits briefly for an in-flight trailing JSONL line to settle before truncating', async () => {
        const previousTimeout = process.env.HAPPIER_CLAUDE_TRANSCRIPT_REPAIR_WAIT_TOOL_USE_IDS_TIMEOUT_MS;
        const previousPoll = process.env.HAPPIER_CLAUDE_TRANSCRIPT_REPAIR_WAIT_TOOL_USE_IDS_POLL_INTERVAL_MS;
        process.env.HAPPIER_CLAUDE_TRANSCRIPT_REPAIR_WAIT_TOOL_USE_IDS_TIMEOUT_MS = '250';
        process.env.HAPPIER_CLAUDE_TRANSCRIPT_REPAIR_WAIT_TOOL_USE_IDS_POLL_INTERVAL_MS = '10';
        try {
            vi.resetModules();
            const baseDir = await mkdtemp(join(tmpdir(), 'happier-claude-repair-tail-settle-'));
            const claudeConfigDir = join(baseDir, 'claude-config');
            const workDir = join(baseDir, 'work');
            await mkdir(claudeConfigDir, { recursive: true });
            await mkdir(workDir, { recursive: true });
            const projectDir = getProjectPath(workDir, claudeConfigDir);
            await mkdir(projectDir, { recursive: true });
            const transcriptPath = join(projectDir, 'sess_1.jsonl');

            await writeFile(
                transcriptPath,
                `${JSON.stringify({
                    type: 'assistant',
                    uuid: 'asst_1',
                    isSidechain: false,
                    message: {
                        role: 'assistant',
                        content: [{ type: 'text', text: 'hi' }],
                    },
                })}\n`,
                'utf8',
            );

            const fullSecondLine = JSON.stringify({
                type: 'user',
                uuid: 'late1',
                isSidechain: false,
                message: {
                    role: 'user',
                    content: [{ type: 'text', text: 'PARTIAL' }],
                },
            });
            const splitIndex = fullSecondLine.indexOf('PARTIAL') + 'PART'.length;
            const prefix = fullSecondLine.slice(0, splitIndex);
            const suffix = fullSecondLine.slice(splitIndex);

            await appendFile(transcriptPath, prefix, 'utf8');
            void (async () => {
                await new Promise((resolve) => setTimeout(resolve, 25));
                await appendFile(transcriptPath, `${suffix}\n`, 'utf8');
            })();

            const { repairClaudeTranscriptAfterInterrupt } = await import('./repairClaudeTranscriptAfterInterrupt');
            await repairClaudeTranscriptAfterInterrupt({
                sessionId: 'sess_1',
                transcriptPath,
                workDir,
                claudeConfigDir,
            });

            const updated = await readFile(transcriptPath, 'utf8');
            expect(updated).toContain('\"uuid\":\"late1\"');
            expect(updated).toContain('PARTIAL');

            const lines = updated
                .split('\n')
                .map((line) => line.trim())
                .filter(Boolean);
            expect(lines).toHaveLength(2);
            expect(() => JSON.parse(lines[1] as string)).not.toThrow();
        } finally {
            if (previousTimeout === undefined) {
                delete process.env.HAPPIER_CLAUDE_TRANSCRIPT_REPAIR_WAIT_TOOL_USE_IDS_TIMEOUT_MS;
            } else {
                process.env.HAPPIER_CLAUDE_TRANSCRIPT_REPAIR_WAIT_TOOL_USE_IDS_TIMEOUT_MS = previousTimeout;
            }
            if (previousPoll === undefined) {
                delete process.env.HAPPIER_CLAUDE_TRANSCRIPT_REPAIR_WAIT_TOOL_USE_IDS_POLL_INTERVAL_MS;
            } else {
                process.env.HAPPIER_CLAUDE_TRANSCRIPT_REPAIR_WAIT_TOOL_USE_IDS_POLL_INTERVAL_MS = previousPoll;
            }
        }
    });

    it('does not write outside the Claude project directory when sessionId contains path traversal', async () => {
        const baseDir = await mkdtemp(join(tmpdir(), 'happier-claude-repair-path-traversal-'));
        const claudeConfigDir = join(baseDir, 'claude-config');
        const workDir = join(baseDir, 'work');
        await mkdir(claudeConfigDir, { recursive: true });
        await mkdir(workDir, { recursive: true });

        const projectPath = join(claudeConfigDir, 'projects');
        await mkdir(projectPath, { recursive: true });

        // This sessionId would escape the project directory when joined into `${sessionId}.jsonl`.
        const sessionId = '../../evil';
        const evilPath = join(claudeConfigDir, 'evil.jsonl');

        await writeFile(
            evilPath,
            JSON.stringify({
                type: 'assistant',
                uuid: 'asst_1',
                isSidechain: false,
                message: {
                    role: 'assistant',
                    content: [
                        {
                            type: 'tool_use',
                            id: 'toolu_1',
                            name: 'Bash',
                            input: { command: 'sleep 1000' },
                        },
                    ],
                },
            }) + '\n',
            'utf8',
        );

        const { repairClaudeTranscriptAfterInterrupt } = await import('./repairClaudeTranscriptAfterInterrupt');

        await repairClaudeTranscriptAfterInterrupt({
            sessionId,
            transcriptPath: null,
            workDir,
            claudeConfigDir,
        });

        const updated = await readFile(evilPath, 'utf8');
        expect(updated).not.toContain('\"type\":\"tool_result\"');
        expect(updated).not.toContain('Interrupted');
    });

    it('does not write to an explicit transcriptPath outside the Claude project directory', async () => {
        const baseDir = await mkdtemp(join(tmpdir(), 'happier-claude-repair-explicit-outside-'));
        const claudeConfigDir = join(baseDir, 'claude-config');
        const workDir = join(baseDir, 'work');
        await mkdir(claudeConfigDir, { recursive: true });
        await mkdir(workDir, { recursive: true });

        const projectDir = getProjectPath(workDir, claudeConfigDir);
        await mkdir(projectDir, { recursive: true });

        const outsideTranscriptPath = join(baseDir, 'outside.jsonl');
        await writeFile(
            outsideTranscriptPath,
            JSON.stringify({
                type: 'assistant',
                uuid: 'asst_1',
                isSidechain: false,
                message: {
                    role: 'assistant',
                    content: [
                        {
                            type: 'tool_use',
                            id: 'toolu_1',
                            name: 'Bash',
                            input: { command: 'sleep 1000' },
                        },
                    ],
                },
            }) + '\n',
            'utf8',
        );

        vi.resetModules();
        const { repairClaudeTranscriptAfterInterrupt } = await import('./repairClaudeTranscriptAfterInterrupt');
        await repairClaudeTranscriptAfterInterrupt({
            sessionId: 'sess_1',
            transcriptPath: outsideTranscriptPath,
            workDir,
            claudeConfigDir,
        });

        const updated = await readFile(outsideTranscriptPath, 'utf8');
        expect(updated).not.toContain('\"type\":\"tool_result\"');
        expect(updated).not.toContain('Interrupted');
    });

    it('skips repair when the transcript is still actively being written (requires a settled file)', async () => {
        const previousTimeout = process.env.HAPPIER_CLAUDE_TRANSCRIPT_REPAIR_WAIT_TOOL_USE_IDS_TIMEOUT_MS;
        const previousPoll = process.env.HAPPIER_CLAUDE_TRANSCRIPT_REPAIR_WAIT_TOOL_USE_IDS_POLL_INTERVAL_MS;
        process.env.HAPPIER_CLAUDE_TRANSCRIPT_REPAIR_WAIT_TOOL_USE_IDS_TIMEOUT_MS = '50';
        process.env.HAPPIER_CLAUDE_TRANSCRIPT_REPAIR_WAIT_TOOL_USE_IDS_POLL_INTERVAL_MS = '10';
        try {
            const baseDir = await mkdtemp(join(tmpdir(), 'happier-claude-repair-settle-skip-'));
            const claudeConfigDir = join(baseDir, 'claude-config');
            const workDir = join(baseDir, 'work');
            await mkdir(claudeConfigDir, { recursive: true });
            await mkdir(workDir, { recursive: true });

            const projectDir = getProjectPath(workDir, claudeConfigDir);
            await mkdir(projectDir, { recursive: true });
            const transcriptPath = join(projectDir, 'sess_1.jsonl');

            await writeFile(
                transcriptPath,
                `${JSON.stringify({
                    type: 'assistant',
                    uuid: 'asst_1',
                    isSidechain: false,
                    message: {
                        role: 'assistant',
                        content: [
                            {
                                type: 'tool_use',
                                id: 'toolu_1',
                                name: 'Bash',
                                input: { command: 'sleep 1000' },
                            },
                        ],
                    },
                })}\n`,
                'utf8',
            );

            let tick = 0;
            const interval = setInterval(() => {
                tick += 1;
                void appendFile(
                    transcriptPath,
                    `${JSON.stringify({
                        type: 'system',
                        uuid: `tick_${tick}`,
                        isSidechain: false,
                        message: { role: 'system', content: [{ type: 'text', text: 'busy' }] },
                    })}\n`,
                    'utf8',
                ).catch(() => {});
            }, 5);

            setTimeout(() => clearInterval(interval), 150).unref?.();

            vi.resetModules();
            const { repairClaudeTranscriptAfterInterrupt } = await import('./repairClaudeTranscriptAfterInterrupt');
            await repairClaudeTranscriptAfterInterrupt({
                sessionId: 'sess_1',
                transcriptPath,
                workDir,
                claudeConfigDir,
            });

            await new Promise((resolve) => setTimeout(resolve, 175));

            const updated = await readFile(transcriptPath, 'utf8');
            expect(updated).not.toContain('\"type\":\"tool_result\"');
            expect(updated).not.toContain('Interrupted');
        } finally {
            if (previousTimeout === undefined) {
                delete process.env.HAPPIER_CLAUDE_TRANSCRIPT_REPAIR_WAIT_TOOL_USE_IDS_TIMEOUT_MS;
            } else {
                process.env.HAPPIER_CLAUDE_TRANSCRIPT_REPAIR_WAIT_TOOL_USE_IDS_TIMEOUT_MS = previousTimeout;
            }
            if (previousPoll === undefined) {
                delete process.env.HAPPIER_CLAUDE_TRANSCRIPT_REPAIR_WAIT_TOOL_USE_IDS_POLL_INTERVAL_MS;
            } else {
                process.env.HAPPIER_CLAUDE_TRANSCRIPT_REPAIR_WAIT_TOOL_USE_IDS_POLL_INTERVAL_MS = previousPoll;
            }
        }
    });
});
