import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fastify from 'fastify';
import { expect, it } from 'vitest';

import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { PLUGIN_MANIFEST } from '../../../../../packages/plugins/triage/src/manifest';
import { registerAuthoredAccountActionRelease } from './accountPluginActions.testkit';
import { resolveExecutablePluginRuntimeRegistry } from './resolveExecutablePluginRuntimeRegistry';

it('publishes the real portable Triage source-links handler through Account artifact admission', async () => {
    const home = await mkdtemp(join(tmpdir(), 'triage-account-handler-'));
    const app = fastify();
    const projectRoot = join(import.meta.dirname, '../../../../../packages/plugins/triage');
    let restore: (() => void) | undefined;
    let runtime: Awaited<ReturnType<typeof resolveExecutablePluginRuntimeRegistry>> | undefined;
    try {
        await registerAuthoredAccountActionRelease(app, 'owner', { primary: {
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
        runtime = await resolveExecutablePluginRuntimeRegistry({ happyHomeDir: home,
            contributes: createResolvedContributionRegistry({}),
            accountExecution: {
                    credentials: { token: 'fixture', encryption: null },
                    serverUrl, isCurrent: () => true,
            },
        });
        const localId = 'sessions/read-source-links-v1';
        await runtime.activateContributionsOnDemand([{ pluginId: PLUGIN_MANIFEST.id, family: 'actions', localId }]);
        expect(runtime.targetActionInvocations?.has(PLUGIN_MANIFEST.id, localId)).toBe(true);
        expect(runtime.targetActivationFacts?.filter(fact => fact.pluginId === PLUGIN_MANIFEST.id))
            .toEqual([expect.objectContaining({ status: 'active', diagnostics: [],
                bound: expect.arrayContaining([expect.objectContaining({ family: 'actions', localId })]),
            })]);
    } finally {
        await runtime?.dispose();
        restore?.();
        await app.close();
        await rm(home, { recursive: true, force: true });
    }
});
