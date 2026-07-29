import { access, lstat, mkdir, mkdtemp, readFile, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { exportClaudeSessionBundle, importClaudeSessionBundle } from './bundle.js';
import { resolveClaudeProjectId } from './path.js';
import { claudeHandoffSurface } from './providerOps.js';

describe('Claude handoff bundle leaf', () => {
    afterEach(() => {
        vi.unstubAllEnvs();
    });

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
                    v: 1,
                    agentId: 'claude',
                    machineId: 'machine-1',
                    remoteSessionId: 'session-1',
                    source: { kind: 'claudeConfig', configDir, projectId: 'project-live' },
                },
            },
            remoteSessionId: 'session-1',
            env: {},
        });

        expect(bundle).toEqual({
            agentId: 'claude',
            remoteSessionId: 'session-1',
            transcriptBase64: Buffer.from('{"type":"assistant","text":"live"}\n', 'utf8').toString('base64'),
        });
    });

    it('reads the A13 legacy link and rejects malformed or cross-Agent linked sources', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-claude-plugin-handoff-compat-'));
        const workspace = join(root, 'workspace');
        const configDir = join(root, '.claude');
        const linkedProjectId = 'project-linked';
        const fallbackProjectId = resolveClaudeProjectId(workspace);
        await mkdir(join(configDir, 'projects', linkedProjectId), { recursive: true });
        await mkdir(join(configDir, 'projects', fallbackProjectId), { recursive: true });
        await writeFile(
            join(configDir, 'projects', linkedProjectId, 'session-legacy.jsonl'),
            '{"type":"assistant","text":"legacy-linked"}\n',
            'utf8',
        );
        await writeFile(
            join(configDir, 'projects', fallbackProjectId, 'session-malformed.jsonl'),
            '{"type":"assistant","text":"fallback-malformed"}\n',
            'utf8',
        );
        await writeFile(
            join(configDir, 'projects', fallbackProjectId, 'session-cross-agent.jsonl'),
            '{"type":"assistant","text":"fallback-cross-agent"}\n',
            'utf8',
        );

        const legacy = await exportClaudeSessionBundle({
            metadata: {
                path: workspace,
                directSessionV1: {
                    v: 1,
                    providerId: 'claude',
                    machineId: 'machine-1',
                    remoteSessionId: 'session-legacy',
                    source: { kind: 'claudeConfig', configDir, projectId: linkedProjectId },
                },
            },
            remoteSessionId: 'session-legacy',
            env: { HAPPIER_CLAUDE_CONFIG_DIR: configDir },
        });
        expect(Buffer.from(legacy.transcriptBase64, 'base64').toString('utf8')).toContain('legacy-linked');

        for (const [remoteSessionId, externalSessionV1] of [
            [
                'session-malformed',
                {
                    v: 1,
                    agentId: 'claude',
                    source: { kind: 'claudeConfig', configDir, projectId: linkedProjectId },
                },
            ],
            [
                'session-cross-agent',
                {
                    v: 1,
                    agentId: 'codex',
                    machineId: 'machine-1',
                    remoteSessionId: 'session-cross-agent',
                    source: { kind: 'claudeConfig', configDir, projectId: linkedProjectId },
                },
            ],
        ] as const) {
            const bundle = await exportClaudeSessionBundle({
                metadata: { path: workspace, externalSessionV1 },
                remoteSessionId,
                env: { HAPPIER_CLAUDE_CONFIG_DIR: configDir },
            });
            expect(Buffer.from(bundle.transcriptBase64, 'base64').toString('utf8')).toContain(
                remoteSessionId === 'session-malformed' ? 'fallback-malformed' : 'fallback-cross-agent',
            );
        }
    });

    it('falls back to the derived transcript when linked Claude source identity is nullish', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-claude-plugin-handoff-nullish-source-'));
        const workspace = join(root, 'workspace');
        const configDir = join(root, '.claude');
        const projectId = resolveClaudeProjectId(workspace);
        const transcriptPath = join(configDir, 'projects', projectId, 'session-nullish.jsonl');
        await mkdir(join(configDir, 'projects', projectId), { recursive: true });
        await writeFile(transcriptPath, '{"type":"assistant","text":"derived-nullish"}\n', 'utf8');

        const bundle = await exportClaudeSessionBundle({
            metadata: {
                path: workspace,
                externalSessionV1: {
                    v: 1,
                    agentId: 'claude',
                    machineId: 'machine-1',
                    remoteSessionId: 'session-nullish',
                    source: { kind: 'claudeConfig', configDir: null, projectId: null },
                },
            },
            remoteSessionId: 'session-nullish',
            env: { HAPPIER_CLAUDE_CONFIG_DIR: configDir },
        });

        expect(Buffer.from(bundle.transcriptBase64, 'base64').toString('utf8')).toContain('derived-nullish');
    });

    it('derives the transcript from the working directory instead of public transcript-path metadata', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-claude-plugin-handoff-derived-'));
        const workspace = join(root, 'workspace');
        const configDir = join(root, '.claude');
        const projectId = resolveClaudeProjectId(workspace);
        const derivedTranscriptPath = join(configDir, 'projects', projectId, 'session-derived.jsonl');
        const staleTranscriptPath = join(root, 'stale.jsonl');
        await mkdir(join(configDir, 'projects', projectId), { recursive: true });
        await writeFile(derivedTranscriptPath, '{"type":"assistant","text":"derived"}\n', 'utf8');
        await writeFile(staleTranscriptPath, '{"type":"assistant","text":"stale"}\n', 'utf8');

        const bundle = await exportClaudeSessionBundle({
            metadata: {
                path: workspace,
                claudeTranscriptPath: staleTranscriptPath,
            },
            remoteSessionId: 'session-derived',
            env: { HAPPIER_CLAUDE_CONFIG_DIR: configDir },
        });

        expect(Buffer.from(bundle.transcriptBase64, 'base64').toString('utf8')).toBe(
            '{"type":"assistant","text":"derived"}\n',
        );
    });

    it('imports into the Claude project path and returns direct external-session source metadata', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-claude-plugin-handoff-import-'));
        const targetPath = join(root, 'workspace');
        const configDir = join(root, '.claude-target');
        await mkdir(targetPath, { recursive: true });

        const result = await importClaudeSessionBundle({
            bundle: {
                agentId: 'claude',
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

    it('accepts an existing byte-identical native target without rewriting it', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-claude-plugin-handoff-identical-'));
        const targetPath = join(root, 'workspace');
        const configDir = join(root, '.claude-target');
        const projectId = resolveClaudeProjectId(targetPath);
        const transcriptPath = join(configDir, 'projects', projectId, 'session-identical.jsonl');
        const transcript = '{"type":"assistant","text":"identical"}\n';
        await mkdir(join(configDir, 'projects', projectId), { recursive: true });
        await writeFile(transcriptPath, transcript, 'utf8');
        const preservedTimestamp = new Date('2001-02-03T04:05:06.000Z');
        await utimes(transcriptPath, preservedTimestamp, preservedTimestamp);
        const before = await stat(transcriptPath);

        await expect(importClaudeSessionBundle({
            bundle: {
                agentId: 'claude',
                remoteSessionId: 'session-identical',
                transcriptBase64: Buffer.from(transcript, 'utf8').toString('base64'),
            },
            targetPath,
            env: { HAPPIER_CLAUDE_CONFIG_DIR: configDir },
        })).resolves.toMatchObject({
            remoteSessionId: 'session-identical',
        });

        const after = await stat(transcriptPath);
        expect(after.mtimeMs).toBe(before.mtimeMs);
        await expect(readFile(transcriptPath, 'utf8')).resolves.toBe(transcript);
    });

    it('returns a typed identity conflict and preserves a divergent native target', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-claude-plugin-handoff-conflict-'));
        const targetPath = join(root, 'workspace');
        const configDir = join(root, '.claude-target');
        const projectId = resolveClaudeProjectId(targetPath);
        const transcriptPath = join(configDir, 'projects', projectId, 'session-conflict.jsonl');
        const existingTranscript = '{"type":"assistant","text":"existing"}\n';
        await mkdir(join(configDir, 'projects', projectId), { recursive: true });
        await writeFile(transcriptPath, existingTranscript, 'utf8');
        vi.stubEnv('HAPPIER_CLAUDE_CONFIG_DIR', configDir);

        const result = await claudeHandoffSurface.importBundle({
            bundle: {
                agentId: 'claude',
                remoteSessionId: 'session-conflict',
                transcriptBase64: Buffer.from('{"type":"assistant","text":"incoming"}\n', 'utf8').toString('base64'),
            },
            targetDirectory: targetPath,
        });

        expect(result).toMatchObject({
            ok: false,
            code: 'target_identity_conflict',
            retryable: false,
        });
        await expect(readFile(transcriptPath, 'utf8')).resolves.toBe(existingTranscript);
    });

    it('fails typed without mutation when the native target identity cannot be read as a transcript', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-claude-plugin-handoff-unprovable-'));
        const targetPath = join(root, 'workspace');
        const configDir = join(root, '.claude-target');
        const projectId = resolveClaudeProjectId(targetPath);
        const transcriptPath = join(configDir, 'projects', projectId, 'session-unprovable.jsonl');
        const sentinelPath = join(transcriptPath, 'sentinel');
        await mkdir(transcriptPath, { recursive: true });
        await writeFile(sentinelPath, 'preserve', 'utf8');
        vi.stubEnv('HAPPIER_CLAUDE_CONFIG_DIR', configDir);

        const result = await claudeHandoffSurface.importBundle({
            bundle: {
                agentId: 'claude',
                remoteSessionId: 'session-unprovable',
                transcriptBase64: Buffer.from('{"type":"assistant","text":"incoming"}\n', 'utf8').toString('base64'),
            },
            targetDirectory: targetPath,
        });

        expect(result).toMatchObject({
            ok: false,
            code: 'target_identity_conflict',
            retryable: false,
        });
        await expect(readFile(sentinelPath, 'utf8')).resolves.toBe('preserve');
    });

    it('rejects a symlinked Claude project directory before writing outside the config tree', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-claude-plugin-handoff-parent-symlink-'));
        const targetPath = join(root, 'workspace');
        const configDir = join(root, '.claude-target');
        const projectId = resolveClaudeProjectId(targetPath);
        const projectsDir = join(configDir, 'projects');
        const projectDir = join(projectsDir, projectId);
        const outsideDir = join(root, 'outside');
        const outsideTranscriptPath = join(outsideDir, 'session-parent-symlink.jsonl');
        await mkdir(projectsDir, { recursive: true });
        await mkdir(outsideDir, { recursive: true });
        await symlink(outsideDir, projectDir, 'dir');

        await expect(importClaudeSessionBundle({
            bundle: {
                agentId: 'claude',
                remoteSessionId: 'session-parent-symlink',
                transcriptBase64: Buffer.from('{"type":"assistant","text":"incoming"}\n', 'utf8').toString('base64'),
            },
            targetPath,
            env: { HAPPIER_CLAUDE_CONFIG_DIR: configDir },
        })).rejects.toMatchObject({
            name: 'PluginError',
            code: 'target_identity_conflict',
            retryable: false,
        });

        await expect(access(outsideTranscriptPath)).rejects.toMatchObject({ code: 'ENOENT' });
        expect((await lstat(projectDir)).isSymbolicLink()).toBe(true);
    });

    it('rejects an equal-byte transcript symlink as unproven native identity', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-claude-plugin-handoff-target-symlink-'));
        const targetPath = join(root, 'workspace');
        const configDir = join(root, '.claude-target');
        const projectId = resolveClaudeProjectId(targetPath);
        const projectDir = join(configDir, 'projects', projectId);
        const transcriptPath = join(projectDir, 'session-target-symlink.jsonl');
        const outsideTranscriptPath = join(root, 'outside-session.jsonl');
        const transcript = '{"type":"assistant","text":"identical"}\n';
        await mkdir(projectDir, { recursive: true });
        await writeFile(outsideTranscriptPath, transcript, 'utf8');
        await symlink(outsideTranscriptPath, transcriptPath, 'file');

        await expect(importClaudeSessionBundle({
            bundle: {
                agentId: 'claude',
                remoteSessionId: 'session-target-symlink',
                transcriptBase64: Buffer.from(transcript, 'utf8').toString('base64'),
            },
            targetPath,
            env: { HAPPIER_CLAUDE_CONFIG_DIR: configDir },
        })).rejects.toMatchObject({
            name: 'PluginError',
            code: 'target_identity_conflict',
            retryable: false,
        });

        expect((await lstat(transcriptPath)).isSymbolicLink()).toBe(true);
        await expect(readFile(outsideTranscriptPath, 'utf8')).resolves.toBe(transcript);
    });

    it('uses exclusive creation so racing divergent imports cannot overwrite each other', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-claude-plugin-handoff-race-'));
        const targetPath = join(root, 'workspace');
        const configDir = join(root, '.claude-target');
        const remoteSessionId = 'session-race';
        const transcripts = [
            '{"type":"assistant","text":"first"}\n',
            '{"type":"assistant","text":"second"}\n',
        ] as const;

        const results = await Promise.allSettled(transcripts.map((transcript) => importClaudeSessionBundle({
            bundle: {
                agentId: 'claude',
                remoteSessionId,
                transcriptBase64: Buffer.from(transcript, 'utf8').toString('base64'),
            },
            targetPath,
            env: { HAPPIER_CLAUDE_CONFIG_DIR: configDir },
        })));

        expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
        const rejected = results.find((result) => result.status === 'rejected');
        expect(rejected).toMatchObject({
            status: 'rejected',
            reason: {
                name: 'PluginError',
                code: 'target_identity_conflict',
                retryable: false,
            },
        });
        const projectId = resolveClaudeProjectId(targetPath);
        const persisted = await readFile(
            join(configDir, 'projects', projectId, `${remoteSessionId}.jsonl`),
            'utf8',
        );
        expect(transcripts).toContain(persisted);
    });

    it('converges racing identical imports through exclusive creation and regular-file revalidation', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-claude-plugin-handoff-identical-race-'));
        const targetPath = join(root, 'workspace');
        const configDir = join(root, '.claude-target');
        const remoteSessionId = 'session-identical-race';
        const transcript = '{"type":"assistant","text":"same"}\n';
        const params = {
            bundle: {
                agentId: 'claude' as const,
                remoteSessionId,
                transcriptBase64: Buffer.from(transcript, 'utf8').toString('base64'),
            },
            targetPath,
            env: { HAPPIER_CLAUDE_CONFIG_DIR: configDir },
        };

        const results = await Promise.allSettled([
            importClaudeSessionBundle(params),
            importClaudeSessionBundle(params),
        ]);

        expect(results.map((result) => result.status)).toEqual(['fulfilled', 'fulfilled']);
        const projectId = resolveClaudeProjectId(targetPath);
        await expect(readFile(
            join(configDir, 'projects', projectId, `${remoteSessionId}.jsonl`),
            'utf8',
        )).resolves.toBe(transcript);
    });

    it('rejects remote session ids with path separators', async () => {
        await expect(exportClaudeSessionBundle({
            metadata: { path: '/tmp/workspace' },
            remoteSessionId: '../escape',
            env: {},
        })).rejects.toThrow(/Invalid remoteSessionId/);

        await expect(importClaudeSessionBundle({
            bundle: {
                agentId: 'claude',
                remoteSessionId: '../escape',
                transcriptBase64: Buffer.from('{}\n', 'utf8').toString('base64'),
            },
            targetPath: '/tmp/workspace',
            env: {},
        })).rejects.toThrow(/remoteSessionId|session id|path/i);
    });

    it('rejects malformed bundles before creating target directories', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-claude-plugin-handoff-invalid-'));
        const targetPath = join(root, 'workspace');
        const configDir = join(root, '.claude-target');
        await mkdir(targetPath, { recursive: true });

        await expect(importClaudeSessionBundle({
            bundle: {
                agentId: 'claude',
                remoteSessionId: 'session-missing-transcript',
            },
            targetPath,
            env: { HAPPIER_CLAUDE_CONFIG_DIR: configDir },
        })).rejects.toThrow(/bundle|transcript/i);

        await expect(access(join(configDir, 'projects'))).rejects.toThrow();
    });
});
