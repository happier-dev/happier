import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { resolveBuiltInContributions } from '@/plugins/projection/registry/resolveBuiltInContributions';
import { resolveExternalSessionSourceFromAgentProjection } from '@/plugins/projection/registry/externalSessionSources';

// A synthetic plain Account has no linked sessions. Only credential storage
// and Account HTTP are replaced; ingestion, admission and codecs stay real.
vi.mock('@/persistence', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/persistence')>(),
    readSettings: async () => ({ memory: { v: 1, enabledAtMs: 1 } }),
    readStoredCredentials: async () => ({ token: 'fixture-token', encryption: null }),
}));
vi.mock('@/api/client/connectedServiceCredentialApi', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/api/client/connectedServiceCredentialApi')>(),
    fetchAccountEncryptionCurrentness: async () => ({ mode: 'plain' as const }),
}));
vi.mock('@/session/transport/http/sessionsHttp', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/session/transport/http/sessionsHttp')>(),
    lookupSessionsByTags: async ({ tags }: { tags: readonly string[] }) => ({ state: 'available' as const, tags, sessions: [] }),
}));
vi.mock('node:fs', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:fs')>();
    const { createBundledPluginPublicationFsFixture } = await import('@/plugins/projection/registry/builtIn/locators.testkit');
    return createBundledPluginPublicationFsFixture(actual);
});

describe('bundled conversation content search', () => {
    it('publishes both source capabilities and admits a real bundled Claude content Action', async () => {
        const contributes = createResolvedContributionRegistry(resolveBuiltInContributions());
        for (const [agentId, source] of [
            ['claude', { kind: 'claudeConfig' }],
            ['codex', { kind: 'codexHome', home: 'user' }],
        ] as const) {
            const projected = resolveExternalSessionSourceFromAgentProjection(contributes, agentId, source);
            expect(projected).toMatchObject({ ok: true, declaration: { contentSearch: true } });
        }

        const { pluginReloadController } = await import('@/plugins/runtime/reload/singleton');
        const { resolveExecutablePluginRuntimeRegistry } = await import('@/plugins/runtime/resolveExecutablePluginRuntimeRegistry');
        const { executeExternalSessionCandidatesListAction } = await import('./discoveryLinkActions');

        const root = await mkdtemp(join(tmpdir(), 'bundled-content-action-'));
        const previousConfigDir = process.env.CLAUDE_CONFIG_DIR;
        let registry: Awaited<ReturnType<typeof resolveExecutablePluginRuntimeRegistry>> | null = null;
        let adopted = false;
        try {
            const configDir = join(root, 'claude');
            await mkdir(join(configDir, 'projects', 'project'), { recursive: true });
            await writeFile(join(configDir, 'projects', 'project', 'session.jsonl'), [
                { type: 'user', uuid: 'title', parentUuid: null, message: { role: 'user', content: 'Ordinary title' } },
                { type: 'assistant', uuid: 'body', parentUuid: 'title', message: { role: 'assistant', content: [{ type: 'text', text: 'bundled body-only needle' }] } },
            ].map((row) => JSON.stringify(row)).join('\n') + '\n');
            process.env.CLAUDE_CONFIG_DIR = configDir;
            registry = await resolveExecutablePluginRuntimeRegistry({
                happyHomeDir: join(root, 'happier'), contributes, pluginIds: ['happier.agent.claude'],
            });
            await pluginReloadController.adoptPreparedRuntimeRegistry({
                registry, changedPluginIds: ['happier.agent.claude'], durableRevision: 1,
                runningSessionDisposition: 'retainRunningSessions',
            });
            adopted = true;
            const result = await executeExternalSessionCandidatesListAction({
                machineId: 'fixture-machine', agentId: 'claude', source: { kind: 'claudeConfig', configDir, projectId: 'project' },
                searchTarget: 'content', searchTerm: 'bundled body-only needle', limit: 10,
            });
            expect(result).toMatchObject({ ok: true, contentCoverage: 'complete', candidates: [
                { remoteSessionId: 'session', match: { snippet: 'bundled body-only needle', messageIndex: 1 } },
            ] });
        } finally {
            if (adopted) await pluginReloadController.shutdown({ timeoutMs: 5_000 });
            else await registry?.dispose();
            if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
            else process.env.CLAUDE_CONFIG_DIR = previousConfigDir;
            await rm(root, { recursive: true, force: true });
        }
    });
});
