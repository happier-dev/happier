import { appendFile, chmod, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import type { AgentExternalSessionsContribution } from '@happier-dev/plugin-sdk/sessions/external';

import * as providerOps from './contribution.js';
import { classifyClaudeNativeTranscriptRow } from '../../../transcripts/nativeSemanticProjection.js';
import { projectClaudeTranscriptRowToProviderPayload } from '../../../runtime/terminal/unified/providerTranscript.js';

const roots: string[] = [];

function createClaudeExternalSessionsContribution(
    params?: Readonly<{ env?: NodeJS.ProcessEnv }>,
): AgentExternalSessionsContribution {
    const factory = Reflect.get(providerOps, 'createClaudeExternalSessionsContribution');
    expect(factory).toEqual(expect.any(Function));
    if (typeof factory !== 'function') {
        throw new Error('Expected the Claude External Sessions contribution factory to be exported.');
    }
    return factory(params) as AgentExternalSessionsContribution;
}

function invocation(maxSerializedBytes = 1024 * 1024) {
    return {
        signal: new AbortController().signal,
        deadlineAtMs: Date.now() + 30_000,
        maxSerializedBytes,
    };
}

async function createTranscript(params: Readonly<{
    configDir: string;
    projectId: string;
    remoteSessionId: string;
    title: string;
}>): Promise<string> {
    const transcriptDir = join(params.configDir, 'projects', params.projectId);
    await mkdir(transcriptDir, { recursive: true });
    const transcriptPath = join(transcriptDir, `${params.remoteSessionId}.jsonl`);
    await writeFile(transcriptPath, [
        JSON.stringify({
            type: 'user',
            uuid: `${params.projectId}-user`,
            timestamp: '2026-06-08T00:00:00.000Z',
            cwd: `/work/${params.projectId}`,
            message: { content: params.title },
        }),
        JSON.stringify({
            type: 'assistant',
            uuid: `${params.projectId}-assistant`,
            timestamp: '2026-06-08T00:00:01.000Z',
            message: { content: [{ type: 'text', text: `answer from ${params.projectId}` }] },
        }),
    ].join('\n') + '\n', 'utf8');
    return transcriptPath;
}

describe('Claude native External Sessions contribution', () => {
    afterEach(async () => {
        await Promise.all(roots.splice(0).map(async (root) => {
            await rm(root, { recursive: true, force: true });
        }));
    });

    it('projects resolved sources onto the bounded Agent contribution DTO', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-claude-source-projection-'));
        roots.push(root);
        const configDir = join(root, '.claude');
        const contribution = createClaudeExternalSessionsContribution({
            env: { HAPPIER_CLAUDE_CONFIG_DIR: configDir },
        });

        expect(await contribution.resolveSource({
            ...invocation(),
            source: {
                kind: 'claudeConfig',
                configDir,
                projectId: 'project-a',
                resolvedRoot: '/private/host-owned-root',
            },
        })).toEqual({
            ok: true,
            value: {
                source: {
                    kind: 'claudeConfig',
                    configDir: expect.any(String),
                    projectId: 'project-a',
                },
            },
        });
    });

    it('discovers, project-qualifies, links, and bounded-reads a Claude JSONL session', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-claude-native-external-'));
        roots.push(root);
        const configDir = join(root, '.claude');
        const remoteSessionId = 'shared-session';
        await createTranscript({
            configDir,
            projectId: 'project-a',
            remoteSessionId,
            title: 'project A prompt',
        });
        const projectBTranscript = await createTranscript({
            configDir,
            projectId: 'project-b',
            remoteSessionId,
            title: 'find this project B title',
        });

        const contribution = createClaudeExternalSessionsContribution({
            env: { HAPPIER_CLAUDE_CONFIG_DIR: configDir },
        });
        expect(Object.keys(contribution).sort()).toEqual([
            'listCandidates',
            'pageTranscript',
            'readAfterTranscript',
            'resolveLinkIdentity',
            'resolveLinkedIdentity',
            'resolveSource',
        ]);

        const source = { kind: 'claudeConfig' as const, configDir };
        const listed = await contribution.listCandidates({
            ...invocation(),
            source,
            maxItems: 10,
            searchTerm: remoteSessionId,
            searchMode: 'fast',
        });
        expect(listed).toMatchObject({
            ok: true,
            value: {
                candidates: expect.arrayContaining([
                    expect.objectContaining({
                        remoteSessionId,
                        title: 'find this project B title',
                        linkData: { projectId: 'project-b' },
                    }),
                ]),
            },
        });
        if (!listed.ok) return;
        const projectB = listed.value.candidates.find(
            (candidate) => candidate.linkData?.projectId === 'project-b',
        );
        expect(projectB).toBeDefined();
        if (!projectB) return;

        const linked = await contribution.resolveLinkIdentity({
            ...invocation(),
            source,
            remoteSessionId,
            linkData: projectB.linkData,
        });
        expect(linked).toMatchObject({
            ok: true,
            value: {
                source: { kind: 'claudeConfig', projectId: 'project-b' },
                remoteSessionId,
                linkData: { projectId: 'project-b' },
            },
        });
        if (!linked.ok) return;

        const initialPage = await contribution.pageTranscript({
            ...invocation(4096),
            source: linked.value.source,
            remoteSessionId,
            direction: 'older',
            maxItems: 10,
        });
        expect(initialPage).toMatchObject({
            ok: true,
            value: {
                items: expect.arrayContaining([
                    expect.objectContaining({
                        messageRole: 'user',
                        userProjection: 'source_fact',
                        raw: {
                            role: 'user',
                            content: { type: 'text', text: 'find this project B title' },
                        },
                    }),
                ]),
                tailCursor: expect.any(String),
                hasMore: false,
            },
        });
        if (!initialPage.ok || !initialPage.value.tailCursor) return;

        await appendFile(projectBTranscript, [
            JSON.stringify({
                type: 'progress',
                uuid: 'project-b-progress',
                timestamp: '2026-06-08T00:00:01.500Z',
            }),
            JSON.stringify({
                type: 'future-transcript-message',
                uuid: 'project-b-future-transcript-message',
                timestamp: '2026-06-08T00:00:01.750Z',
                message: { content: 'must not be silently discarded' },
            }),
            JSON.stringify({
                type: 'assistant',
                uuid: 'project-b-live',
                timestamp: '2026-06-08T00:00:02.000Z',
                message: { content: [{ type: 'text', text: 'live project B answer' }] },
            }),
            '',
        ].join('\n'), 'utf8');
        const after = await contribution.readAfterTranscript({
            ...invocation(4096),
            source: linked.value.source,
            remoteSessionId,
            cursor: initialPage.value.tailCursor,
            maxItems: 10,
        });
        expect(after).toMatchObject({
            ok: true,
            value: {
                outcome: 'advanced',
                items: [expect.objectContaining({ messageRole: 'agent' })],
                nextCursor: expect.any(String),
                boundary: expect.any(String),
                diagnostics: [{
                    code: 'non_transcript_record_skipped',
                    count: 1,
                    positions: [expect.any(Number)],
                }, {
                    code: 'unsupported_record_skipped',
                    count: 1,
                    positions: [expect.any(Number)],
                }],
            },
        });
        expect(JSON.stringify(after)).toContain('live project B answer');
    });

    it('fails candidate discovery and transcript reads closed when projects escapes the admitted config root', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-claude-native-projects-root-escape-'));
        roots.push(root);
        const configDir = join(root, '.claude');
        const outsideProjectsDir = join(root, 'outside', 'tree');
        const projectId = 'project-a';
        const remoteSessionId = 'escaped-session';
        await mkdir(join(outsideProjectsDir, projectId), { recursive: true });
        await writeFile(
            join(outsideProjectsDir, projectId, `${remoteSessionId}.jsonl`),
            JSON.stringify({
                type: 'user',
                uuid: 'outside-user',
                message: { content: 'must not be read' },
            }) + '\n',
            'utf8',
        );
        await mkdir(configDir, { recursive: true });
        await symlink(outsideProjectsDir, join(configDir, 'projects'), 'dir');

        const contribution = createClaudeExternalSessionsContribution({
            env: { HAPPIER_CLAUDE_CONFIG_DIR: configDir },
        });
        const source = { kind: 'claudeConfig' as const, configDir, projectId };

        await expect(contribution.listCandidates({
            ...invocation(),
            source,
            maxItems: 10,
        })).resolves.toMatchObject({ ok: true, value: { candidates: [] } });
        await expect(contribution.pageTranscript({
            ...invocation(),
            source,
            remoteSessionId,
            direction: 'older',
            maxItems: 10,
        })).resolves.toMatchObject({ ok: true, value: { items: [], tailCursor: null } });
        await expect(contribution.readAfterTranscript({
            ...invocation(),
            source,
            remoteSessionId,
            cursor: 'tail',
            maxItems: 10,
        })).resolves.toEqual({ ok: true, value: { outcome: 'source_unavailable' } });
    });

    it('pages a Claude transcript forward in chronological order for hosted catch-up', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-claude-forward-page-'));
        roots.push(root);
        const configDir = join(root, '.claude');
        const remoteSessionId = 'forward-session';
        await createTranscript({
            configDir,
            projectId: 'forward-project',
            remoteSessionId,
            title: 'first prompt',
        });
        const contribution = createClaudeExternalSessionsContribution({
            env: { HAPPIER_CLAUDE_CONFIG_DIR: configDir },
        });
        const source = {
            kind: 'claudeConfig' as const,
            configDir,
            projectId: 'forward-project',
        };

        const first = await contribution.pageTranscript({
            ...invocation(),
            source,
            remoteSessionId,
            direction: 'newer',
            maxItems: 1,
        });
        expect(first).toMatchObject({
            ok: true,
            value: {
                items: [expect.objectContaining({
                    localId: 'claude-jsonl:main:user:forward-project-user',
                })],
                nextCursor: expect.any(String),
                tailCursor: expect.any(String),
                hasMore: true,
            },
        });
        if (!first.ok || !first.value.nextCursor) return;

        const second = await contribution.pageTranscript({
            ...invocation(),
            source,
            remoteSessionId,
            direction: 'newer',
            cursor: first.value.nextCursor,
            maxItems: 1,
        });
        expect(second).toMatchObject({
            ok: true,
            value: {
                items: [expect.objectContaining({
                    localId: 'claude-jsonl:main:assistant:forward-project-assistant',
                })],
                nextCursor: null,
                tailCursor: expect.any(String),
                hasMore: false,
            },
        });
    });

    it('projects each supported Claude content semantic or an explicit unsupported marker before advancing the transcript cursor', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-claude-semantic-transcript-'));
        roots.push(root);
        const configDir = join(root, '.claude');
        const projectId = 'semantic-project';
        const remoteSessionId = 'semantic-session';
        const transcriptDir = join(configDir, 'projects', projectId);
        await mkdir(transcriptDir, { recursive: true });
        await writeFile(join(transcriptDir, `${remoteSessionId}.jsonl`), [
            JSON.stringify({
                type: 'assistant',
                uuid: 'tool-only',
                timestamp: '2026-08-16T00:00:00.000Z',
                message: {
                    content: [{ type: 'tool_use', id: 'call-only', name: 'Read', input: { path: 'README.md' } }],
                },
            }),
            JSON.stringify({
                type: 'user',
                uuid: 'tool-result-only',
                timestamp: '2026-08-16T00:00:01.000Z',
                message: {
                    content: [{ type: 'tool_result', tool_use_id: 'call-only', content: 'README contents' }],
                },
            }),
            JSON.stringify({
                type: 'user',
                uuid: 'image-only',
                timestamp: '2026-08-16T00:00:02.000Z',
                message: {
                    content: [{
                        type: 'image',
                        source: { type: 'base64', media_type: 'image/png', data: 'private-image-bytes' },
                    }],
                },
            }),
            JSON.stringify({
                type: 'assistant',
                uuid: 'malformed-text',
                timestamp: '2026-08-16T00:00:02.500Z',
                message: { content: [{ type: 'text' }] },
            }),
            JSON.stringify({
                type: 'assistant',
                uuid: 'mixed',
                timestamp: '2026-08-16T00:00:03.000Z',
                message: {
                    content: [
                        { type: 'thinking', thinking: 'considering the file' },
                        { type: 'text', text: 'I will inspect it.' },
                        { type: 'tool_use', id: 'call-mixed', name: 'Bash', input: { command: 'pwd' } },
                    ],
                },
            }),
            '',
        ].join('\n'), 'utf8');

        const contribution = createClaudeExternalSessionsContribution({
            env: { HAPPIER_CLAUDE_CONFIG_DIR: configDir },
        });
        const page = await contribution.pageTranscript({
            ...invocation(),
            source: { kind: 'claudeConfig', configDir, projectId },
            remoteSessionId,
            direction: 'newer',
            maxItems: 10,
        });

        expect(page).toMatchObject({
            ok: true,
            value: {
                hasMore: false,
                nextCursor: null,
                tailCursor: expect.any(String),
            },
        });
        if (!page.ok) return;

        expect(page.value.items.map((item) => ({
            messageRole: item.messageRole,
            raw: item.raw,
        }))).toEqual([
            {
                messageRole: 'event',
                raw: {
                    role: 'agent',
                    content: {
                        type: 'acp',
                        agentId: 'claude',
                        data: {
                            type: 'tool-call',
                            callId: 'call-only',
                            name: 'Read',
                            input: { path: 'README.md' },
                            id: expect.any(String),
                        },
                    },
                },
            },
            {
                messageRole: 'event',
                raw: {
                    role: 'agent',
                    content: {
                        type: 'acp',
                        agentId: 'claude',
                        data: {
                            type: 'tool-result',
                            callId: 'call-only',
                            output: 'README contents',
                            id: expect.any(String),
                        },
                    },
                },
            },
            {
                messageRole: 'event',
                raw: {
                    role: 'agent',
                    content: {
                        type: 'acp',
                        agentId: 'claude',
                        data: {
                            type: 'message',
                            message: 'Claude emitted an unsupported image content block.',
                        },
                    },
                },
            },
            {
                messageRole: 'event',
                raw: {
                    role: 'agent',
                    content: {
                        type: 'acp',
                        agentId: 'claude',
                        data: {
                            type: 'message',
                            message: 'Claude emitted an unsupported content block.',
                        },
                    },
                },
            },
            {
                messageRole: 'event',
                raw: {
                    role: 'agent',
                    content: {
                        type: 'acp',
                        agentId: 'claude',
                        data: { type: 'thinking', text: 'considering the file' },
                    },
                },
            },
            {
                messageRole: 'agent',
                raw: {
                    role: 'agent',
                    content: {
                        type: 'acp',
                        agentId: 'claude',
                        data: { type: 'message', message: 'I will inspect it.' },
                    },
                },
            },
            {
                messageRole: 'event',
                raw: {
                    role: 'agent',
                    content: {
                        type: 'acp',
                        agentId: 'claude',
                        data: {
                            type: 'tool-call',
                            callId: 'call-mixed',
                            name: 'Bash',
                            input: { command: 'pwd' },
                            id: expect.any(String),
                        },
                    },
                },
            },
        ]);
        expect(new Set(page.value.items.map((item) => item.localId)).size).toBe(page.value.items.length);
        expect(JSON.stringify(page.value)).not.toContain('private-image-bytes');
    });

    it('emits an explicit marker instead of advancing past a mixed Claude row that exceeds the item limit', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-claude-semantic-item-limit-'));
        roots.push(root);
        const configDir = join(root, '.claude');
        const projectId = 'item-limit-project';
        const remoteSessionId = 'item-limit-session';
        const transcriptDir = join(configDir, 'projects', projectId);
        await mkdir(transcriptDir, { recursive: true });
        await writeFile(join(transcriptDir, `${remoteSessionId}.jsonl`), [
            JSON.stringify({
                type: 'assistant',
                uuid: 'mixed-over-limit',
                timestamp: '2026-08-16T00:00:00.000Z',
                message: {
                    content: [
                        { type: 'thinking', thinking: 'inspect first' },
                        { type: 'text', text: 'Inspecting now.' },
                        { type: 'tool_use', id: 'call-over-limit', name: 'Read', input: { path: 'README.md' } },
                    ],
                },
            }),
            '',
        ].join('\n'), 'utf8');

        const contribution = createClaudeExternalSessionsContribution({
            env: { HAPPIER_CLAUDE_CONFIG_DIR: configDir },
        });
        await expect(contribution.pageTranscript({
            ...invocation(),
            source: { kind: 'claudeConfig', configDir, projectId },
            remoteSessionId,
            direction: 'newer',
            maxItems: 1,
        })).resolves.toMatchObject({
            ok: true,
            value: {
                items: [{
                    messageRole: 'event',
                    raw: {
                        role: 'agent',
                        content: {
                            type: 'acp',
                            agentId: 'claude',
                            data: {
                                type: 'message',
                                message: 'Claude emitted an unsupported content block.',
                            },
                        },
                    },
                }],
                nextCursor: null,
                hasMore: false,
                tailCursor: expect.any(String),
            },
        });
    });

    it('advances a forward cursor with an explicit marker when a mixed Claude row exceeds the item limit', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-claude-semantic-follow-item-limit-'));
        roots.push(root);
        const configDir = join(root, '.claude');
        const projectId = 'follow-item-limit-project';
        const remoteSessionId = 'follow-item-limit-session';
        const transcriptPath = await createTranscript({
            configDir,
            projectId,
            remoteSessionId,
            title: 'existing prompt',
        });
        const contribution = createClaudeExternalSessionsContribution({
            env: { HAPPIER_CLAUDE_CONFIG_DIR: configDir },
        });
        const source = { kind: 'claudeConfig' as const, configDir, projectId };
        const tail = await contribution.pageTranscript({
            ...invocation(),
            source,
            remoteSessionId,
            direction: 'older',
            maxItems: 10,
        });
        expect(tail).toMatchObject({
            ok: true,
            value: { tailCursor: expect.any(String) },
        });
        if (!tail.ok || !tail.value.tailCursor) return;

        await appendFile(transcriptPath, `${JSON.stringify({
            type: 'assistant',
            uuid: 'mixed-forward-over-limit',
            timestamp: '2026-08-16T00:00:00.000Z',
            message: {
                content: [
                    { type: 'thinking', thinking: 'inspect first' },
                    { type: 'text', text: 'Inspecting now.' },
                    { type: 'tool_use', id: 'call-forward-over-limit', name: 'Read', input: { path: 'README.md' } },
                ],
            },
        })}\n`, 'utf8');

        await expect(contribution.readAfterTranscript({
            ...invocation(),
            source,
            remoteSessionId,
            cursor: tail.value.tailCursor,
            maxItems: 1,
        })).resolves.toMatchObject({
            ok: true,
            value: {
                outcome: 'advanced',
                items: [{
                    messageRole: 'event',
                    raw: {
                        role: 'agent',
                        content: {
                            type: 'acp',
                            agentId: 'claude',
                            data: {
                                type: 'message',
                                message: 'Claude emitted an unsupported content block.',
                            },
                        },
                    },
                }],
                nextCursor: expect.any(String),
                boundary: expect.any(String),
            },
        });
    });

    it('reports malformed source UTF-8 by byte offset without admitting replacement text', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-claude-malformed-utf8-'));
        roots.push(root);
        const configDir = join(root, '.claude');
        const remoteSessionId = 'malformed-utf8-session';
        const transcriptPath = await createTranscript({
            configDir,
            projectId: 'project-utf8',
            remoteSessionId,
            title: 'valid prompt',
        });
        const contribution = createClaudeExternalSessionsContribution({
            env: { HAPPIER_CLAUDE_CONFIG_DIR: configDir },
        });
        const source = {
            kind: 'claudeConfig' as const,
            configDir,
            projectId: 'project-utf8',
        };
        const initial = await contribution.pageTranscript({
            ...invocation(),
            source,
            remoteSessionId,
            direction: 'older',
            maxItems: 10,
        });
        expect(initial.ok).toBe(true);
        if (!initial.ok || !initial.value.tailCursor) return;

        const before = (await readFile(transcriptPath)).byteLength;
        const prefix = Buffer.from(
            '{"type":"assistant","uuid":"invalid-utf8","timestamp":"2026-06-08T00:00:02.000Z","message":{"content":[{"type":"text","text":"',
            'utf8',
        );
        await appendFile(
            transcriptPath,
            Buffer.concat([prefix, Buffer.from([0xff]), Buffer.from('"}]}}\n', 'utf8')]),
        );

        await expect(contribution.readAfterTranscript({
            ...invocation(),
            source,
            remoteSessionId,
            cursor: initial.value.tailCursor,
            maxItems: 10,
        })).resolves.toEqual({
            ok: true,
            value: {
                outcome: 'advanced',
                items: [],
                nextCursor: expect.any(String),
                boundary: expect.any(String),
                hasMore: false,
                diagnostics: [{
                    code: 'malformed_source_utf8',
                    severity: 'required',
                    count: 1,
                    positions: [before + prefix.byteLength],
                }],
            },
        });
    });

    it.each([
        'identical replacement',
        'in-place rewrite',
    ] as const)('reports source_replaced when a forward cursor is replayed after a same-path %s', async (mutation) => {
        const root = await mkdtemp(join(tmpdir(), 'happier-claude-native-rewrite-'));
        roots.push(root);
        const configDir = join(root, '.claude');
        const remoteSessionId = 'rewritten-session';
        const transcriptPath = await createTranscript({
            configDir,
            projectId: 'rewrite-project',
            remoteSessionId,
            title: 'original prompt',
        });
        const contribution = createClaudeExternalSessionsContribution({
            env: { HAPPIER_CLAUDE_CONFIG_DIR: configDir },
        });
        const source = {
            kind: 'claudeConfig' as const,
            configDir,
            projectId: 'rewrite-project',
        };
        const initial = await contribution.pageTranscript({
            ...invocation(),
            source,
            remoteSessionId,
            direction: 'older',
            maxItems: 10,
        });
        expect(initial).toMatchObject({
            ok: true,
            value: { tailCursor: expect.any(String) },
        });
        if (!initial.ok || !initial.value.tailCursor) return;

        if (mutation === 'identical replacement') {
            const identicalBytes = await readFile(transcriptPath);
            const replacementPath = `${transcriptPath}.replacement`;
            await writeFile(replacementPath, identicalBytes);
            await rename(replacementPath, transcriptPath);
        } else {
            await writeFile(transcriptPath, [
                JSON.stringify({
                    type: 'user',
                    uuid: 'replacement-user',
                    timestamp: '2026-06-08T00:00:00.000Z',
                    cwd: '/work/rewrite-project',
                    message: { content: 'replacement prompt' },
                }),
                JSON.stringify({
                    type: 'assistant',
                    uuid: 'replacement-assistant',
                    timestamp: '2026-06-08T00:00:01.000Z',
                    message: { content: [{ type: 'text', text: 'replacement answer' }] },
                }),
                '',
            ].join('\n'), 'utf8');
        }

        await expect(contribution.readAfterTranscript({
            ...invocation(),
            source,
            remoteSessionId,
            cursor: initial.value.tailCursor,
            maxItems: 10,
        })).resolves.toEqual({
            ok: true,
            value: { outcome: 'source_replaced' },
        });
    });

    it.each([
        'identical replacement',
        'in-place rewrite',
    ] as const)('refuses to continue a backward page across a same-path %s', async (mutation) => {
        const root = await mkdtemp(join(tmpdir(), 'happier-claude-backward-rewrite-'));
        roots.push(root);
        const configDir = join(root, '.claude');
        const remoteSessionId = 'backward-rewritten-session';
        const transcriptDir = join(configDir, 'projects', 'backward-rewrite-project');
        await mkdir(transcriptDir, { recursive: true });
        const transcriptPath = join(transcriptDir, `${remoteSessionId}.jsonl`);
        const originalRows = [0, 1, 2, 3].map((index) => JSON.stringify({
            type: 'user',
            uuid: `original-${index}`,
            timestamp: `2026-06-08T00:00:0${index}.000Z`,
            cwd: '/work/backward-rewrite-project',
            message: { content: `original row ${index}` },
        }));
        await writeFile(transcriptPath, `${originalRows.join('\n')}\n`, 'utf8');
        const contribution = createClaudeExternalSessionsContribution({
            env: { HAPPIER_CLAUDE_CONFIG_DIR: configDir },
        });
        const source = {
            kind: 'claudeConfig' as const,
            configDir,
            projectId: 'backward-rewrite-project',
        };

        const first = await contribution.pageTranscript({
            ...invocation(),
            source,
            remoteSessionId,
            direction: 'older',
            maxItems: 1,
        });
        expect(first).toMatchObject({ ok: true, value: { hasMore: true, nextCursor: expect.any(String) } });
        if (!first.ok || !first.value.nextCursor) return;

        if (mutation === 'identical replacement') {
            const identicalBytes = await readFile(transcriptPath);
            const replacementPath = `${transcriptPath}.replacement`;
            await writeFile(replacementPath, identicalBytes);
            await rename(replacementPath, transcriptPath);
        } else {
            await writeFile(
                transcriptPath,
                `${[0, 1, 2, 3].map((index) => JSON.stringify({
                    type: 'user',
                    uuid: `replacement-${index}`,
                    timestamp: `2026-06-08T00:00:0${index}.000Z`,
                    cwd: '/work/backward-rewrite-project',
                    message: { content: `replacement row ${index}` },
                })).join('\n')}\n`,
                'utf8',
            );
        }

        // A backward cursor names a byte position inside ONE physical generation
        // of the file. After a same-path replacement that position means nothing,
        // so continuing it would splice rows from the replacement in among rows
        // the caller already received from the original.
        const second = await contribution.pageTranscript({
            ...invocation(),
            source,
            remoteSessionId,
            direction: 'older',
            cursor: first.value.nextCursor,
            maxItems: 10,
        });

        expect(second).toMatchObject({
            ok: true,
            value: { items: [], nextCursor: null, hasMore: false, truncated: true },
        });
    });

    it('preserves project and title search while canonicalizing persisted linked identity', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-claude-native-search-'));
        roots.push(root);
        const configDir = join(root, '.claude');
        await createTranscript({
            configDir,
            projectId: 'search-project',
            remoteSessionId: 'search-session',
            title: 'distinctive title needle',
        });
        const contribution = createClaudeExternalSessionsContribution({
            env: { HAPPIER_CLAUDE_CONFIG_DIR: configDir },
        });
        const canonicalConfigDir = await realpath(configDir);
        const source = { kind: 'claudeConfig' as const };

        const fast = await contribution.listCandidates({
            ...invocation(),
            source,
            maxItems: 5,
            searchTerm: 'search-project',
            searchMode: 'fast',
        });
        expect(fast).toMatchObject({
            ok: true,
            value: {
                candidates: [expect.objectContaining({ linkData: { projectId: 'search-project' } })],
                searchIncomplete: true,
            },
        });

        const full = await contribution.listCandidates({
            ...invocation(),
            source,
            maxItems: 5,
            searchTerm: 'title needle',
            searchMode: 'full',
        });
        expect(full).toMatchObject({
            ok: true,
            value: {
                candidates: [expect.objectContaining({
                    title: 'distinctive title needle',
                    linkData: { projectId: 'search-project' },
                })],
            },
        });

        const restored = await contribution.resolveLinkedIdentity({
            ...invocation(),
            source: { kind: 'claudeConfig', configDir, projectId: 'stale-project' },
            remoteSessionId: 'search-session',
            linkData: { projectId: 'search-project' },
        });
        expect(restored).toMatchObject({
            ok: true,
            value: {
                source: { kind: 'claudeConfig', configDir: canonicalConfigDir, projectId: 'search-project' },
                linkData: { projectId: 'search-project' },
            },
        });
    });

    it('keeps candidate pages within the host byte budget without losing the next candidate', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-claude-native-byte-budget-'));
        roots.push(root);
        const configDir = join(root, '.claude');
        await createTranscript({
            configDir,
            projectId: 'byte-budget-project',
            remoteSessionId: 'first-session',
            title: '😀'.repeat(10_000),
        });
        await createTranscript({
            configDir,
            projectId: 'byte-budget-project',
            remoteSessionId: 'second-session',
            title: '😀'.repeat(10_000),
        });
        await createTranscript({
            configDir,
            projectId: 'byte-budget-project',
            remoteSessionId: 'third-session',
            title: '😀'.repeat(10_000),
        });
        const contribution = createClaudeExternalSessionsContribution({
            env: { HAPPIER_CLAUDE_CONFIG_DIR: configDir },
        });
        const maxSerializedBytes = 512;

        const first = await contribution.listCandidates({
            ...invocation(maxSerializedBytes),
            source: { kind: 'claudeConfig', configDir },
            maxItems: 2,
        });
        expect(first.ok).toBe(true);
        expect(Buffer.byteLength(JSON.stringify(first), 'utf8')).toBeLessThanOrEqual(maxSerializedBytes);
        if (!first.ok) return;
        expect(first.value.candidates.length).toBeGreaterThan(0);
        expect(first.value.candidates.every((candidate) => !('title' in candidate))).toBe(true);
        expect(first.value.nextCursor).toEqual(expect.any(String));

        const seen = new Set(first.value.candidates.map((candidate) => candidate.remoteSessionId));
        let cursor = first.value.nextCursor;
        for (let pageIndex = 0; cursor && pageIndex < 5; pageIndex += 1) {
            const next = await contribution.listCandidates({
                ...invocation(maxSerializedBytes),
                source: { kind: 'claudeConfig', configDir },
                cursor,
                maxItems: 2,
            });
            expect(next.ok).toBe(true);
            expect(Buffer.byteLength(JSON.stringify(next), 'utf8')).toBeLessThanOrEqual(maxSerializedBytes);
            if (!next.ok) return;
            for (const candidate of next.value.candidates) {
                expect(seen.has(candidate.remoteSessionId)).toBe(false);
                seen.add(candidate.remoteSessionId);
            }
            cursor = next.value.nextCursor;
        }
        expect(cursor).toBeNull();
        expect(seen).toEqual(new Set(['first-session', 'second-session', 'third-session']));
    });

    it('keeps backward transcript pages within the host byte budget without losing the next item', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-claude-native-transcript-budget-'));
        roots.push(root);
        const configDir = join(root, '.claude');
        const transcriptPath = await createTranscript({
            configDir,
            projectId: 'transcript-budget-project',
            remoteSessionId: 'transcript-budget-session',
            title: 'oldest transcript item',
        });
        for (let index = 0; index < 4; index += 1) {
            await appendFile(transcriptPath, `${JSON.stringify({
                type: 'assistant',
                uuid: `budget-assistant-${index}`,
                timestamp: `2026-06-08T00:00:0${index + 2}.000Z`,
                message: { content: [{ type: 'text', text: `budget answer ${index} ${'x'.repeat(160)}` }] },
            })}\n`, 'utf8');
        }
        const contribution = createClaudeExternalSessionsContribution({
            env: { HAPPIER_CLAUDE_CONFIG_DIR: configDir },
        });
        const source = {
            kind: 'claudeConfig' as const,
            configDir,
            projectId: 'transcript-budget-project',
        };
        const reference = await contribution.pageTranscript({
            ...invocation(),
            source,
            remoteSessionId: 'transcript-budget-session',
            direction: 'older',
            maxItems: 1,
        });
        expect(reference.ok).toBe(true);
        const maxSerializedBytes = Buffer.byteLength(JSON.stringify(reference), 'utf8') + 128;

        const first = await contribution.pageTranscript({
            ...invocation(maxSerializedBytes),
            source,
            remoteSessionId: 'transcript-budget-session',
            direction: 'older',
            maxItems: 10,
        });
        expect(first.ok).toBe(true);
        expect(Buffer.byteLength(JSON.stringify(first), 'utf8')).toBeLessThanOrEqual(maxSerializedBytes);
        if (!first.ok) return;
        expect(first.value.items).toHaveLength(1);
        expect(first.value.nextCursor).toEqual(expect.any(String));

        const second = await contribution.pageTranscript({
            ...invocation(maxSerializedBytes),
            source,
            remoteSessionId: 'transcript-budget-session',
            direction: 'older',
            cursor: first.value.nextCursor ?? undefined,
            maxItems: 10,
        });
        expect(second.ok).toBe(true);
        expect(Buffer.byteLength(JSON.stringify(second), 'utf8')).toBeLessThanOrEqual(maxSerializedBytes);
        if (!second.ok) return;
        expect(second.value.items).not.toHaveLength(0);
        expect(second.value.items[0]?.id).not.toBe(first.value.items[0]?.id);
    });

    it.each(['completed', 'failed', 'stopped'] as const)('issue506 projects authenticated queued task %s beside unchanged native evidence', async (status) => {
        const root = await mkdtemp(join(tmpdir(), 'happier-claude-task-outcome-'));
        roots.push(root);
        const configDir = join(root, '.claude');
        const remoteSessionId = 'queued-task-outcome';
        const source = { kind: 'claudeConfig', configDir, projectId: 'task-outcome' };
        const transcriptPath = await createTranscript({ configDir, projectId: source.projectId, remoteSessionId, title: 'existing' });
        const contribution = createClaudeExternalSessionsContribution({ env: { HAPPIER_CLAUDE_CONFIG_DIR: configDir } });
        const tail = await contribution.pageTranscript({ ...invocation(), source, remoteSessionId, direction: 'older', maxItems: 10 });
        if (!tail.ok || !tail.value.tailCursor) throw new Error('expected task outcome cursor');
        const timestamp = '2026-06-08T00:02:00.000Z';
        const xml = `<task-notification><task-id>native-child</task-id><tool-use-id>agent-launch-tool</tool-use-id><status>${status}</status><summary>Native child findings</summary></task-notification>`;
        const notification = {
            type: 'attachment', uuid: 'native-queued-terminal', sessionId: remoteSessionId, timestamp,
            attachment: { type: 'queued_command', commandMode: 'task-notification', prompt: xml,
                origin: { kind: 'task-notification', taskId: 'native-child', toolUseId: 'agent-launch-tool', status } },
        };
        const copied = { type: 'user', uuid: 'copied-terminal', sessionId: remoteSessionId, timestamp, message: { role: 'user', content: xml } };
        const bareQueue = { type: 'queue-operation', operation: 'enqueue', content: xml, sessionId: remoteSessionId, timestamp };
        await appendFile(transcriptPath, [copied, bareQueue, notification].map(row => JSON.stringify(row)).join('\n') + '\n');
        const result = await contribution.readAfterTranscript({ ...invocation(), source, remoteSessionId, cursor: tail.value.tailCursor, maxItems: 50 });
        if (!result.ok || result.value.outcome !== 'advanced') throw new Error('expected queued task outcome');
        const outcomes = result.value.items.filter(item => item.raw.role === 'agent');
        expect(outcomes).toEqual([expect.objectContaining({ raw: {
            role: 'agent', content: expect.objectContaining({ data: expect.objectContaining({
                type: 'tool-result', callId: 'agent-launch-tool',
                output: status === 'completed' ? expect.anything() : expect.objectContaining({ tool_use_result: expect.objectContaining({ status: status === 'stopped' ? 'cancelled' : 'failed', result: 'Native child findings' }) }),
                isError: status !== 'completed',
            }) }),
        } })]);
        expect(JSON.stringify(outcomes)).toContain('Native child findings');
        const terminal = await contribution.readAfterTranscript({ ...invocation(), source, remoteSessionId, cursor: tail.value.tailCursor, projection: 'terminal', maxItems: 50 });
        if (!terminal.ok || terminal.value.outcome !== 'advanced') throw new Error('expected ordered native observations');
        expect(terminal.value.items.filter(item => item.raw.role === 'source_observation').map(item => item.raw.content)).toEqual([copied, bareQueue, notification]);
        expect(terminal.value.items.filter(item => item.raw.role === 'agent')).toEqual([]);
        expect(await contribution.readAfterTranscript({ ...invocation(), source, remoteSessionId, cursor: result.value.nextCursor, projection: 'terminal', maxItems: 50 }))
            .toEqual({ ok: true, value: { outcome: 'already_current' } });
    });

    it('retains native async agent alias evidence beside ordered terminal history', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-claude-native-agent-history-'));
        roots.push(root);
        const configDir = join(root, '.claude');
        const remoteSessionId = 'native-agent-history';
        const source = { kind: 'claudeConfig', configDir, projectId: 'agent-history' };
        const transcriptPath = await createTranscript({ configDir, projectId: source.projectId, remoteSessionId, title: 'existing' });
        const contribution = createClaudeExternalSessionsContribution({ env: { HAPPIER_CLAUDE_CONFIG_DIR: configDir } });
        const tail = await contribution.pageTranscript({ ...invocation(), source, remoteSessionId, direction: 'older', maxItems: 10 });
        if (!tail.ok || !tail.value.tailCursor) throw new Error('expected native history cursor');
        const rows = [{
            type: 'assistant', uuid: 'native-agent-launch', parentUuid: `${source.projectId}-user`, session_id: remoteSessionId, timestamp: '2026-06-08T00:02:00.000Z',
            message: { content: [{ type: 'tool_use', id: 'agent-tool', name: 'Agent', input: { description: 'worker' } }] },
        }, {
            type: 'user', uuid: 'native-agent-alias', parentUuid: 'native-agent-launch', session_id: remoteSessionId, timestamp: '2026-06-08T00:02:01.000Z',
            message: { content: [{ type: 'tool_result', tool_use_id: 'agent-tool', content: 'launched' }] },
            toolUseResult: { status: 'async_launched', agentId: 'native-child' },
        }];
        await appendFile(transcriptPath, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
        const current = await contribution.readAfterTranscript({
            ...invocation(), source, remoteSessionId, cursor: tail.value.tailCursor, projection: 'terminal', maxItems: 50,
        });
        if (!current.ok || current.value.outcome !== 'advanced') throw new Error('expected current native rows');
        expect(current.value.items.filter(item => item.raw.role === 'source_observation').map(item => item.raw.content)).toEqual(rows);
        const history = await contribution.pageTranscript({
            ...invocation(), source, remoteSessionId, direction: 'older', projection: 'terminal', maxItems: 50,
        });
        if (!history.ok) throw new Error('expected ordered terminal history');
        const aliasEvidence = history.value.items.filter(item => item.raw.role === 'source_observation'
            && rows.some(row => item.raw.content && typeof item.raw.content === 'object'
                && 'uuid' in item.raw.content && item.raw.content.uuid === row.uuid));
        expect(aliasEvidence.map(item => item.raw.content)).toEqual(rows);
        // Claude keeps the detached child alive while the parent rewinds onto another branch.
        await appendFile(transcriptPath, JSON.stringify({ type: 'assistant', uuid: 'current-branch',
            parentUuid: `${source.projectId}-user`, session_id: remoteSessionId,
            timestamp: '2026-06-08T00:03:00.000Z', message: { content: [{ type: 'text', text: 'current branch answer' }] },
        }) + '\n');
        const branched = await contribution.pageTranscript({
            ...invocation(), source, remoteSessionId, direction: 'older', projection: 'terminal', maxItems: 50,
        });
        if (!branched.ok) throw new Error('expected branch history');
        expect(branched.value.items.filter(item => item.raw.role === 'source_observation'
            && rows.some(row => row.uuid === (item.raw.content as { uuid?: string }).uuid)).map(item => item.raw.content)).toEqual(rows);
        const visible = branched.value.items.filter(item => item.raw.role !== 'source_observation');
        expect(JSON.stringify(visible)).toContain('current branch answer');
        expect(JSON.stringify(visible)).not.toContain('agent-tool');
    });

    it.each([false, true])('preserves ordered native observations only for terminal reads (bounded: %s)', async (bounded) => {
        const root = await mkdtemp(join(tmpdir(), 'happier-claude-terminal-observations-'));
        roots.push(root);
        const configDir = join(root, '.claude');
        const remoteSessionId = 'terminal-observations';
        const source = { kind: 'claudeConfig', configDir, projectId: 'terminal-project' };
        const transcriptPath = await createTranscript({ configDir, projectId: source.projectId, remoteSessionId, title: 'existing' });
        const contribution = createClaudeExternalSessionsContribution({ env: { HAPPIER_CLAUDE_CONFIG_DIR: configDir } });
        const tail = await contribution.pageTranscript({ ...invocation(), source, remoteSessionId, direction: 'older', maxItems: 10 });
        if (!tail.ok || !tail.value.tailCursor) throw new Error('expected tail cursor');
        const timestamp = '2026-06-08T00:02:00.000Z';
        const nativeRows = [
            { type: 'assistant', uuid: 'answer', timestamp, message: { content: [{ type: 'text', text: 'answer' }] } },
            { type: 'queue-operation', operation: 'enqueue', content: 'queued', timestamp },
            { type: 'queue-operation', operation: 'remove', content: 'queued', timestamp },
            { type: 'user', uuid: 'tool-result', timestamp, message: { content: [{ type: 'tool_result', tool_use_id: 'call', content: 'done' }] } },
            { type: 'attachment', attachment: { type: 'queued_command', prompt: 'queued' }, timestamp },
            { type: 'user', uuid: 'user', timestamp, promptSource: 'queued', message: { content: 'queued' } },
            { type: 'user', uuid: 'slash', timestamp, message: { content: '<command-name>/help</command-name>' } },
            { type: 'user', uuid: 'compact', timestamp, isCompactSummary: true, message: { content: 'compact summary' } },
        ];
        await appendFile(transcriptPath, nativeRows.map((row) => JSON.stringify(row)).join('\n') + '\n');
        const request = { ...invocation(), source, remoteSessionId, cursor: tail.value.tailCursor, maxItems: 50 };
        const ordinary = await contribution.readAfterTranscript(request);
        if (!ordinary.ok || ordinary.value.outcome !== 'advanced') throw new Error('expected ordinary items');
        expect(ordinary.value.items.every((item) => item.raw.role === 'user' || item.raw.role === 'agent')).toBe(true);
        expect(ordinary.value.items).toHaveLength(5);
        const page = await contribution.pageTranscript({ ...invocation(), source, remoteSessionId, direction: 'older', maxItems: 50 });
        if (!page.ok) throw new Error('expected browse items');
        expect(page.value.items.every((item) => item.raw.role === 'user' || item.raw.role === 'agent')).toBe(true);
        const reference = await contribution.readAfterTranscript({ ...request, projection: 'terminal', maxItems: 1 });
        if (!reference.ok || reference.value.outcome !== 'advanced') throw new Error('expected first terminal item');
        const maxSerializedBytes = bounded ? Buffer.byteLength(JSON.stringify(reference), 'utf8') + 180 : request.maxSerializedBytes;
        const items = [];
        let cursor = request.cursor;
        for (let index = 0; index < nativeRows.length; index += 1) {
            const result = await contribution.readAfterTranscript({ ...request, cursor, projection: 'terminal', maxSerializedBytes });
            if (!result.ok || result.value.outcome !== 'advanced') throw new Error('expected terminal continuation');
            expect(Buffer.byteLength(JSON.stringify(result), 'utf8')).toBeLessThanOrEqual(maxSerializedBytes);
            expect(result.value.items.length).toBeGreaterThan(0);
            items.push(...result.value.items);
            cursor = result.value.nextCursor;
            if (!result.value.hasMore) break;
        }
        expect(items.map((item) => item.raw.role)).toEqual(['agent', 'source_observation', 'source_observation', 'agent', 'source_observation', 'source_observation', 'source_observation', 'source_observation']);
        expect(items.filter((item) => item.raw.role === 'source_observation').map((item) => item.raw.content)).toEqual(nativeRows.filter((_, index) => index !== 0 && index !== 3));
        expect(items[3]?.raw).toMatchObject({ role: 'agent', content: { data: { type: 'tool-result', callId: 'call', output: 'done' } } });
        expect(items.every((item) => item.createdAtMs === Date.parse(timestamp))).toBe(true);
        expect(new Set(items.map((item) => item.id)).size).toBe(nativeRows.length);
        const fresh = await contribution.pageTranscript({ ...invocation(), source, remoteSessionId, direction: 'newer', projection: 'terminal', maxItems: 50 });
        if (!fresh.ok) throw new Error('expected fresh terminal page');
        expect(fresh.value.items.slice(2)).toEqual(items);
        expect(fresh.value.items[0]?.raw.role).toBe('source_observation');
        expect(await contribution.readAfterTranscript({ ...request, cursor, projection: 'terminal' })).toEqual({ ok: true, value: { outcome: 'already_current' } });
    });

    it('preserves terminal prompt evidence without carrying oversized inline image bytes', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-claude-terminal-image-'));
        roots.push(root);
        const configDir = join(root, '.claude');
        const remoteSessionId = 'terminal-image';
        const source = { kind: 'claudeConfig', configDir, projectId: 'terminal-project' };
        const transcriptPath = await createTranscript({ configDir, projectId: source.projectId, remoteSessionId, title: 'existing' });
        const contribution = createClaudeExternalSessionsContribution({ env: { HAPPIER_CLAUDE_CONFIG_DIR: configDir } });
        const maxSerializedBytes = 524_288; // Host external-session transcript invocation policy.
        const tail = await contribution.pageTranscript({ ...invocation(maxSerializedBytes), source, remoteSessionId, direction: 'older', maxItems: 10 });
        if (!tail.ok || !tail.value.tailCursor) throw new Error('expected tail cursor');
        const imageData = 'A'.repeat(maxSerializedBytes + 1024);
        const row = {
            type: 'user' as const, uuid: 'image-prompt', timestamp: '2026-06-08T00:02:00.000Z',
            promptSource: 'queued', parentUuid: 'parent', promptId: 'prompt-image',
            message: { content: [
                { type: 'text', text: 'Explain this image' },
                { type: 'image', source: { type: 'base64', media_type: 'image/png', data: imageData } },
            ] },
        };
        await appendFile(transcriptPath, JSON.stringify(row) + '\n');
        const request = { ...invocation(maxSerializedBytes), source, remoteSessionId, cursor: tail.value.tailCursor, maxItems: 10 };
        const ordinary = await contribution.readAfterTranscript(request);
        expect(ordinary.ok).toBe(true);
        if (!ordinary.ok || ordinary.value.outcome !== 'advanced') throw new Error('expected ordinary image prompt');
        expect(JSON.stringify(ordinary.value)).not.toContain(imageData);
        const terminal = await contribution.readAfterTranscript({ ...request, projection: 'terminal' });
        expect(terminal.ok).toBe(true);
        if (!terminal.ok || terminal.value.outcome !== 'advanced') throw new Error('expected terminal image prompt');
        expect(terminal.value.items).toHaveLength(1);
        expect(terminal.value.items[0]?.raw).toMatchObject({ role: 'source_observation', content: {
            type: 'user', uuid: row.uuid, timestamp: row.timestamp, promptSource: row.promptSource, parentUuid: row.parentUuid, promptId: row.promptId,
            message: { content: [{ type: 'text', text: 'Explain this image' }, { type: 'image' }] },
        } });
        const classification = classifyClaudeNativeTranscriptRow(terminal.value.items[0]?.raw.content);
        expect(classification.lifecycle).toEqual({ kind: 'text', text: 'Explain this image' });
        expect(classification.semanticParts).toEqual([
            { kind: 'text', text: 'Explain this image' }, { kind: 'unsupported', source: 'image' },
        ]);
        if (!classification.row) throw new Error('expected native prompt row');
        expect(projectClaudeTranscriptRowToProviderPayload({
            providerSessionId: remoteSessionId, row: classification.row, suppressPriorEraTurnClosure: false,
        })).toMatchObject({
            providerSessionId: remoteSessionId, turnId: row.uuid, kind: 'text', text: 'Explain this image',
        });
        expect(JSON.stringify(terminal)).not.toContain(imageData);
        expect(Buffer.byteLength(JSON.stringify(terminal))).toBeLessThanOrEqual(maxSerializedBytes);
        expect(await contribution.readAfterTranscript({ ...request, cursor: terminal.value.nextCursor, projection: 'terminal' })).toEqual({ ok: true, value: { outcome: 'already_current' } });
    });

    it('orders lifecycle observations after their visible row and preserves atomic item budgeting', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-claude-terminal-lifecycle-'));
        roots.push(root);
        const configDir = join(root, '.claude');
        const remoteSessionId = 'terminal-lifecycle';
        const source = { kind: 'claudeConfig', configDir, projectId: 'terminal-project' };
        const transcriptPath = await createTranscript({ configDir, projectId: source.projectId, remoteSessionId, title: 'existing' });
        const contribution = createClaudeExternalSessionsContribution({ env: { HAPPIER_CLAUDE_CONFIG_DIR: configDir } });
        const tail = await contribution.pageTranscript({ ...invocation(), source, remoteSessionId, direction: 'older', maxItems: 10 });
        if (!tail.ok || !tail.value.tailCursor) throw new Error('expected tail cursor');
        const timestamp = '2026-06-08T00:02:00.000Z';
        const rows = [
            { type: 'assistant', uuid: 'stop', timestamp, message: { content: [{ type: 'text', text: 'finished' }], stop_reason: 'end_turn' } },
            { type: 'assistant', uuid: 'error', timestamp, isApiErrorMessage: true, message: { content: [{ type: 'text', text: 'failed' }] } },
            { type: 'system', uuid: 'compact', timestamp, subtype: 'compact_boundary' },
            { type: 'user', uuid: 'feedback', timestamp, isMeta: true, message: { content: 'Stop hook feedback:\ncontinue' } },
            { type: 'user', uuid: 'interrupted', timestamp, message: { content: '[Request interrupted by user]' } },
        ];
        await appendFile(transcriptPath, rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
        const request = { ...invocation(), source, remoteSessionId, cursor: tail.value.tailCursor, projection: 'terminal' as const };
        const tooSmall = await contribution.readAfterTranscript({ ...request, maxItems: 1 });
        expect(tooSmall.ok).toBe(false);
        const first = await contribution.readAfterTranscript({ ...request, maxItems: 3 });
        if (!first.ok || first.value.outcome !== 'advanced') throw new Error('expected first lifecycle page');
        expect(first.value.items.map((item) => item.raw.role)).toEqual(['agent', 'source_observation']);
        expect(first.value.items[1]?.raw.content).toEqual(rows[0]);
        expect(first.value.hasMore).toBe(true);
        const second = await contribution.readAfterTranscript({ ...request, cursor: first.value.nextCursor, maxItems: 2 });
        if (!second.ok || second.value.outcome !== 'advanced') throw new Error('expected lifecycle continuation');
        expect(second.value.items.map((item) => item.raw.role)).toEqual(['agent', 'source_observation']);
        expect(second.value.items[1]?.raw.content).toEqual(rows[1]);
        const rest = await contribution.readAfterTranscript({ ...request, cursor: second.value.nextCursor, maxItems: 10 });
        if (!rest.ok || rest.value.outcome !== 'advanced') throw new Error('expected lifecycle remainder');
        expect(rest.value.items.map((item) => item.raw.content)).toEqual(rows.slice(2));
        const all = [...first.value.items, ...second.value.items, ...rest.value.items];
        expect(new Set(all.map((item) => item.id)).size).toBe(all.length);
    });

    it('keeps forward transcript reads within the host byte budget without losing the next item', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-claude-native-forward-budget-'));
        roots.push(root);
        const configDir = join(root, '.claude');
        const transcriptPath = await createTranscript({
            configDir,
            projectId: 'forward-budget-project',
            remoteSessionId: 'forward-budget-session',
            title: 'existing transcript item',
        });
        const contribution = createClaudeExternalSessionsContribution({
            env: { HAPPIER_CLAUDE_CONFIG_DIR: configDir },
        });
        const source = {
            kind: 'claudeConfig' as const,
            configDir,
            projectId: 'forward-budget-project',
        };
        // `readAfterTranscript` answers an up-to-date follow with a bare
        // `already_current` — the public read-after DTO carries no cursor in that
        // shape — so the forward starting point is the page DTO's tail cursor.
        // Reading it off the read-after result instead is how this case used to
        // skip itself entirely.
        const tail = await contribution.pageTranscript({
            ...invocation(),
            source,
            remoteSessionId: 'forward-budget-session',
            direction: 'older',
            maxItems: 1,
        });
        expect(tail).toMatchObject({ ok: true, value: { tailCursor: expect.any(String) } });
        if (!tail.ok || !tail.value.tailCursor) throw new Error('expected a forward tail cursor');
        const tailCursor = tail.value.tailCursor;
        for (let index = 0; index < 4; index += 1) {
            await appendFile(transcriptPath, `${JSON.stringify({
                type: 'assistant',
                uuid: `forward-budget-assistant-${index}`,
                timestamp: `2026-06-08T00:01:0${index}.000Z`,
                message: { content: [{ type: 'text', text: `forward answer ${index} ${'x'.repeat(160)}` }] },
            })}\n`, 'utf8');
        }
        const reference = await contribution.readAfterTranscript({
            ...invocation(),
            source,
            remoteSessionId: 'forward-budget-session',
            cursor: tailCursor,
            maxItems: 1,
        });
        expect(reference).toMatchObject({
            ok: true,
            value: { outcome: 'advanced', items: [expect.anything()] },
        });
        const maxSerializedBytes = Buffer.byteLength(JSON.stringify(reference), 'utf8') + 128;

        const first = await contribution.readAfterTranscript({
            ...invocation(maxSerializedBytes),
            source,
            remoteSessionId: 'forward-budget-session',
            cursor: tailCursor,
            maxItems: 10,
        });
        expect(first).toMatchObject({
            ok: true,
            value: {
                outcome: 'advanced',
                nextCursor: expect.any(String),
                hasMore: true,
            },
        });
        expect(Buffer.byteLength(JSON.stringify(first), 'utf8')).toBeLessThanOrEqual(maxSerializedBytes);
        if (!first.ok || !first.value.nextCursor) throw new Error('expected a forward continuation cursor');
        expect(first.value.items).toHaveLength(1);

        const second = await contribution.readAfterTranscript({
            ...invocation(maxSerializedBytes),
            source,
            remoteSessionId: 'forward-budget-session',
            cursor: first.value.nextCursor,
            maxItems: 10,
        });
        expect(second.ok).toBe(true);
        expect(Buffer.byteLength(JSON.stringify(second), 'utf8')).toBeLessThanOrEqual(maxSerializedBytes);
        if (!second.ok) throw new Error('expected a second forward page');
        expect(second.value.items).not.toHaveLength(0);
        expect(second.value.items[0]?.id).not.toBe(first.value.items[0]?.id);
    });

    it('does not read a duplicate session id from another project after the qualified source disappears', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-claude-native-qualified-source-'));
        roots.push(root);
        const configDir = join(root, '.claude');
        const remoteSessionId = 'shared-session';
        await createTranscript({
            configDir,
            projectId: 'project-a',
            remoteSessionId,
            title: 'project A prompt',
        });
        const projectBTranscript = await createTranscript({
            configDir,
            projectId: 'project-b',
            remoteSessionId,
            title: 'project B prompt',
        });
        const contribution = createClaudeExternalSessionsContribution({
            env: { HAPPIER_CLAUDE_CONFIG_DIR: configDir },
        });

        const linked = await contribution.resolveLinkIdentity({
            ...invocation(),
            source: { kind: 'claudeConfig', configDir },
            remoteSessionId,
            linkData: { projectId: 'project-b' },
        });
        expect(linked).toMatchObject({
            ok: true,
            value: {
                source: { kind: 'claudeConfig', projectId: 'project-b' },
            },
        });
        if (!linked.ok) return;

        await rm(projectBTranscript);
        const page = await contribution.pageTranscript({
            ...invocation(),
            source: linked.value.source,
            remoteSessionId,
            direction: 'older',
            maxItems: 10,
        });

        expect(page).toMatchObject({
            ok: true,
            value: { items: [] },
        });
    });

    it('returns typed failures for invalid sources and missing candidates', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-claude-native-missing-'));
        roots.push(root);
        const configDir = join(root, '.claude');
        await mkdir(configDir, { recursive: true });
        const contribution = createClaudeExternalSessionsContribution({
            env: { HAPPIER_CLAUDE_CONFIG_DIR: configDir },
        });
        expect(await contribution.resolveSource({
            ...invocation(),
            source: { kind: 'other' },
        })).toEqual({
            ok: false,
            code: 'source_invalid',
            message: 'provider/source mismatch',
        });
        expect(await contribution.resolveLinkIdentity({
            ...invocation(),
            source: { kind: 'claudeConfig' },
            remoteSessionId: 'missing-session',
        })).toMatchObject({
            ok: false,
            code: 'candidate_not_found',
        });
    });
    // POSIX permissions only: Windows and root ignore the mode bits this uses.
    it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
        'reports an unreadable transcript as an Agent fault rather than an unavailable Agent',
        async () => {
            const root = await mkdtemp(join(tmpdir(), 'happier-claude-unreadable-'));
            roots.push(root);
            const configDir = join(root, '.claude');
            const remoteSessionId = 'unreadable-session';
            const transcriptPath = await createTranscript({
                configDir,
                projectId: 'unreadable',
                remoteSessionId,
                title: 'first prompt',
            });
            await chmod(transcriptPath, 0o000);
            try {
                const contribution = createClaudeExternalSessionsContribution({
                    env: { HAPPIER_CLAUDE_CONFIG_DIR: configDir },
                });
                await expect(contribution.pageTranscript({
                    ...invocation(),
                    source: { kind: 'claudeConfig', configDir, projectId: 'unreadable' },
                    remoteSessionId,
                    direction: 'older',
                    maxItems: 10,
                })).resolves.toMatchObject({ ok: false, code: 'agent_error' });
            } finally {
                await chmod(transcriptPath, 0o600);
            }
        },
    );

    it('fails an older page closed when it consumes an unsupported native record', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-claude-older-unsupported-'));
        roots.push(root);
        const configDir = join(root, '.claude');
        const remoteSessionId = 'older-unsupported-session';
        const transcriptPath = await createTranscript({
            configDir,
            projectId: 'older-unsupported',
            remoteSessionId,
            title: 'first prompt',
        });
        await appendFile(transcriptPath, [
            JSON.stringify({
                type: 'future-transcript-message',
                uuid: 'older-unsupported-future',
                timestamp: '2026-06-08T00:00:01.500Z',
                message: { content: 'must not be silently discarded' },
            }),
            JSON.stringify({
                type: 'assistant',
                uuid: 'older-unsupported-assistant-2',
                timestamp: '2026-06-08T00:00:02.000Z',
                message: { content: [{ type: 'text', text: 'later answer' }] },
            }),
            '',
        ].join('\n'), 'utf8');
        const contribution = createClaudeExternalSessionsContribution({
            env: { HAPPIER_CLAUDE_CONFIG_DIR: configDir },
        });

        const page = await contribution.pageTranscript({
            ...invocation(),
            source: { kind: 'claudeConfig', configDir, projectId: 'older-unsupported' },
            remoteSessionId,
            direction: 'older',
            maxItems: 50,
        });
        expect(page).toMatchObject({ ok: true, value: { truncated: true } });
    });

    it('keeps an older page complete across ratified non-transcript records', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-claude-older-known-'));
        roots.push(root);
        const configDir = join(root, '.claude');
        const remoteSessionId = 'older-known-session';
        const transcriptPath = await createTranscript({
            configDir,
            projectId: 'older-known',
            remoteSessionId,
            title: 'first prompt',
        });
        await appendFile(transcriptPath, [
            JSON.stringify({ type: 'progress', uuid: 'known-progress', timestamp: '2026-06-08T00:00:01.100Z' }),
            JSON.stringify({ type: 'system', uuid: 'known-system', subtype: 'init', timestamp: '2026-06-08T00:00:01.200Z' }),
            JSON.stringify({ type: 'queue-operation', operation: 'enqueue', timestamp: '2026-06-08T00:00:01.300Z' }),
            JSON.stringify({ type: 'file-history-snapshot', messageId: 'known-snapshot', snapshot: {} }),
            JSON.stringify({ type: 'last-prompt', lastPrompt: 'hi', leafUuid: 'known-leaf' }),
            JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: 'r1' } }),
            JSON.stringify({
                type: 'attachment',
                uuid: 'known-attachment',
                attachment: { type: 'deferred_tools_delta', addedNames: ['WebFetch'] },
            }),
            JSON.stringify({
                type: 'result',
                subtype: 'success',
                uuid: 'known-result',
                session_id: remoteSessionId,
                usage: {},
                modelUsage: {},
            }),
            '',
        ].join('\n'), 'utf8');
        const contribution = createClaudeExternalSessionsContribution({
            env: { HAPPIER_CLAUDE_CONFIG_DIR: configDir },
        });

        const page = await contribution.pageTranscript({
            ...invocation(),
            source: { kind: 'claudeConfig', configDir, projectId: 'older-known' },
            remoteSessionId,
            direction: 'older',
            maxItems: 50,
        });
        expect(page.ok).toBe(true);
        if (!page.ok) return;
        expect(page.value.truncated).toBeFalsy();
        expect(page.value.items.length).toBe(2);
    });

    it('rejects a malformed backward cursor instead of restarting at the tail', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-claude-bad-cursor-'));
        roots.push(root);
        const configDir = join(root, '.claude');
        const remoteSessionId = 'bad-cursor-session';
        await createTranscript({
            configDir,
            projectId: 'bad-cursor',
            remoteSessionId,
            title: 'first prompt',
        });
        const contribution = createClaudeExternalSessionsContribution({
            env: { HAPPIER_CLAUDE_CONFIG_DIR: configDir },
        });

        expect(await contribution.pageTranscript({
            ...invocation(),
            source: { kind: 'claudeConfig', configDir, projectId: 'bad-cursor' },
            remoteSessionId,
            direction: 'older',
            cursor: 'not-a-claude-backward-cursor',
            maxItems: 50,
        })).toMatchObject({ ok: false, code: 'invalid_request' });
    });
});
