import { existsSync, readdirSync } from 'node:fs';
import { access, lstat, mkdir, mkdtemp, readFile, realpath, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentRuntimeHandoffSurface } from '@happier-dev/plugin-sdk/agents/runtime';

import { exportClaudeSessionBundle, importClaudeSessionBundle } from './bundle.js';
import { getClaudeProjectPath, resolveClaudeProjectId } from './path.js';
import { claudeHandoffSurface } from './providerOps.js';
import { validateClaudeExternalSessionSource } from '../external/source.js';

function handoffContext(): import('@happier-dev/plugin-sdk').PluginInvocationContext {
    return { signal: new AbortController().signal } as import('@happier-dev/plugin-sdk').PluginInvocationContext;
}

describe('Claude handoff bundle leaf', () => {
    afterEach(() => {
        vi.unstubAllEnvs();
    });

    it('derives project paths from the Happier config root when it is the only override', () => {
        vi.stubEnv('CLAUDE_CONFIG_DIR', '');
        vi.stubEnv('HAPPIER_CLAUDE_CONFIG_DIR', '/tmp/claude-happier-only');

        expect(getClaudeProjectPath('/tmp/workspace')).toBe(join(
            '/tmp/claude-happier-only',
            'projects',
            resolveClaudeProjectId('/tmp/workspace'),
        ));
    });

    it('projects a direct Claude source from bounded identity and its canonical descriptor only', async () => {
        const result = await claudeHandoffSurface.buildRuntimeLocalMetadata?.({
            identity: {
                machineId: 'machine-1',
                workingDirectory: '/repo/project',
                transcriptStorage: 'direct',
                vendorResumeId: 'claude-session-1',
            },
            runtimeDescriptorV1: {
                v: 1,
                agentId: 'claude',
                agent: {
                    configDir: '/tmp/native-claude',
                },
            },
        }, handoffContext());

        expect(result).toEqual({
            externalSessionSource: {
                kind: 'claudeConfig',
                configDir: '/tmp/native-claude',
                projectId: '-repo-project',
            },
        });
    });

    it.each([
        {
            name: 'persisted transcript storage',
            identity: {
                machineId: 'machine-1',
                workingDirectory: '/repo/project',
                transcriptStorage: 'persisted' as const,
                vendorResumeId: 'claude-session-1',
            },
            runtimeDescriptorV1: {
                v: 1 as const,
                agentId: 'claude',
                agent: { configDir: '/tmp/native-claude' },
            },
        },
        {
            name: 'a descriptor for another Agent',
            identity: {
                machineId: 'machine-1',
                workingDirectory: '/repo/project',
                transcriptStorage: 'direct' as const,
                vendorResumeId: 'claude-session-1',
            },
            runtimeDescriptorV1: {
                v: 1 as const,
                agentId: 'codex',
                agent: { configDir: '/tmp/native-claude' },
            },
        },
    ])('does not project a source for $name', async ({ identity, runtimeDescriptorV1 }) => {
        await expect(claudeHandoffSurface.buildRuntimeLocalMetadata?.({
            identity,
            runtimeDescriptorV1,
        }, handoffContext())).resolves.toBeNull();
    });

    it('exports the exact host-admitted Session id instead of a stale generic metadata id', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-claude-handoff-provider-export-id-'));
        const workspace = join(root, 'workspace');
        const configDir = join(root, '.claude');
        const projectId = resolveClaudeProjectId(workspace);
        const transcriptPath = join(configDir, 'projects', projectId, 'current-session.jsonl');
        await mkdir(join(configDir, 'projects', projectId), { recursive: true });
        await writeFile(transcriptPath, '{"type":"assistant","text":"current"}\n', 'utf8');
        vi.stubEnv('HAPPIER_CLAUDE_CONFIG_DIR', configDir);

        const result = await claudeHandoffSurface.exportBundle({
            sessionId: 'current-session',
            metadata: {
                path: workspace,
                providerSessionId: 'stale-other-agent-session',
            },
            directory: '/active-server',
        }, handoffContext());

        expect(result).toMatchObject({
            ok: true,
            value: {
                bundle: {
                    agentId: 'claude',
                    remoteSessionId: 'current-session',
                },
            },
        });
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
                externalSessionSource: { kind: 'claudeConfig', configDir, projectId: 'project-live' },
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

    it.each(['linked source', 'derived path'] as const)(
        'rejects a transcript-name symlink outside the Claude projects root for the %s export',
        async (sourceKind) => {
            const root = await mkdtemp(join(tmpdir(), 'happier-claude-plugin-handoff-export-symlink-'));
            const workspace = join(root, 'workspace');
            const configDir = join(root, '.claude');
            const projectId = sourceKind === 'linked source'
                ? 'project-linked'
                : resolveClaudeProjectId(workspace);
            const remoteSessionId = 'session-symlink';
            const transcriptPath = join(configDir, 'projects', projectId, `${remoteSessionId}.jsonl`);
            const sentinelPath = join(root, 'outside-sentinel.jsonl');
            const sentinel = '{"type":"assistant","text":"outside-sentinel"}\n';
            await mkdir(join(configDir, 'projects', projectId), { recursive: true });
            await writeFile(sentinelPath, sentinel, 'utf8');
            await symlink(sentinelPath, transcriptPath, 'file');

            await expect(exportClaudeSessionBundle({
                metadata: {
                    path: workspace,
                    ...(sourceKind === 'linked source'
                        ? {
                            externalSessionSource: {
                                kind: 'claudeConfig' as const,
                                configDir,
                                projectId,
                            },
                        }
                        : {}),
                },
                remoteSessionId,
                env: { HAPPIER_CLAUDE_CONFIG_DIR: configDir },
            })).rejects.toThrow();
        },
    );

    it('does not read raw owner metadata when selecting a transcript source', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-claude-plugin-handoff-compat-'));
        const workspace = join(root, 'workspace');
        const configDir = join(root, '.claude');
        const linkedProjectId = 'project-linked';
        const fallbackProjectId = resolveClaudeProjectId(workspace);
        await mkdir(join(configDir, 'projects', linkedProjectId), { recursive: true });
        await mkdir(join(configDir, 'projects', fallbackProjectId), { recursive: true });
        await writeFile(
            join(configDir, 'projects', linkedProjectId, 'session-owner-private.jsonl'),
            '{"type":"assistant","text":"owner-private"}\n',
            'utf8',
        );
        await writeFile(
            join(configDir, 'projects', fallbackProjectId, 'session-owner-private.jsonl'),
            '{"type":"assistant","text":"fallback-public"}\n',
            'utf8',
        );

        const rawOwnerMetadata = {
            path: workspace,
            externalSessionV1: {
                v: 1,
                agentId: 'claude',
                machineId: 'machine-1',
                remoteSessionId: 'session-owner-private',
                source: { kind: 'claudeConfig', configDir, projectId: linkedProjectId },
            },
        };
        const bundle = await exportClaudeSessionBundle({
            metadata: rawOwnerMetadata,
            remoteSessionId: 'session-owner-private',
            env: { HAPPIER_CLAUDE_CONFIG_DIR: configDir },
        });
        expect(Buffer.from(bundle.transcriptBase64, 'base64').toString('utf8')).toContain('fallback-public');
    });

    it('falls back to the derived transcript when the public source is absent', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-claude-plugin-handoff-nullish-source-'));
        const workspace = join(root, 'workspace');
        const configDir = join(root, '.claude');
        const projectId = resolveClaudeProjectId(workspace);
        const transcriptPath = join(configDir, 'projects', projectId, 'session-nullish.jsonl');
        await mkdir(join(configDir, 'projects', projectId), { recursive: true });
        await writeFile(transcriptPath, '{"type":"assistant","text":"derived-nullish"}\n', 'utf8');

        const bundle = await exportClaudeSessionBundle({
            metadata: { path: workspace },
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
        expect(result).toMatchObject({
            providerSessionId: 'session-2',
            launch: {
            directory: targetPath,
                environmentVariables: { CLAUDE_CONFIG_DIR: configDir },
            },
        });
        expect(result).not.toHaveProperty('resume');

        await expect(readFile(join(configDir, 'projects', projectId, 'session-2.jsonl'), 'utf8')).resolves.toBe(
            '{"type":"assistant","text":"imported"}\n',
        );
    });

    it('persists a direct source that the external-session reader accepts when both config vars differ', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-claude-plugin-handoff-config-precedence-'));
        const targetPath = join(root, 'workspace');
        const claudeConfigDir = join(root, '.claude-explicit');
        const happierConfigDir = join(root, '.claude-happier');
        const env = {
            CLAUDE_CONFIG_DIR: claudeConfigDir,
            HAPPIER_CLAUDE_CONFIG_DIR: happierConfigDir,
        };
        await mkdir(targetPath, { recursive: true });

        const imported = await importClaudeSessionBundle({
            bundle: {
                agentId: 'claude',
                remoteSessionId: 'session-config-precedence',
                transcriptBase64: Buffer.from('{"type":"assistant","text":"imported"}\n', 'utf8').toString('base64'),
            },
            targetPath,
            env,
        });

        expect(imported.directSource.configDir).toBe(claudeConfigDir);
        const validation = validateClaudeExternalSessionSource({
            source: imported.directSource,
            env,
        });
        expect(validation.ok).toBe(true);
        if (!validation.ok) throw new Error(validation.error);
        await expect(realpath(validation.source.configDir!)).resolves.toBe(
            await realpath(claudeConfigDir),
        );
    });

    it('projects the public launch hints through the canonical handoff adapter', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-claude-plugin-handoff-adapter-'));
        const targetPath = join(root, 'workspace');
        const configDir = join(root, '.claude-target');
        await mkdir(targetPath, { recursive: true });
        vi.stubEnv('HAPPIER_CLAUDE_CONFIG_DIR', configDir);

        const result = await claudeHandoffSurface.importBundle({
            bundle: {
                agentId: 'claude',
                remoteSessionId: 'session-adapter',
                transcriptBase64: Buffer.from('{"type":"assistant","text":"imported"}\n', 'utf8').toString('base64'),
            },
            targetDirectory: targetPath,
        }, handoffContext());

        expect(result).toEqual({
            ok: true,
            value: {
                providerSessionId: 'session-adapter',
                source: {
                    kind: 'claudeConfig',
                    configDir,
                    projectId: resolveClaudeProjectId(targetPath),
                },
                launch: {
                    directory: targetPath,
                    environmentVariables: { CLAUDE_CONFIG_DIR: configDir },
                    sessionStateUpdates: [{
                        fieldId: 'identity.providerSessionId',
                        value: 'session-adapter',
                    }],
                },
            },
        });
    });

    it('does not write the native transcript after its runtime generation retires mid-import', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-claude-plugin-handoff-retired-'));
        const targetPath = join(root, 'workspace');
        const configDir = join(root, '.claude-target');
        const projectId = resolveClaudeProjectId(targetPath);
        const projectDir = join(configDir, 'projects', projectId);
        const transcriptPath = join(configDir, 'projects', projectId, 'session-retired.jsonl');
        vi.stubEnv('HAPPIER_CLAUDE_CONFIG_DIR', configDir);
        const retirementReason = new Error('runtime generation retired');
        let observedTemporaryFile = false;
        const signal = {
            get aborted() {
                if (existsSync(projectDir)) {
                    observedTemporaryFile ||= readdirSync(projectDir).some((entry) => (
                        entry.startsWith('.happier-import-')
                    ));
                }
                return observedTemporaryFile;
            },
            reason: retirementReason,
            throwIfAborted() {
                if (this.aborted) throw this.reason;
            },
        } as AbortSignal;

        const handoffSurface: AgentRuntimeHandoffSurface = claudeHandoffSurface;
        const result = await handoffSurface.importBundle({
            bundle: {
                agentId: 'claude',
                remoteSessionId: 'session-retired',
                transcriptBase64: Buffer.from('{"type":"assistant","text":"imported"}\n', 'utf8').toString('base64'),
            },
            targetDirectory: targetPath,
        }, { signal } as import('@happier-dev/plugin-sdk').PluginInvocationContext);

        expect(observedTemporaryFile).toBe(true);
        expect(result).toMatchObject({
            ok: false,
            code: 'target_import_failed',
            message: 'runtime generation retired',
        });
        await expect(access(transcriptPath)).rejects.toMatchObject({ code: 'ENOENT' });
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
            providerSessionId: 'session-identical',
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
        }, handoffContext());

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
        }, handoffContext());

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
        const transcript = JSON.stringify({
            type: 'assistant',
            text: `same-${'x'.repeat(8 * 1024 * 1024)}`,
        }) + '\n';
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
    it('refuses to export a same-id transcript from the environment config root when the linked project holds none', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-claude-handoff-export-exclusive-project-'));
        const workspace = join(root, 'workspace');
        const linkedConfigDir = join(root, 'linked-claude');
        const environmentConfigDir = join(root, 'environment-claude');
        const environmentProjectId = resolveClaudeProjectId(workspace);

        // The linked project exists but holds no transcript for this id, while the
        // caller environment root holds a different session that shares it.
        await mkdir(join(linkedConfigDir, 'projects', 'project-linked'), { recursive: true });
        await mkdir(join(environmentConfigDir, 'projects', environmentProjectId), { recursive: true });
        await writeFile(
            join(environmentConfigDir, 'projects', environmentProjectId, 'session-shared-id.jsonl'),
            '{"type":"assistant","text":"other-root-bytes"}\n',
            'utf8',
        );

        await expect(exportClaudeSessionBundle({
            metadata: {
                path: workspace,
                externalSessionSource: {
                    kind: 'claudeConfig',
                    configDir: linkedConfigDir,
                    projectId: 'project-linked',
                },
            },
            remoteSessionId: 'session-shared-id',
            env: { HAPPIER_CLAUDE_CONFIG_DIR: environmentConfigDir },
        })).rejects.toThrow(/session-shared-id/);
    });

    it('treats a linked source that names only a config root as exclusive custody', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-claude-handoff-export-exclusive-configdir-'));
        const workspace = join(root, 'workspace');
        const linkedConfigDir = join(root, 'linked-claude');
        const environmentConfigDir = join(root, 'environment-claude');
        const environmentProjectId = resolveClaudeProjectId(workspace);

        await mkdir(join(linkedConfigDir, 'projects', 'project-linked'), { recursive: true });
        await mkdir(join(environmentConfigDir, 'projects', environmentProjectId), { recursive: true });
        await writeFile(
            join(environmentConfigDir, 'projects', environmentProjectId, 'session-config-only.jsonl'),
            '{"type":"assistant","text":"other-root-bytes"}\n',
            'utf8',
        );

        await expect(exportClaudeSessionBundle({
            metadata: {
                path: workspace,
                externalSessionSource: { kind: 'claudeConfig', configDir: linkedConfigDir },
            },
            remoteSessionId: 'session-config-only',
            env: { HAPPIER_CLAUDE_CONFIG_DIR: environmentConfigDir },
        })).rejects.toThrow(/session-config-only/);
    });

    it('exports from a linked source that names only a config root when that root holds the transcript', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-claude-handoff-export-configdir-positive-'));
        const workspace = join(root, 'workspace');
        const linkedConfigDir = join(root, 'linked-claude');
        const environmentConfigDir = join(root, 'environment-claude');
        const transcript = '{"type":"assistant","text":"linked-root-bytes"}\n';
        await mkdir(join(linkedConfigDir, 'projects', 'project-linked'), { recursive: true });
        await mkdir(join(environmentConfigDir, 'projects', resolveClaudeProjectId(workspace)), { recursive: true });
        await writeFile(
            join(linkedConfigDir, 'projects', 'project-linked', 'session-config-only-ok.jsonl'),
            transcript,
            'utf8',
        );
        await writeFile(
            join(environmentConfigDir, 'projects', resolveClaudeProjectId(workspace), 'session-config-only-ok.jsonl'),
            '{"type":"assistant","text":"other-root-bytes"}\n',
            'utf8',
        );

        await expect(exportClaudeSessionBundle({
            metadata: {
                path: workspace,
                externalSessionSource: { kind: 'claudeConfig', configDir: linkedConfigDir },
            },
            remoteSessionId: 'session-config-only-ok',
            env: { HAPPIER_CLAUDE_CONFIG_DIR: environmentConfigDir },
        })).resolves.toEqual({
            agentId: 'claude',
            remoteSessionId: 'session-config-only-ok',
            transcriptBase64: Buffer.from(transcript, 'utf8').toString('base64'),
        });
    });
});
