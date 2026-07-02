import { appendFile, mkdir, mkdtemp, readdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ExternalSessionFileFollowInputV1, ExternalSessionSurfaceV1 } from '@happier-dev/agents';

type ClaudeExternalSessionSurfaceFactory = (params?: Readonly<{
    env?: NodeJS.ProcessEnv;
}>) => ExternalSessionSurfaceV1;

function readClaudeExternalSessionSurfaceFactory(module: Record<string, unknown>): ClaudeExternalSessionSurfaceFactory | null {
    const factory = module.createClaudeExternalSessionSurface;
    return typeof factory === 'function' ? factory as ClaudeExternalSessionSurfaceFactory : null;
}

describe('Claude external-session provider operation policy', () => {
    const forbiddenLegacyVocabulary = [
        ['direct', 'Sessions'].join(''),
        ['connected', 'Services'].join(''),
    ];

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('exports takeover spawn planning from the plugin-owned external-session leaf', async () => {
        const externalSessionLeaf = await import('./index.js');
        const exported = Reflect.get(externalSessionLeaf, 'resolveClaudeExternalSessionTakeoverSpawnPlan');

        expect(exported).toBeTypeOf('function');
        if (typeof exported !== 'function') return;

        expect(exported({
            sessionId: 'happy-session-1',
            remoteSessionId: 'claude-session-1',
            directory: ' /repo/project ',
            configDir: ' /home/user/.claude ',
        })).toEqual({
            directory: '/repo/project',
            backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
            existingSessionId: 'happy-session-1',
            resume: 'claude-session-1',
            approvedNewDirectoryCreation: true,
            transcriptStorage: 'direct',
            environmentVariables: {
                CLAUDE_CONFIG_DIR: '/home/user/.claude',
            },
        });

        expect(exported({
            sessionId: 'happy-session-1',
            remoteSessionId: 'claude-session-1',
            directory: null,
            configDir: '/home/user/.claude',
        })).toBeNull();
    });

    it('lists and pages Claude JSONL sessions through the plugin-owned external-session surface', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-claude-plugin-external-'));
        const workspace = join(root, 'workspace');
        const configDir = join(root, '.claude');
        const canonicalConfigDir = await realpath(root).then((canonicalRoot) => join(canonicalRoot, '.claude'));
        const projectId = 'project-a';
        const remoteSessionId = 'claude-session-1';
        const transcriptDir = join(configDir, 'projects', projectId);
        await mkdir(workspace, { recursive: true });
        await mkdir(transcriptDir, { recursive: true });
        await writeFile(
            join(transcriptDir, `${remoteSessionId}.jsonl`),
            [
                JSON.stringify({
                    type: 'user',
                    uuid: 'user-1',
                    timestamp: '2026-06-08T00:00:00.000Z',
                    cwd: workspace,
                    message: { content: 'hello from Claude JSONL' },
                }),
                JSON.stringify({
                    type: 'assistant',
                    uuid: 'assistant-1',
                    timestamp: '2026-06-08T00:00:01.000Z',
                    message: {
                        content: [{ type: 'text', text: 'assistant response' }],
                    },
                }),
            ].join('\n') + '\n',
            'utf8',
        );

        const externalSessionLeaf = await import('./index.js');
        const createSurface = readClaudeExternalSessionSurfaceFactory(externalSessionLeaf);
        expect(createSurface).toEqual(expect.any(Function));
        if (!createSurface) return;

        const surface = createSurface({ env: { HAPPIER_CLAUDE_CONFIG_DIR: configDir } });
        const source = { kind: 'claudeConfig' as const, configDir, projectId };
        const listed = await surface.listCandidates({
            source,
            limit: 5,
        });
        expect(listed).toMatchObject({
            ok: true,
            value: {
                candidates: [
                    expect.objectContaining({
                        remoteSessionId,
                        title: 'hello from Claude JSONL',
                        details: { projectId },
                    }),
                ],
                nextCursor: null,
            },
        });

        const page = await surface.pageTranscript({
            source,
            providerSessionId: remoteSessionId,
            direction: 'older',
            maxBytes: 1024 * 1024,
            maxItems: 10,
        });
        expect(page).toMatchObject({
            ok: true,
            value: {
                items: expect.arrayContaining([
                    expect.objectContaining({
                        raw: {
                            role: 'user',
                            content: { type: 'text', text: 'hello from Claude JSONL' },
                        },
                    }),
                ]),
                hasMore: false,
            },
        });
        expect(page.ok && page.value.tailCursor).toEqual(expect.any(String));

        const tail = await surface.readAfterTranscript?.({
            source,
            providerSessionId: remoteSessionId,
            cursor: 'tail',
            maxBytes: 1024 * 1024,
            maxItems: 10,
        });
        expect(tail).toMatchObject({
            ok: true,
            value: {
                items: [],
                nextCursor: expect.any(String),
                truncated: false,
            },
        });

        const takeover = await surface.resolveTakeoverLaunch?.({
            linkedSessionId: 'happy-session-1',
            providerSessionId: remoteSessionId,
            source,
            metadata: {},
        });
        expect(takeover).toMatchObject({
            ok: true,
            value: {
                providerSessionId: remoteSessionId,
                source: { ...source, configDir: canonicalConfigDir },
                launch: {
                    directory: workspace,
                    environmentVariables: { CLAUDE_CONFIG_DIR: canonicalConfigDir },
                },
            },
        });
    });

    it('canonicalizes persisted linked Claude sources to the configured config dir', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-claude-plugin-linked-source-'));
        const configuredConfigDir = join(root, '.claude-current');
        const rogueConfigDir = join(root, '.claude-rogue');
        await mkdir(configuredConfigDir, { recursive: true });
        await mkdir(rogueConfigDir, { recursive: true });
        const canonicalConfigDir = await realpath(configuredConfigDir);

        const externalSessionLeaf = await import('./index.js');
        const createSurface = readClaudeExternalSessionSurfaceFactory(externalSessionLeaf);
        expect(createSurface).toEqual(expect.any(Function));
        if (!createSurface) return;

        const surface = createSurface({ env: { HAPPIER_CLAUDE_CONFIG_DIR: configuredConfigDir } });
        const resolved = await surface.resolveLinkedIdentity?.({
            metadata: {},
            providerSessionId: 'claude-session-rogue',
            source: { kind: 'claudeConfig', configDir: rogueConfigDir, projectId: 'proj-rogue' },
        });

        expect(resolved).toMatchObject({
            ok: true,
            value: {
                providerSessionId: 'claude-session-rogue',
                source: {
                    kind: 'claudeConfig',
                    configDir: canonicalConfigDir,
                    projectId: 'proj-rogue',
                },
            },
        });
    });

    it('follows Claude JSONL external sessions through runtime file-follow without local timer polling', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-claude-plugin-file-follow-'));
        const configDir = join(root, '.claude');
        const projectId = 'project-file-follow';
        const remoteSessionId = 'claude-session-file-follow';
        const transcriptDir = join(configDir, 'projects', projectId);
        await mkdir(transcriptDir, { recursive: true });
        const transcriptPath = join(transcriptDir, `${remoteSessionId}.jsonl`);
        await writeFile(transcriptPath, [
            JSON.stringify({
                type: 'user',
                uuid: 'user-initial',
                timestamp: '2026-06-08T00:00:00.000Z',
                cwd: root,
                message: { content: 'initial prompt' },
            }),
        ].join('\n') + '\n', 'utf8');
        const realTranscriptPath = await realpath(transcriptPath);

        const externalSessionLeaf = await import('./index.js');
        const createSurface = readClaudeExternalSessionSurfaceFactory(externalSessionLeaf);
        expect(createSurface).toEqual(expect.any(Function));
        if (!createSurface) return;

        let followInput: ExternalSessionFileFollowInputV1 | null = null;
        const close = vi.fn(async () => undefined);
        const fileFollow = {
            follow: vi.fn(async (input) => {
                followInput = input;
                return {
                    id: 'follow-1',
                    drainNow: vi.fn(async () => undefined),
                    close,
                };
            }),
        };
        const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
        const surface = createSurface({ env: { HAPPIER_CLAUDE_CONFIG_DIR: configDir } });
        const source = { kind: 'claudeConfig' as const, configDir, projectId };

        const leaseResult = await surface.acquireFollowLease?.({
            source,
            providerSessionId: remoteSessionId,
            reason: 'attached_view',
            runtime: {
                signal: new AbortController().signal,
                transcripts: { fileFollow },
                diagnostics: { issue: vi.fn() },
            },
        });

        expect(leaseResult).toMatchObject({ ok: true });
        expect(fileFollow.follow).toHaveBeenCalledWith(expect.objectContaining({
            path: realTranscriptPath,
            startAt: 'end',
            strategy: 'poll',
            onLine: expect.any(Function),
        }));
        if (!leaseResult?.ok || !followInput) return;

        const events: unknown[] = [];
        leaseResult.value.subscribeToTranscriptUpdates?.((event) => {
            events.push(event);
        });
        expect(setIntervalSpy).not.toHaveBeenCalled();

        const liveRow = {
            type: 'assistant',
            uuid: 'assistant-live',
            timestamp: '2026-06-08T00:00:01.000Z',
            message: {
                content: [{ type: 'text', text: 'live response' }],
            },
        };
        await appendFile(transcriptPath, `${JSON.stringify(liveRow)}\n`, 'utf8');
        await followInput.onLine({
            line: JSON.stringify(liveRow),
            sourcePath: realTranscriptPath,
            sequence: 1,
        });

        expect(JSON.stringify(events)).toContain('live response');
        await leaseResult.value.release();
        expect(close).toHaveBeenCalledWith({ finalDrain: true });
    });

    it('keeps the plugin external-session leaf free of legacy feature vocabulary', async () => {
        const externalSessionLeafDir = dirname(fileURLToPath(import.meta.url));
        const entries = await readdir(externalSessionLeafDir, { withFileTypes: true });
        const sourceTexts = await Promise.all(
            entries
                .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
                .map(async (entry) => ({
                    name: entry.name,
                    text: await readFile(join(externalSessionLeafDir, entry.name), 'utf8'),
                })),
        );

        for (const source of sourceTexts) {
            for (const forbidden of forbiddenLegacyVocabulary) {
                expect(source.text, source.name).not.toContain(forbidden);
            }
        }
    });
});
