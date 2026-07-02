import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { exportClaudeSessionBundle, importClaudeSessionBundle } from './bundle.js';
import { resolveClaudeProjectId } from './path.js';

describe('Claude handoff bundle leaf', () => {
    it('exports from the linked external-session source before stale transcript metadata', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-claude-plugin-handoff-export-'));
        const staleTranscriptPath = join(root, 'stale.jsonl');
        const configDir = join(root, '.claude');
        const liveTranscriptPath = join(configDir, 'projects', 'project-live', 'session-1.jsonl');
        await mkdir(join(configDir, 'projects', 'project-live'), { recursive: true });
        await writeFile(staleTranscriptPath, '{"type":"assistant","text":"stale"}\n', 'utf8');
        await writeFile(liveTranscriptPath, '{"type":"assistant","text":"live"}\n', 'utf8');

        const bundle = await exportClaudeSessionBundle({
            metadata: {
                path: join(root, 'workspace'),
                claudeTranscriptPath: staleTranscriptPath,
                externalSessionV1: {
                    source: { kind: 'claudeConfig', configDir, projectId: 'project-live' },
                },
            },
            remoteSessionId: 'session-1',
            env: {},
        });

        expect(bundle).toEqual({
            providerId: 'claude',
            remoteSessionId: 'session-1',
            transcriptBase64: Buffer.from('{"type":"assistant","text":"live"}\n', 'utf8').toString('base64'),
        });
    });

    it('imports into the Claude project path and returns direct external-session source metadata', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-claude-plugin-handoff-import-'));
        const targetPath = join(root, 'workspace');
        const configDir = join(root, '.claude-target');
        await mkdir(targetPath, { recursive: true });

        const result = await importClaudeSessionBundle({
            bundle: {
                providerId: 'claude',
                remoteSessionId: 'session-2',
                transcriptBase64: Buffer.from('{"type":"assistant","text":"imported"}\n', 'utf8').toString('base64'),
            },
            targetPath,
            env: { HAPPIER_CLAUDE_CONFIG_DIR: configDir },
        });

        const projectId = resolveClaudeProjectId(targetPath);
        expect(result.directSource).toEqual({
            kind: 'claudeConfig',
            configDir,
            projectId,
        });
        expect(result.resume).toEqual({
            directory: targetPath,
            agent: 'claude',
            resume: 'session-2',
            environmentVariables: { CLAUDE_CONFIG_DIR: configDir },
            transcriptStorage: 'direct',
            approvedNewDirectoryCreation: true,
        });

        await expect(readFile(join(configDir, 'projects', projectId, 'session-2.jsonl'), 'utf8')).resolves.toBe(
            '{"type":"assistant","text":"imported"}\n',
        );
    });

    it('rejects remote session ids with path separators', async () => {
        await expect(importClaudeSessionBundle({
            bundle: {
                providerId: 'claude',
                remoteSessionId: '../escape',
                transcriptBase64: Buffer.from('{}\n', 'utf8').toString('base64'),
            },
            targetPath: '/tmp/workspace',
            env: {},
        })).rejects.toThrow(/remoteSessionId|session id|path/i);
    });
});
