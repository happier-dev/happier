import { describe, expect, it } from 'vitest';
import fastify from 'fastify';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AuthTokenProvenanceSchema } from '@happier-dev/protocol/auth/authToken';

import { reloadConfiguration } from '@/configuration';
import { writeCredentialsTokenOnly, readStoredCredentials } from '@/persistence';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { seedCurrentLocalPathPluginFixture } from '@/plugins/store/registry/currentState.testkit';
import { createAccountEncryptionCurrentnessFixture, createSessionListResponseFixture } from '@/testkit/backends/sessionFixtures';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import { withTempDir } from '@/testkit/fs/tempDir';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { executeExternalSessionCandidatesListAction as list } from './discoveryLinkActions';

/** A physical external Agent, admitted through the real durable plugin store. */
async function writeAnnotationAgentFixture(pluginRoot: string): Promise<void> {
    const manifest = {
        schemaVersion: 2, id: 'acme.annotation-fixture', version: '1.0.0',
        displayName: 'Annotation fixture', engines: { happier: '^0.2.0' },
        runtime: { apiVersion: 1 }, entrypoints: { daemon: './daemon.mjs' },
        hostAccess: { required: [], optional: [] },
        contributes: { agents: [{
            id: 'annotation', title: 'Annotation fixture Agent', runtime: { kind: 'custom' },
            primary: 'sessions', capabilities: {
                surfaces: ['externalSessions'],
                sessions: { open: ['create'], delivery: ['newTurn'], cancel: true },
            },
            surfaces: { externalSession: {
                externalLinkedTakeover: { writerSafety: 'unsupported' },
                sources: [{ sourceKind: 'annotationCorpus',
                    schema: { fields: [{ kind: 'literal', name: 'kind', value: 'annotationCorpus' }] },
                    key: { segments: [{ kind: 'literal', value: 'annotationCorpus' }] },
                    instances: [{ kind: 'default', constants: {} }],
                }],
            } },
        }] },
    };
    await mkdir(join(pluginRoot, '.happier-plugin'), { recursive: true });
    await writeFile(join(pluginRoot, '.happier-plugin', 'plugin.json'), JSON.stringify(manifest), 'utf8');
    await writeFile(join(pluginRoot, 'corpus.json'), JSON.stringify([
        { remoteSessionId: 'oldest', updatedAtMs: 10, linkData: { projectId: 'project-a' } },
        { remoteSessionId: 'middle', updatedAtMs: 20, linkData: { projectId: 'project-a' } },
        { remoteSessionId: 'newest', updatedAtMs: 30, linkData: { projectId: 'project-a' } },
    ]), 'utf8');
    await writeFile(join(pluginRoot, 'agent.mjs'), `
import { readFile } from 'node:fs/promises';
export const runtimeFactory = () => ({
    sessions: { async open(request) { return {
        sessionId: request.sessionId, async send() { return { status: 'admitted' }; },
        watch() { return { dispose() {} }; }, async dispose() {},
    }; } }, async dispose() {},
});
export const externalSessions = {
    async resolveSource(request) { return { ok: true, value: { source: request.source } }; },
    async listCandidates(request) {
        const corpus = JSON.parse(await readFile(new URL('./corpus.json', import.meta.url), 'utf8'));
        if (request.searchTerm) {
            const match = corpus.find(row => row.remoteSessionId === request.searchTerm);
            return { ok: true, value: { candidates: match
                ? [{ ...match, title: 'Title ' + match.remoteSessionId }] : [], nextCursor: null } };
        }
        // This native source prepares two pages. The host owns their indexed
        // generation, continuity and completed-page hydration.
        return { ok: true, value: request.cursor
            ? { candidates: corpus.slice(2), nextCursor: null,
                preparation: { kind: 'building_candidate_index', scanned: 3, total: 3 } }
            : { candidates: corpus.slice(0, 2), nextCursor: 'native-page-2',
                preparation: { kind: 'building_candidate_index', scanned: 2, total: 3 } } };
    },
    async resolveLinkIdentity(request) { return { ok: true, value: {
        remoteSessionId: request.remoteSessionId, source: request.source, linkData: request.linkData ?? {},
    } }; },
    async resolveLinkedIdentity(request) { return { ok: true, value: {
        remoteSessionId: request.remoteSessionId, source: request.source, linkData: request.linkData,
    } }; },
    async pageTranscript() { return { ok: true, value: {
        items: [], nextCursor: null, tailCursor: null, hasMore: false, truncated: false,
    } }; },
    async readAfterTranscript() { return { ok: true, value: { outcome: 'already_current' } }; },
};
`, 'utf8');
    await writeFile(join(pluginRoot, 'daemon.mjs'), `
import { runtimeFactory, externalSessions } from './agent.mjs';
export function activate(api) {
    api.agents.register('annotation', runtimeFactory, { sessionRunnerFactory: {
        module: './agent.mjs', export: 'runtimeFactory', externalSessionsExport: 'externalSessions', runtimeApiVersion: 1,
    } });
    api.agents.registerExternalSessions('annotation', externalSessions);
}
`, 'utf8');
}

describe('external Session candidate annotation through admitted source custody', () => {
    it('annotates a complete candidate generation but never a partial preparation page', async () => {
        await withTempDir('happier-annotation-composed-', async (fixtureRoot) => {
            const homeDir = join(fixtureRoot, 'home');
            const pluginRoot = join(fixtureRoot, 'authored-agent');
            const origin = 'https://annotation-home.example.test';
            const env = createEnvKeyScope(['HAPPIER_HOME_DIR', 'HAPPIER_SERVER_URL', 'HAPPIER_WEBAPP_URL', 'HAPPIER_TOKEN']);
            env.patch({ HAPPIER_HOME_DIR: homeDir, HAPPIER_SERVER_URL: origin,
                HAPPIER_WEBAPP_URL: origin, HAPPIER_TOKEN: undefined });
            let restoreConfiguration: (() => void) | undefined;
            try {
                restoreConfiguration = reloadConfiguration;
                reloadConfiguration();
                const app = fastify();
                let restoreHttp: (() => void) | undefined;
                let admittedRuntime: Awaited<ReturnType<typeof createAdmittedPluginRuntimeFixture>> | undefined;
                try {
                    const token = `e30.${Buffer.from(JSON.stringify({ sub: 'account-annotation', session: 'terminal-annotation',
                        provenance: AuthTokenProvenanceSchema.parse({ v: 1, kind: 'terminal', authority: 'account_automation' }),
                    })).toString('base64url')}.fixture-signature`;
                    await writeCredentialsTokenOnly({ token });
                    expect(await readStoredCredentials()).toMatchObject({ token, encryption: null });
                    const requests: string[] = [];
                    app.addHook('onRequest', async (request) => {
                        expect(request.headers.authorization).toBe(`Bearer ${token}`);
                        requests.push(request.url);
                    });
                    app.get('/v1/account/encryption/currentness', async () => createAccountEncryptionCurrentnessFixture());
                    for (const path of ['/v2/sessions', '/v2/sessions/archived']) {
                        app.get(path, async () => createSessionListResponseFixture([]));
                    }
                    // Fastify's genuine missing-route 404 makes the real tag owner
                    // select its released bounded-page compatibility path.
                    await app.ready();
                    restoreHttp = installAxiosFastifyAdapter({ app, origin });
                    await writeAnnotationAgentFixture(pluginRoot);
                    await seedCurrentLocalPathPluginFixture({ happyHomeDir: homeDir, pluginRoot,
                        pluginId: 'acme.annotation-fixture', manifestVersion: '1.0.0' });
                    admittedRuntime = await createAdmittedPluginRuntimeFixture({
                        happyHomeDir: homeDir, controller: pluginReloadController,
                        runtimeOptions: { pluginIds: ['acme.annotation-fixture'] },
                    });
                    const runtimeLease = admittedRuntime.lease;
                    await expect(runtimeLease.registry.activateContributionsOnDemand([
                        { pluginId: 'acme.annotation-fixture', family: 'agents', localId: 'annotation' },
                    ])).resolves.toEqual([expect.objectContaining({ pluginId: 'acme.annotation-fixture', diagnostics: [] })]);
                    requests.length = 0;
                    const request = { machineId: 'machine-1', agentId: 'acme.annotation-fixture/annotation',
                        source: { kind: 'annotationCorpus' }, limit: 2 } as const;
                    await expect(list(request)).resolves.toMatchObject({
                        ok: true, candidates: [], preparation: { kind: 'building_candidate_index' },
                    });
                    expect(await list(request)).toMatchObject({
                        ok: true, candidates: [{ remoteSessionId: 'newest' }, { remoteSessionId: 'middle' }],
                        preparation: { kind: 'building_candidate_index' }, annotationsIncomplete: true,
                    });
                    expect(requests).toEqual([]);
                    const complete = await list(request);
                    expect(complete).not.toHaveProperty('preparation');
                    expect(complete).toMatchObject({ ok: true,
                        candidates: [{ remoteSessionId: 'newest', title: 'Title newest' },
                            { remoteSessionId: 'middle', title: 'Title middle' }],
                    });
                    expect(requests.filter(path => path === '/v1/account/encryption/currentness')).toHaveLength(1);
                    expect(requests).toContain('/v2/sessions?limit=200');
                    expect(requests).toContain('/v2/sessions/archived?limit=200');
                } finally {
                    await admittedRuntime?.dispose();
                    restoreHttp?.();
                    await app.close();
                }
            } finally {
                env.restore();
                restoreConfiguration?.();
            }
        });
    });
});
