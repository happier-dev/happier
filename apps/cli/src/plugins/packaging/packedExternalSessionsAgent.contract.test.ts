import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';

import { ingestPluginManifestV2 } from '@happier-dev/protocol';
import type { AgentExternalSessionsContribution } from '@happier-dev/plugin-sdk/sessions/external';

import { createUnavailablePluginServices } from '../runtime/invocation/services/unavailable';
import {
    createBoundedAgentExternalSessionsContribution,
    EXTERNAL_SESSIONS_INVOCATION_POLICY,
} from '../../session/external/agentExternalSessionsInvocation';
import {
    cleanupStagedNpmArtifactCandidate,
    stageDownloadedNpmArtifactCandidate,
} from '../distribution/npm/stage';
import { sriSha512 } from '../distribution/testkit/npmTarball';
import { packLocalPlugin } from './pack';

const fixtureRoot = fileURLToPath(new URL(
    '../testkit/fixtures/packed-external-sessions-agent',
    import.meta.url,
));

const PLUGIN_ID = 'acme.packed-external-sessions';
const AGENT_ID = 'packed-external-agent';
const SOURCE = Object.freeze({ kind: 'packedFixtureStore', scope: 'primary' });

const identity = Object.freeze({
    pluginId: PLUGIN_ID,
    agentId: AGENT_ID,
    generation: 'packed-external-sessions-generation',
    contributionQualifiedId: `${PLUGIN_ID}/agents/${AGENT_ID}`,
    immutableGenerationId: 'packed-external-sessions-immutable-generation',
});

/**
 * Installs the packed archive into a clean location outside the fixture tree
 * and returns the staged candidate, so every assertion below reads bytes that
 * survived pack + integrity verification + extraction.
 */
async function stagePackedFixture(parent: string): Promise<Readonly<{
    rootPath: string;
    cleanup(): Promise<void>;
}>> {
    const archivePath = join(parent, 'packed-external-sessions.tgz');
    const installRoot = join(parent, 'installed');
    const packed = await packLocalPlugin({ locator: fixtureRoot, outPath: archivePath });
    expect(
        packed,
        packed.ok ? '' : packed.diagnostics.map((entry) => entry.message).join('\n'),
    ).toMatchObject({ ok: true, pluginId: PLUGIN_ID });
    const archiveBytes = await readFile(archivePath);
    await mkdir(installRoot);
    const staged = await stageDownloadedNpmArtifactCandidate({
        candidate: {
            source: {
                kind: 'npm',
                registryOrigin: 'https://packed-external-sessions.invalid',
                packageName: 'happier-plugin-acme-packed-external-sessions',
                version: '1.0.0',
                integrity: sriSha512(archiveBytes),
                tarballUrl: pathToFileURL(archivePath).href,
            },
            artifactPath: archivePath,
            byteLength: archiveBytes.byteLength,
            archiveDigestSha256: `sha256:${createHash('sha256').update(archiveBytes).digest('hex')}`,
            registrySignature: { status: 'absent' },
            provenance: { status: 'absent' },
        },
        stagingParentPath: installRoot,
    });
    expect(staged.ok).toBe(true);
    if (!staged.ok) throw new Error(staged.rejection.message);
    return Object.freeze({
        rootPath: staged.candidate.rootPath,
        async cleanup() { await cleanupStagedNpmArtifactCandidate(staged.candidate); },
    });
}

/**
 * Activates the staged leaf through the public activation ABI shape and returns
 * the contribution it registered, wrapped by the canonical host invocation
 * owner — the same wrapper production builds for a bundled Agent.
 */
async function bindStagedExternalSessionsContribution(rootPath: string) {
    let registeredAgentId: string | null = null;
    let contribution: AgentExternalSessionsContribution | null = null;
    const module = await import(pathToFileURL(join(rootPath, 'dist/daemon.js')).href) as Readonly<{
        activate(api: Readonly<{ agents: Readonly<{
            registerExternalSessions(
                agentId: string,
                value: AgentExternalSessionsContribution,
            ): void;
        }> }>): void;
    }>;
    module.activate({
        agents: {
            registerExternalSessions(agentId, value) {
                registeredAgentId = agentId;
                contribution = value;
            },
        },
    });
    expect(registeredAgentId).toBe(AGENT_ID);
    if (!contribution) throw new Error('packed external-sessions fixture registered no contribution');
    return createBoundedAgentExternalSessionsContribution({
        contribution,
        identity,
        isCurrent: () => true,
        retirementSignal: new AbortController().signal,
        createInvocationExec: async () => createUnavailablePluginServices().exec,
    });
}

const QUALIFIED_CURSOR_PREFIX = 'happier_external_cursor_v1:';

/**
 * The host reissues every leaf cursor inside an opaque envelope bound to the
 * plugin, Agent, generation, source and method. Decoding it here is how the
 * test proves the packed leaf's own cursor is what travels inside.
 */
function decodeQualifiedCursor(cursor: string): Readonly<Record<string, unknown>> {
    expect(cursor.startsWith(QUALIFIED_CURSOR_PREFIX)).toBe(true);
    return JSON.parse(Buffer.from(
        cursor.slice(QUALIFIED_CURSOR_PREFIX.length),
        'base64url',
    ).toString('utf8')) as Readonly<Record<string, unknown>>;
}

const bounds = Object.freeze({
    signal: new AbortController().signal,
    deadlineAtMs: Number.MAX_SAFE_INTEGER,
    maxSerializedBytes: Number.MAX_SAFE_INTEGER,
});

describe('packed external External Sessions Agent contract', () => {
    it('packs, stages, and serves discovery, paging and continuation through the host invocation owner', async () => {
        const parent = await mkdtemp(join(tmpdir(), 'happier-packed-external-sessions-'));
        let staged: Awaited<ReturnType<typeof stagePackedFixture>> | null = null;
        try {
            staged = await stagePackedFixture(parent);

            // The Agent's External Sessions source declaration must survive the
            // archive round-trip: without it the host has nothing to configure.
            const stagedManifest = JSON.parse(await readFile(
                join(staged.rootPath, '.happier-plugin', 'plugin.json'),
                'utf8',
            )) as unknown;
            const ingested = ingestPluginManifestV2(stagedManifest);
            expect(ingested).toMatchObject({ ok: true });
            if (!ingested.ok) return;
            expect(ingested.manifest.contributes.agents).toEqual([expect.objectContaining({
                id: AGENT_ID,
                capabilities: expect.objectContaining({ surfaces: ['externalSessions'] }),
                surfaces: expect.objectContaining({
                    externalSession: {
                        sources: [expect.objectContaining({
                            sourceKind: SOURCE.kind,
                            instances: [{ kind: 'default', constants: { scope: 'primary' } }],
                        })],
                    },
                }),
            })]);

            const bounded = await bindStagedExternalSessionsContribution(staged.rootPath);

            const resolved = await bounded.resolveSource({ ...bounds, source: SOURCE });
            expect(resolved).toEqual({ ok: true, value: { source: SOURCE } });

            // Discovery: the host clamps the requested window to its own page
            // ceiling. The packed leaf refuses anything larger, so an unclamped
            // window would surface here as `agent_error`, not as a large page.
            const firstPage = await bounded.listCandidates({
                ...bounds,
                source: SOURCE,
                maxItems: 9_999,
            });
            expect(firstPage.ok).toBe(true);
            if (!firstPage.ok) return;
            expect(firstPage.value.candidates).toHaveLength(7);
            expect(firstPage.value.candidates[0]).toMatchObject({
                remoteSessionId: 'packed-session-1',
                title: 'Packed external session 1',
            });
            expect(firstPage.value.nextCursor).toBeNull();
            expect(EXTERNAL_SESSIONS_INVOCATION_POLICY.listCandidates.maxItems).toBe(50);

            // Paging: a smaller window pages with a leaf-owned cursor.
            const pagedFirst = await bounded.listCandidates({
                ...bounds,
                source: SOURCE,
                maxItems: 3,
            });
            expect(pagedFirst.ok).toBe(true);
            if (!pagedFirst.ok) return;
            expect(pagedFirst.value.candidates.map(({ remoteSessionId }) => remoteSessionId))
                .toEqual(['packed-session-1', 'packed-session-2', 'packed-session-3']);
            expect(decodeQualifiedCursor(pagedFirst.value.nextCursor ?? '')).toMatchObject({
                v: 1,
                p: PLUGIN_ID,
                a: AGENT_ID,
                g: identity.generation,
                m: 'listCandidates',
                r: null,
                c: 'packedFixtureStore:candidates:3',
            });
            const pagedSecond = await bounded.listCandidates({
                ...bounds,
                source: SOURCE,
                maxItems: 3,
                cursor: pagedFirst.value.nextCursor ?? undefined,
            });
            expect(pagedSecond.ok).toBe(true);
            if (!pagedSecond.ok) return;
            expect(pagedSecond.value.candidates.map(({ remoteSessionId }) => remoteSessionId))
                .toEqual(['packed-session-4', 'packed-session-5', 'packed-session-6']);

            // The envelope is method-bound: a discovery cursor cannot be
            // replayed into a transcript read, even by the plugin that owns it.
            expect(await bounded.pageTranscript({
                ...bounds,
                source: SOURCE,
                remoteSessionId: 'packed-session-1',
                direction: 'older',
                maxItems: 2,
                cursor: pagedFirst.value.nextCursor ?? undefined,
            })).toEqual({ ok: false, code: 'invalid_request', retryable: false });

            const linked = await bounded.resolveLinkIdentity({
                ...bounds,
                source: SOURCE,
                remoteSessionId: 'packed-session-1',
            });
            expect(linked).toEqual({
                ok: true,
                value: {
                    source: SOURCE,
                    remoteSessionId: 'packed-session-1',
                    linkData: { store: 'packed-fixture', linked: true },
                },
            });

            // Transcript paging: two `older` pages, admitted by the canonical
            // raw-record parser rather than passed through.
            const tail = await bounded.pageTranscript({
                ...bounds,
                source: SOURCE,
                remoteSessionId: 'packed-session-1',
                direction: 'older',
                maxItems: 2,
            });
            expect(tail.ok).toBe(true);
            if (!tail.ok) return;
            expect(tail.value.items.map(({ id }) => id)).toEqual(['packed-item-3', 'packed-item-4']);
            // The documented canonical agent-content form, admitted verbatim.
            expect(tail.value.items[0]?.raw).toEqual({
                role: 'agent',
                content: {
                    type: 'acp',
                    agentId: AGENT_ID,
                    data: { type: 'message', message: 'Two contributions and one source.' },
                },
            });
            expect(tail.value.hasMore).toBe(true);
            expect(decodeQualifiedCursor(tail.value.tailCursor ?? '')).toMatchObject({
                m: 'readAfterTranscript',
                r: 'packed-session-1',
                c: 'packedFixtureStore:after:5',
            });

            const older = await bounded.pageTranscript({
                ...bounds,
                source: SOURCE,
                remoteSessionId: 'packed-session-1',
                direction: 'older',
                maxItems: 2,
                cursor: tail.value.nextCursor ?? undefined,
            });
            expect(older.ok).toBe(true);
            if (!older.ok) return;
            expect(older.value.items.map(({ id }) => id)).toEqual(['packed-item-1', 'packed-item-2']);
            expect(older.value.items[1]).toMatchObject({
                messageRole: 'user',
                userProjection: 'source_fact',
                raw: { role: 'user', content: { type: 'text', text: 'Summarize what you found.' } },
            });

            // Continuation: a stale tail advances, and the boundary it returns
            // is already current on the next read.
            const advanced = await bounded.readAfterTranscript({
                ...bounds,
                source: SOURCE,
                remoteSessionId: 'packed-session-1',
                cursor: 'packedFixtureStore:after:3',
                maxItems: 10,
            });
            expect(advanced).toMatchObject({ ok: true, value: { outcome: 'advanced' } });
            if (!advanced.ok || advanced.value.outcome !== 'advanced') return;
            expect(advanced.value.items.map(({ id }) => id)).toEqual(['packed-item-3', 'packed-item-4']);
            // `boundary` stays the leaf's own opaque watermark; only the
            // cursor the host hands back for the next call is qualified.
            expect(advanced.value.boundary).toBe('packedFixtureStore:after:5');
            expect(decodeQualifiedCursor(advanced.value.nextCursor)).toMatchObject({
                m: 'readAfterTranscript',
                r: 'packed-session-1',
                c: 'packedFixtureStore:after:5',
            });

            const current = await bounded.readAfterTranscript({
                ...bounds,
                source: SOURCE,
                remoteSessionId: 'packed-session-1',
                cursor: advanced.value.nextCursor,
                maxItems: 10,
            });
            expect(current).toEqual({ ok: true, value: { outcome: 'already_current' } });
        } finally {
            await staged?.cleanup();
            await rm(parent, { recursive: true, force: true });
        }
    });

    it('applies host retirement and cancellation to the packed leaf', async () => {
        const parent = await mkdtemp(join(tmpdir(), 'happier-packed-external-sessions-fencing-'));
        let staged: Awaited<ReturnType<typeof stagePackedFixture>> | null = null;
        try {
            staged = await stagePackedFixture(parent);
            const module = await import(pathToFileURL(join(
                staged.rootPath,
                'dist/daemon.js',
            )).href) as Readonly<{
                activate(api: Readonly<{ agents: Readonly<{
                    registerExternalSessions(
                        agentId: string,
                        value: AgentExternalSessionsContribution,
                    ): void;
                }> }>): void;
            }>;
            let contribution: AgentExternalSessionsContribution | null = null;
            module.activate({
                agents: {
                    registerExternalSessions(_agentId, value) { contribution = value; },
                },
            });
            if (!contribution) throw new Error('packed external-sessions fixture registered no contribution');

            const retirement = new AbortController();
            const retired = createBoundedAgentExternalSessionsContribution({
                contribution,
                identity,
                isCurrent: () => true,
                retirementSignal: retirement.signal,
                createInvocationExec: async () => createUnavailablePluginServices().exec,
            });
            retirement.abort();
            expect(await retired.listCandidates({ ...bounds, source: SOURCE, maxItems: 3 }))
                .toEqual({ ok: false, code: 'unavailable', retryable: true });

            const cancellation = new AbortController();
            const live = createBoundedAgentExternalSessionsContribution({
                contribution,
                identity,
                isCurrent: () => true,
                retirementSignal: new AbortController().signal,
                createInvocationExec: async () => createUnavailablePluginServices().exec,
            });
            cancellation.abort();
            expect(await live.listCandidates({
                ...bounds,
                signal: cancellation.signal,
                source: SOURCE,
                maxItems: 3,
            })).toEqual({ ok: false, code: 'cancelled', retryable: false });
        } finally {
            await staged?.cleanup();
            await rm(parent, { recursive: true, force: true });
        }
    });
});
