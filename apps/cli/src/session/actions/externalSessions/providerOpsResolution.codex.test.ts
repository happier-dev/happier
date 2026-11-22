import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { AccountProfileSchema } from '@happier-dev/protocol/account/profile';
import { ExternalSessionsSourceSchema } from '@happier-dev/protocol/sessions/external/daemonRpcV1';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { materializeConfiguredExternalSessionSourceCandidates } from '@/session/external/configuredSourceMaterializer';
import { resolveConnectedServiceMaterializedHomeRoot } from '@/daemon/connectedServices/catalogHooks';
import { resolveExternalSessionSourceSurface } from './providerOpsResolution';

describe('cold connected Codex source admission', () => {
    it('activates its declared native-home producer before admitting real profile sources', async () => {
        // Ordinary daemon startup is demand-only. An explicit pluginIds scope
        // preactivates that plugin and cannot expose this ordering failure.
        const runtime = await createAdmittedPluginRuntimeFixture({ controller: pluginReloadController });
        try {
            expect(runtime.registry.agentRuntimesByAgentId.has('codex')).toBe(false);
            const activeServerDir = join(runtime.happyHomeDir, 'active-server');
            const profile = AccountProfileSchema.parse({ id: 'source-account', connectedServicesV2: [{
                serviceId: 'openai-codex', profiles: ['7e9ced1f-60ac-4618-bcf0-31adc1c2e4aa', '97bd5614-8970-4068-87f2-1447de69d604']
                    .map(profileId => ({ profileId, status: 'connected', kind: 'oauth', providerEmail: null,
                        providerAccountId: null, expiresAt: null, lastUsedAt: null, health: null })), groups: [],
            }] });
            const candidates = materializeConfiguredExternalSessionSourceCandidates({
                agents: runtime.registry.contributes.agents, account: profile,
            }).filter(row => row.agentId === 'codex' && 'source' in row
                && ExternalSessionsSourceSchema.parse(row.source).home === 'connectedService');
            expect(candidates).toHaveLength(2);
            for (const candidate of candidates) {
                if (!('source' in candidate)) throw new Error('Expected a materialized source');
                const source = ExternalSessionsSourceSchema.parse(candidate.source);
                const result = await resolveExternalSessionSourceSurface(candidate.agentId, source, { activeServerDir });
                expect(result).toMatchObject({ ok: true, source });
                if (!result.ok) throw new Error(result.code);
                expect(ExternalSessionsSourceSchema.parse(result.source)).toEqual(result.source);
                const catalogEntry = await runtime.registry.acquireAgentCatalogEntry!('codex');
                if (!catalogEntry) throw new Error('Expected the acquired Codex catalog');
                expect(result.source.homePath).toBe(await resolveConnectedServiceMaterializedHomeRoot('codex', {
                    activeServerDir, serviceId: 'openai-codex', profileId: String(source.connectedServiceProfileId),
                }, catalogEntry));
                if (typeof result.source.homePath !== 'string') throw new Error('Expected a stamped home');
                // Model an existing connected home at the actual filesystem
                // boundary; absent homes have separate availability behavior.
                await mkdir(join(result.source.homePath, 'sessions'), { recursive: true });
                const validated = await result.providerOps.validateSource!({ source: result.source, env: process.env });
                expect(validated).toMatchObject({ ok: true, source: result.source });
            }
        } finally { await runtime.dispose(); }
    });
});
