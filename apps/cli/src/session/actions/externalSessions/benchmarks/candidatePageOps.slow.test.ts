import { realpathSync } from 'node:fs';
import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import type { AgentExternalSessionsManagedEndpointRead } from '@happier-dev/plugin-sdk/sessions/external';
import {
    activate as activateClaudePlugin,
    PLUGIN_MANIFEST as CLAUDE_PLUGIN_MANIFEST,
} from '@happier-dev/plugins-claude';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    ExternalSessionProviderFailureError,
    type ExternalSessionCandidatesPage,
} from '@/session/external/providerOps';
import { createUnavailablePluginServices } from '@/plugins/runtime/invocation/services/unavailable';

import {
    executeExternalSessionCandidateQuery,
    hydrateExternalSessionCandidateThroughAgentSource,
} from '../candidateQuery';

const roots: string[] = [];
const unavailableManagedEndpointRead: AgentExternalSessionsManagedEndpointRead = async () => {
    throw new Error('unavailable');
};
const unavailableInvocationExec = createUnavailablePluginServices().exec;

describe('MEASURE candidate page operations', () => {
    afterEach(async () => {
        vi.unstubAllEnvs();
        await Promise.all(roots.splice(0).map(async (root) => {
            await rm(root, { recursive: true, force: true });
        }));
    });

    it('counts Agent operations for one 50-row complete-index page', async () => {
        const activeServerDir = await mkdtemp(join(tmpdir(), 'measure-server-'));
        const configDir = realpathSync(await mkdtemp(join(tmpdir(), 'measure-claude-')));
        roots.push(activeServerDir, configDir);
        const projectCount = 8;
        const perProject = 125;
        const baseSeconds = 1_700_000_000;
        for (let project = 0; project < projectCount; project += 1) {
            const projectDir = join(configDir, 'projects', `project-${String(project).padStart(2, '0')}`);
            await mkdir(projectDir, { recursive: true });
            for (let index = 0; index < perProject; index += 1) {
                const ordinal = (project * perProject) + index;
                const path = join(projectDir, `session-${String(ordinal).padStart(5, '0')}.jsonl`);
                await writeFile(
                    path,
                    `${JSON.stringify({ type: 'user', message: { role: 'user', content: `Session ${ordinal} first user message` } })}\n`,
                    'utf8',
                );
                await utimes(path, baseSeconds + ordinal, baseSeconds + ordinal);
            }
        }
        // A real ~/.claude carries history.jsonl, which the Claude title owner
        // scans backward for a custom/ai title before it touches the session
        // file. Omitting it makes every title read look free.
        await writeFile(
            join(configDir, 'history.jsonl'),
            `${Array.from({ length: 4_000 }, (_unused, entry) => JSON.stringify({
                display: `history prompt ${entry} ${'x'.repeat(120)}`,
                pastedContents: {},
                timestamp: (baseSeconds + entry) * 1000,
            })).join('\n')}\n`,
            'utf8',
        );
        vi.stubEnv('HAPPIER_CLAUDE_CONFIG_DIR', configDir);

        const activation = await createPluginTestkit({
            manifest: CLAUDE_PLUGIN_MANIFEST,
            module: { activate: activateClaudePlugin },
        });
        const contribution = activation.registration('agents', 'claude')?.externalSessions;
        await activation.dispose();
        if (!contribution) throw new Error('no contribution');
        const source = { kind: 'claudeConfig', configDir } as const;

        const counters = { listCandidates: 0, resolveLinkIdentity: 0 };
        const leafListCandidates = async (request: Readonly<{
            cursor?: string;
            limit: number;
            searchTerm?: string;
            searchMode?: 'fast' | 'full';
        }>) => {
            counters.listCandidates += 1;
            const result = await contribution.listCandidates({
                source,
                ...(request.cursor ? { cursor: request.cursor } : {}),
                ...(request.searchTerm ? { searchTerm: request.searchTerm } : {}),
                ...(request.searchMode ? { searchMode: request.searchMode } : {}),
                maxItems: request.limit,
                maxSerializedBytes: 1_048_576,
                signal: new AbortController().signal,
                deadlineAtMs: Date.now() + 15_000,
                managedEndpointRead: unavailableManagedEndpointRead,
                exec: unavailableInvocationExec,
            });
            if (!result.ok) {
                throw new ExternalSessionProviderFailureError({
                    code: result.code,
                    operation: 'listCandidates',
                    message: result.message ?? 'failed',
                    retryable: result.retryable ?? false,
                });
            }
            return result.value as ExternalSessionCandidatesPage;
        };
        const providerOps = {
            listCandidates: async (params: Readonly<{
                source: unknown;
                cursor?: string;
                limit: number;
                searchTerm?: string;
                searchMode?: 'fast' | 'full';
            }>) => await leafListCandidates(params),
            resolveLinkIdentity: async (params: Readonly<{
                remoteSessionId: string;
                source: unknown;
                metadata?: Record<string, unknown>;
            }>) => {
                counters.resolveLinkIdentity += 1;
                const result = await contribution.resolveLinkIdentity({
                    source,
                    remoteSessionId: params.remoteSessionId,
                    ...(params.metadata?.linkData === undefined
                        ? {}
                        : { linkData: params.metadata.linkData }),
                    signal: new AbortController().signal,
                    deadlineAtMs: Date.now() + 15_000,
                    maxSerializedBytes: 262_144,
                    managedEndpointRead: unavailableManagedEndpointRead,
                    exec: unavailableInvocationExec,
                } as never);
                if (!result.ok) throw new Error(`resolveLinkIdentity failed: ${result.code}`);
                return result.value;
            },
        };

        const query = (cursor?: string) => executeExternalSessionCandidateQuery({
            activeServerDir,
            agentIdentity: { pluginId: 'happier.claude', localId: 'claude' },
            source,
            ...(cursor ? { cursor } : {}),
            limit: 50,
            listCandidates: leafListCandidates,
            hydrateCandidate: async (candidate) => {
                try {
                    return await hydrateExternalSessionCandidateThroughAgentSource({
                        source: source as never,
                        candidate,
                        providerOps: providerOps as never,
                    });
                } catch (error) {
                    // eslint-disable-next-line no-console
                    console.log(`HYDRATE FAIL ${JSON.stringify(candidate)} -> ${String(error)}`);
                    throw error;
                }
            },
        });

        const buildStart = performance.now();
        let page: ExternalSessionCandidatesPage | null = null;
        let attempts = 0;
        while (attempts < 2000) {
            attempts += 1;
            const result = await query();
            if (!result.preparation) { page = result; break; }
        }
        const buildMs = performance.now() - buildStart;
        if (!page) throw new Error('index never completed');
        // eslint-disable-next-line no-console
        console.log(`BUILD: corpus=${projectCount * perProject} browseRequests=${attempts} listCandidatesCalls=${counters.listCandidates} wallMs=${buildMs.toFixed(0)}`);

        // Measure the request that actually SERVES a 50-row complete-index page.
        let serveCalls = 0;
        let served: ExternalSessionCandidatesPage | null = null;
        let serveOps = { listCandidates: 0, resolveLinkIdentity: 0 };
        let serveMs = 0;
        while (serveCalls < 200) {
            serveCalls += 1;
            counters.listCandidates = 0;
            counters.resolveLinkIdentity = 0;
            const start = performance.now();
            const result = await query();
            const elapsed = performance.now() - start;
            if (!result.preparation) {
                served = result;
                serveOps = { ...counters };
                serveMs = elapsed;
                break;
            }
            // eslint-disable-next-line no-console
            console.log(`  serve attempt ${serveCalls}: preparation scanned=${result.preparation.scanned} rows=${result.candidates.length} listCandidates=${counters.listCandidates}`);
        }
        if (!served) throw new Error('never served');
        // eslint-disable-next-line no-console
        console.log(`ROOT SERVE: rootRequestsUntilServe=${serveCalls} rows=${served.candidates.length} listCandidates=${serveOps.listCandidates} resolveLinkIdentity=${serveOps.resolveLinkIdentity} total=${serveOps.listCandidates + serveOps.resolveLinkIdentity} wallMs=${serveMs.toFixed(1)}`);
        // eslint-disable-next-line no-console
        console.log(`ROW SAMPLE: ${JSON.stringify(served.candidates[0])}`);

        const cursor = served.nextCursor;
        expect(cursor).toEqual(expect.any(String));
        counters.listCandidates = 0;
        counters.resolveLinkIdentity = 0;
        const contStart = performance.now();
        const continued = await query(cursor ?? undefined);
        const contMs = performance.now() - contStart;
        // eslint-disable-next-line no-console
        console.log(`CURSOR PAGE: rows=${continued.candidates.length} listCandidates=${counters.listCandidates} resolveLinkIdentity=${counters.resolveLinkIdentity} total=${counters.listCandidates + counters.resolveLinkIdentity} wallMs=${contMs.toFixed(1)}`);
        // eslint-disable-next-line no-console
        console.log(`CURSOR ROW SAMPLE: ${JSON.stringify(continued.candidates[0])}`);

        // A root request against the already-complete index: the brief's exact
        // unit, "one 50-row complete-index page". Every root request
        // revalidates the whole corpus, so report requests AND wall to a
        // paginatable (non-preparation) page, not just the first response.
        counters.listCandidates = 0;
        counters.resolveLinkIdentity = 0;
        const steadyStart = performance.now();
        let steadyRequests = 0;
        let steady: ExternalSessionCandidatesPage | null = null;
        let firstRowsMs = 0;
        let firstRows = 0;
        while (steadyRequests < 400) {
            steadyRequests += 1;
            const result = await query();
            if (steadyRequests === 1) {
                firstRowsMs = performance.now() - steadyStart;
                firstRows = result.candidates.length;
            }
            if (!result.preparation) { steady = result; break; }
        }
        const steadyMs = performance.now() - steadyStart;
        if (!steady) throw new Error('steady root never served');
        // eslint-disable-next-line no-console
        console.log(`STEADY ROOT PAGE: requests=${steadyRequests} rows=${steady.candidates.length} paginatable=${String(steady.nextCursor !== null)} listCandidates=${counters.listCandidates} resolveLinkIdentity=${counters.resolveLinkIdentity} total=${counters.listCandidates + counters.resolveLinkIdentity} wallMs=${steadyMs.toFixed(1)} firstResponseRows=${firstRows} firstResponseMs=${firstRowsMs.toFixed(1)}`);

        // The work the stored title removes, measured on this exact corpus:
        // drive the serve-time hydration path the untitled rows used to need.
        counters.listCandidates = 0;
        counters.resolveLinkIdentity = 0;
        const hydrateStart = performance.now();
        for (const row of continued.candidates) {
            await hydrateExternalSessionCandidateThroughAgentSource({
                source: source as never,
                candidate: {
                    remoteSessionId: row.remoteSessionId,
                    updatedAtMs: row.updatedAtMs,
                    ...(row.linkData === undefined ? {} : { linkData: row.linkData as never }),
                },
                providerOps: providerOps as never,
            });
        }
        const hydrateMs = performance.now() - hydrateStart;
        // eslint-disable-next-line no-console
        console.log(`REMOVED WORK (serve-time hydration of the same 50 rows): listCandidates=${counters.listCandidates} resolveLinkIdentity=${counters.resolveLinkIdentity} total=${counters.listCandidates + counters.resolveLinkIdentity} wallMs=${hydrateMs.toFixed(1)}`);
    }, 600_000);

    it('attributes the per-row title read to history.jsonl', async () => {
        const configDir = realpathSync(await mkdtemp(join(tmpdir(), 'measure-title-')));
        roots.push(configDir);
        const projectDir = join(configDir, 'projects', 'project-00');
        await mkdir(projectDir, { recursive: true });
        for (let index = 0; index < 200; index += 1) {
            const path = join(projectDir, `session-${String(index).padStart(5, '0')}.jsonl`);
            await writeFile(
                path,
                `${JSON.stringify({ type: 'user', message: { role: 'user', content: `Session ${index} first user message` } })}\n`,
                'utf8',
            );
            await utimes(path, 1_700_000_000 + index, 1_700_000_000 + index);
        }
        vi.stubEnv('HAPPIER_CLAUDE_CONFIG_DIR', configDir);
        const activation = await createPluginTestkit({
            manifest: CLAUDE_PLUGIN_MANIFEST,
            module: { activate: activateClaudePlugin },
        });
        const contribution = activation.registration('agents', 'claude')?.externalSessions;
        await activation.dispose();
        if (!contribution) throw new Error('no contribution');
        const source = { kind: 'claudeConfig', configDir } as const;

        // The whole 200-row corpus through the real crawl chunk, four chunks of 50.
        const crawl = async (label: string) => {
            const start = performance.now();
            let cursor: string | undefined;
            let rows = 0;
            let titled = 0;
            for (let chunk = 0; chunk < 4; chunk += 1) {
                const result = await contribution.listCandidates({
                    source,
                    ...(cursor ? { cursor } : {}),
                    maxItems: 50,
                    maxSerializedBytes: 1_048_576,
                    signal: new AbortController().signal,
                    deadlineAtMs: Date.now() + 60_000,
                    managedEndpointRead: unavailableManagedEndpointRead,
                    exec: unavailableInvocationExec,
                });
                if (!result.ok) throw new Error(`listCandidates failed: ${result.code}`);
                const page = result.value as ExternalSessionCandidatesPage;
                rows += page.candidates.length;
                titled += page.candidates.filter((row) => typeof row.title === 'string').length;
                if (!page.nextCursor) break;
                cursor = page.nextCursor;
            }
            const elapsed = performance.now() - start;
            // eslint-disable-next-line no-console
            console.log(`CRAWL ${label}: rows=${rows} titled=${titled} wallMs=${elapsed.toFixed(1)} perRowMs=${(elapsed / Math.max(1, rows)).toFixed(3)}`);
        };

        await crawl('no history.jsonl');
        const historyPath = join(configDir, 'history.jsonl');
        await writeFile(
            historyPath,
            `${Array.from({ length: 4_000 }, (_unused, entry) => JSON.stringify({
                display: `history prompt ${entry} ${'x'.repeat(120)}`,
                pastedContents: {},
                timestamp: 1_700_000_000_000 + entry,
            })).join('\n')}\n`,
            'utf8',
        );
        // eslint-disable-next-line no-console
        console.log(`HISTORY BYTES: ${(await stat(historyPath)).size}`);
        await crawl('with history.jsonl');
    }, 600_000);
});
