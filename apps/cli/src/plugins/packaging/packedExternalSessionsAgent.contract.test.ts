import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
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
 *
 * The pack input is a fresh copy of the fixture package, so the production
 * pack lifecycle runs over a copied package and the proof never reads the
 * committed fixture tree in place. The daemon travels as committed source
 * (`src/daemon.mjs`) copied into the archive — no built dist is committed,
 * frozen, or certified here.
 */
async function stagePackedFixture(parent: string): Promise<Readonly<{
    rootPath: string;
    cleanup(): Promise<void>;
}>> {
    const packageRoot = join(parent, 'fixture-package');
    await cp(fixtureRoot, packageRoot, { recursive: true });
    const archivePath = join(parent, 'packed-external-sessions.tgz');
    const installRoot = join(parent, 'installed');
    const packed = await packLocalPlugin({ locator: packageRoot, outPath: archivePath });
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

type PackedBackgroundProbe = Readonly<{
    id: string;
    run(context: unknown): Promise<void>;
}>;

/**
 * Activates the staged leaf by calling its exported `activate` against the
 * public activation ABI shape at this harness boundary, and returns the
 * contribution it registered, wrapped by the canonical host invocation
 * owner — the same wrapper production builds for a bundled Agent — plus the
 * registered background service probe and its results path.
 *
 * Scope: this is packed leaf/ABI/invocation-bounds proof only. The activation
 * and the always-current fixture are composed here by the harness, so these
 * tests do not prove daemon install, currentness, or the packed-loaded
 * lifecycle; those are owned by the daemon plugin runtime owner and the
 * packed current-source program.
 */
async function bindStagedExternalSessionsContribution(rootPath: string) {
    let registeredAgentId: string | null = null;
    let contribution: AgentExternalSessionsContribution | null = null;
    let backgroundProbe: PackedBackgroundProbe | null = null;
    const module = await import(pathToFileURL(join(rootPath, 'src/daemon.mjs')).href) as Readonly<{
        activate(api: Readonly<{
            agents: Readonly<{
                registerExternalSessions(
                    agentId: string,
                    value: AgentExternalSessionsContribution,
                ): void;
            }>;
            backgroundServices: Readonly<{
                register(
                    id: string,
                        run: (context: unknown) => Promise<void>,
                ): void;
            }>;
        }>): void;
    }>;
    module.activate({
        agents: {
            registerExternalSessions(agentId, value) {
                registeredAgentId = agentId;
                contribution = value;
            },
        },
        backgroundServices: {
            register(id, run) {
                backgroundProbe = { id, run };
            },
        },
    });
    expect(registeredAgentId).toBe(AGENT_ID);
    if (!contribution) throw new Error('packed external-sessions fixture registered no contribution');
    if (!backgroundProbe) {
        throw new Error('packed external-sessions fixture registered no background probe');
    }
    const registeredBackgroundProbe: PackedBackgroundProbe = backgroundProbe;
    return {
        bounded: createBoundedAgentExternalSessionsContribution({
            contribution,
            identity,
            isCurrent: () => true,
            retirementSignal: new AbortController().signal,
            createInvocationExec: async () => createUnavailablePluginServices().exec,
        }),
        backgroundProbe: registeredBackgroundProbe,
        probeOutputPath: join(rootPath, 'packed-external-sessions-probe.json'),
    };
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

describe('packed External Sessions Agent contract', () => {
    it('packs a copied source package with executable daemon bytes and the explicit Sessions grant', async () => {
        const parent = await mkdtemp(join(tmpdir(), 'happier-packed-external-sessions-'));
        let staged: Awaited<ReturnType<typeof stagePackedFixture>> | null = null;
        try {
            staged = await stagePackedFixture(parent);

            // The Agent's External Sessions source declaration and the
            // executable daemon entrypoint must survive the archive
            // round-trip: without them the host has nothing to configure or
            // execute.
            const stagedManifest = JSON.parse(await readFile(
                join(staged.rootPath, '.happier-plugin', 'plugin.json'),
                'utf8',
            )) as unknown;
            const ingested = ingestPluginManifestV2(stagedManifest);
            expect(ingested).toMatchObject({ ok: true });
            if (!ingested.ok) return;
            expect(ingested.manifest.entrypoints).toEqual({
                daemon: './src/daemon.mjs',
            });
            // The explicit Sessions read+control grant is what authorizes
            // production to supply `services.sessions.external`; the packed
            // consumer issues its six public calls only under this grant.
            expect(ingested.manifest.hostAccess).toMatchObject({
                required: [expect.objectContaining({
                    id: 'packed-external-sessions',
                    capability: 'sessions',
                    scope: { access: ['read', 'control'] },
                })],
            });
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

            // The staged bytes execute: importing the packed daemon source
            // registers the contribution through the public activation ABI.
            await bindStagedExternalSessionsContribution(staged.rootPath);
        } finally {
            await staged?.cleanup();
            await rm(parent, { recursive: true, force: true });
        }
    });

    it('serves discovery, paging and continuation through the canonical bounded invocation owner', async () => {
        const parent = await mkdtemp(join(tmpdir(), 'happier-packed-external-sessions-page-'));
        let staged: Awaited<ReturnType<typeof stagePackedFixture>> | null = null;
        try {
            staged = await stagePackedFixture(parent);
            const { bounded } = await bindStagedExternalSessionsContribution(staged.rootPath);

            const resolved = await bounded.resolveSource({ ...bounds, source: SOURCE });
            expect(resolved).toEqual({ ok: true, value: { source: SOURCE } });

            // Discovery: the host clamps the requested window to its own page
            // ceiling; the packed leaf pages from the clamped window.
            const firstPage = await bounded.listCandidates({
                ...bounds,
                source: SOURCE,
                maxItems: 1,
            });
            expect(firstPage.ok).toBe(true);
            if (!firstPage.ok) return;
            expect(firstPage.value.candidates.map(({ remoteSessionId }) => remoteSessionId))
                .toEqual(['packed-session-1']);
            expect(EXTERNAL_SESSIONS_INVOCATION_POLICY.listCandidates.maxItems).toBe(50);

            // Paging: the continuation rides a leaf-owned cursor inside the
            // host's qualified envelope.
            expect(decodeQualifiedCursor(firstPage.value.nextCursor ?? '')).toMatchObject({
                v: 1,
                p: PLUGIN_ID,
                a: AGENT_ID,
                g: identity.generation,
                m: 'listCandidates',
                r: null,
                c: '1',
            });
            const pagedSecond = await bounded.listCandidates({
                ...bounds,
                source: SOURCE,
                maxItems: 1,
                cursor: firstPage.value.nextCursor ?? undefined,
            });
            expect(pagedSecond.ok).toBe(true);
            if (!pagedSecond.ok) return;
            expect(pagedSecond.value.candidates.map(({ remoteSessionId }) => remoteSessionId))
                .toEqual(['packed-session-2']);
            expect(pagedSecond.value.nextCursor).toBeNull();

            // The envelope is method-bound: a discovery cursor cannot be
            // replayed into a transcript read, even by the plugin that owns it.
            expect(await bounded.pageTranscript({
                ...bounds,
                source: SOURCE,
                remoteSessionId: 'packed-session-1',
                direction: 'older',
                maxItems: 2,
                cursor: firstPage.value.nextCursor ?? undefined,
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

            // Transcript paging: admitted by the canonical host projection —
            // the documented canonical agent-content form is admitted
            // verbatim, and source facts ride beside the raw record.
            const tail = await bounded.pageTranscript({
                ...bounds,
                source: SOURCE,
                remoteSessionId: 'packed-session-1',
                direction: 'older',
                maxItems: 2,
            });
            expect(tail.ok).toBe(true);
            if (!tail.ok) return;
            expect(tail.value.items.map(({ id }) => id)).toEqual(['packed-item-1', 'packed-item-2']);
            expect(tail.value.items[0]?.raw).toEqual({
                role: 'agent',
                content: {
                    type: 'acp',
                    agentId: AGENT_ID,
                    data: { type: 'message', message: 'Packed transcript one.' },
                },
            });
            expect(tail.value.items[1]).toMatchObject({
                messageRole: 'user',
                userProjection: 'source_fact',
                raw: { role: 'user', content: { type: 'text', text: 'Summarize what you found.' } },
            });

            // Continuation: the packed leaf is already current at its
            // watermark.
            const current = await bounded.readAfterTranscript({
                ...bounds,
                source: SOURCE,
                remoteSessionId: 'packed-session-1',
                cursor: 'packedFixtureStore:after:2',
                maxItems: 10,
            });
            expect(current).toEqual({ ok: true, value: { outcome: 'already_current' } });
        } finally {
            await staged?.cleanup();
            await rm(parent, { recursive: true, force: true });
        }
    });

    it('packed leaf bytes issue all six public External Sessions service calls against a harness recording service', async () => {
        const parent = await mkdtemp(join(tmpdir(), 'happier-packed-external-sessions-six-'));
        let staged: Awaited<ReturnType<typeof stagePackedFixture>> | null = null;
        try {
            staged = await stagePackedFixture(parent);
            const { backgroundProbe, probeOutputPath } =
                await bindStagedExternalSessionsContribution(staged.rootPath);
            const probe = backgroundProbe;
            expect(probe.id).toBe('packed-external-sessions-probe');

            // Harness-supplied recording stub at the public SDK service
            // surface — not the granted service. The probe proves the packed
            // bytes issue every public call; the manifest grant is validated
            // in the pack test above, while grant-to-service supply and the
            // packed-loaded lifecycle are owned by the daemon runtime registry
            // (`resolveExecutablePluginRuntimeRegistry` current-global
            // coverage) and the packed current-source program, and are not
            // re-decided or proven here.
            const calls: string[] = [];
            const ref = {
                agentId: AGENT_ID,
                source: SOURCE,
                remoteSessionId: 'packed-session-1',
            };
            const external = {
                capabilities: async () => {
                    calls.push('capabilities');
                    return { follow: { status: 'available' } };
                },
                list: async () => {
                    calls.push('list');
                    return { items: [], nextCursor: null };
                },
                attach: async () => {
                    calls.push('attach');
                    return { sessionId: 'linked-session-1' };
                },
                readTranscript: async () => {
                    calls.push('readTranscript');
                    return { kind: 'data', items: [], fromCursor: null, nextCursor: 'n' };
                },
                followTranscript: async (
                    _ref: unknown,
                    _options: unknown,
                    _listener: unknown,
                ) => {
                    calls.push('followTranscript');
                    return {
                        status: 'following',
                        startingCursor: null,
                        subscription: { dispose: async () => undefined },
                    };
                },
                takeover: async () => {
                    calls.push('takeover');
                    throw Object.assign(
                        new Error('no linked session'),
                        { code: 'source_invalid' },
                    );
                },
            };
            await probe.run({
                services: { sessions: { external } },
            });

            expect(calls).toEqual([
                'capabilities',
                'list',
                'attach',
                'readTranscript',
                'followTranscript',
                'takeover',
            ]);
            // The packed probe persists its typed outcomes next to the
            // installed daemon, so the recorded evidence survives activation.
            const recorded = JSON.parse(await readFile(probeOutputPath, 'utf8')) as Readonly<{
                capabilities: unknown;
                list: unknown;
                attach: unknown;
                readTranscript: unknown;
                followTranscript: unknown;
                takeover: Readonly<{ status: string; code: string | null }>;
            }>;
            expect(Object.keys(recorded)).toEqual([
                'capabilities',
                'list',
                'attach',
                'readTranscript',
                'followTranscript',
                'takeover',
            ]);
            expect(recorded.takeover).toEqual({ status: 'rejected', code: 'source_invalid' });
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
            const retiredModule = await import(pathToFileURL(join(
                staged.rootPath,
                'src/daemon.mjs',
            )).href) as Readonly<{
                activate(api: Readonly<{
                    agents: Readonly<{
                        registerExternalSessions(
                            agentId: string,
                            value: AgentExternalSessionsContribution,
                        ): void;
                    }>;
                    backgroundServices: Readonly<{
                        register(
                            id: string,
                            run: (context: unknown) => Promise<void>,
                        ): void;
                    }>;
                }>): void;
            }>;
            let contribution: AgentExternalSessionsContribution | null = null;
            retiredModule.activate({
                agents: {
                    registerExternalSessions(_agentId, value) { contribution = value; },
                },
                backgroundServices: {
                    register() {},
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
