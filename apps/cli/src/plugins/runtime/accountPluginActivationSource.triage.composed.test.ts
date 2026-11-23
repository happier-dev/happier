import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fastify from 'fastify';
import { expect, it, vi } from 'vitest';
import * as ingestion from '@happier-dev/protocol/plugins/manifest/ingest';

import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import { getResolvedContributionRegistry } from '@/plugins/projection/registry/builtIn/snapshot';
import * as projection from '@/plugins/projection/registry/normalize/package';
import { PLUGIN_MANIFEST } from '../../../../../packages/plugins/triage/src/manifest';
import { registerAuthoredAccountActionRelease } from './accountPluginActions.testkit';
import { resolveExecutablePluginRuntimeRegistry, type ResolvedExecutablePluginRuntimeRegistry } from './resolveExecutablePluginRuntimeRegistry';

it('serves repeated portable Triage detail reads with one declaration projection per Account registry generation', async () => {
    const home = await mkdtemp(join(tmpdir(), 'triage-account-handler-'));
    const app = fastify();
    const projectRoot = join(import.meta.dirname, '../../../../../packages/plugins/triage');
    let restore: (() => void) | undefined;
    try {
        const release = await registerAuthoredAccountActionRelease(app, 'owner', { primary: {
            manifest: PLUGIN_MANIFEST, projectRoot,
            entryPath: join(projectRoot, 'src/accountRuntime.ts'),
            artifactId: 'triage-account-runtime', activateExport: 'activate', manifestExport: null,
        } });
        app.get('/v1/account/encryption/currentness', async () => ({ mode: 'plain', version: 1,
            signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 }));
        app.get('/v1/account/encryption', async () => ({ mode: 'plain', updatedAt: 1 }));
        await app.ready();
        const serverUrl = 'http://triage-account-handler.test';
        restore = installAxiosFastifyAdapter({ app, origin: serverUrl });
        // Use the whole serving host declaration set, including the bundled
        // task sources and connected-account providers in the Triage corridor.
        const contributes = getResolvedContributionRegistry();
        const projections = vi.spyOn(projection, 'buildPluginContributionRegistry');
        const strictIngress = vi.spyOn(ingestion, 'ingestPluginManifestV2');
        const localId = 'sessions/read-source-links-v1';
        const read = async (check: (runtime: ResolvedExecutablePluginRuntimeRegistry) => Promise<void>) => {
            const runtime = await resolveExecutablePluginRuntimeRegistry({ happyHomeDir: home, contributes,
                accountExecution: {
                    credentials: { token: 'fixture', encryption: null },
                    serverUrl, isCurrent: () => true,
                },
            });
            try { await check(runtime); } finally { await runtime.dispose(); }
        };
        try {
            const count = 4;
            const start = process.cpuUsage();
            for (let i = 0; i < count; i++) await read(async runtime => {
                await runtime.activateContributionsOnDemand([{ pluginId: PLUGIN_MANIFEST.id, family: 'actions', localId }]);
                expect(runtime.targetActionInvocations?.has(PLUGIN_MANIFEST.id, localId)).toBe(true);
                expect(runtime.targetActivationFacts?.filter(fact => fact.pluginId === PLUGIN_MANIFEST.id))
                    .toEqual([expect.objectContaining({ status: 'active', diagnostics: [],
                        bound: expect.arrayContaining([expect.objectContaining({ family: 'actions', localId })]),
                    })]);
            });
            const cpu = process.cpuUsage(start);
            const unchanged = { projections: projections.mock.calls.length, strictJson: strictIngress.mock.calls.length };
            release.setEnabled(false);
            await read(async runtime => {
                expect(runtime.readAccountExecutionSelection?.(PLUGIN_MANIFEST.id)).toEqual({ kind: 'unavailable', code: 'plugin_disabled' });
                expect(runtime.contributes.actions.some(action => action.pluginId === PLUGIN_MANIFEST.id)).toBe(false);
            });
            const changed = { projections: projections.mock.calls.length - unchanged.projections,
                strictJson: strictIngress.mock.calls.length - unchanged.strictJson };
            console.info('ACCOUNT_TRIAGE_DETAIL_COST', JSON.stringify({ count, unchanged, changed,
                cpuMsPerRead: (cpu.user + cpu.system) / count / 1000 }));
            expect(unchanged).toEqual({ projections: 1, strictJson: 0 });
            expect(changed).toEqual({ projections: 1, strictJson: 0 });
        } finally {
            projections.mockRestore();
            strictIngress.mockRestore();
        }
    } finally {
        restore?.();
        await app.close();
        await rm(home, { recursive: true, force: true });
    }
});
