import { appendFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import type { AgentExternalSessionsContribution } from '@happier-dev/plugin-sdk/experimental/sessions';

import * as providerOps from './contribution.js';

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
                diagnostics: [{
                    code: 'malformed_source_utf8',
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
            await rm(transcriptPath);
            await writeFile(transcriptPath, identicalBytes);
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
        const tail = await contribution.readAfterTranscript({
            ...invocation(),
            source,
            remoteSessionId: 'forward-budget-session',
            cursor: 'tail',
            maxItems: 10,
        });
        expect(tail.ok).toBe(true);
        if (!tail.ok || !tail.value.nextCursor) return;
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
            cursor: tail.value.nextCursor,
            maxItems: 1,
        });
        expect(reference.ok).toBe(true);
        const maxSerializedBytes = Buffer.byteLength(JSON.stringify(reference), 'utf8') + 128;

        const first = await contribution.readAfterTranscript({
            ...invocation(maxSerializedBytes),
            source,
            remoteSessionId: 'forward-budget-session',
            cursor: tail.value.nextCursor,
            maxItems: 10,
        });
        expect(first.ok).toBe(true);
        expect(Buffer.byteLength(JSON.stringify(first), 'utf8')).toBeLessThanOrEqual(maxSerializedBytes);
        if (!first.ok || !first.value.nextCursor) return;
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
        if (!second.ok) return;
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
});
