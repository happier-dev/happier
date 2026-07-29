import { describe, expect, it } from 'vitest';

import { ingestCanonicalPluginManifest } from '@/plugins/manifest/ingest';

import { createContributionRegistrationHost } from '../../api/registrationRightsHost';
import { createProductionPluginInvocationServiceOwners } from '../../invocation/services/production';
import type { ActivationTarget } from '../activation/targets';
import { createTargetMcpDiscoveryProviders } from './targetMcp';

function target(): ActivationTarget {
    const ingested = ingestCanonicalPluginManifest({
        schemaVersion: 2,
        id: 'acme.target.mcp',
        version: '1.0.0',
        displayName: 'MCP target',
        engines: { happier: '^0.2.0' }, runtime: { apiVersion: 1 },
        entrypoints: { daemon: './daemon.mjs' },
        contributes: {
            mcp: {
                servers: [],
                discoveryProviders: [{
                    id: 'config',
                    title: 'Config discovery',
                    metadata: { agentId: 'codex' },
                }],
            },
        },
    });
    if (!ingested.ok) throw new Error(JSON.stringify(ingested.diagnostics));
    return {
        provenance: 'external',
        source: { kind: 'path' },
        pluginId: ingested.manifest.id,
        manifestPath: '/plugins/acme.target.mcp/plugin.json',
        manifestDigest: 'digest-mcp',
        daemonEntryPath: '/plugins/acme.target.mcp/daemon.mjs',
        devDaemonEntryPath: null,
        sourceSpec: {
            kind: 'path',
            locator: '/plugins/acme.target.mcp',
            trustPolicy: 'local_trusted',
            installPolicy: 'link',
        },
        manifest: ingested.manifest,
    };
}

describe('target MCP discovery providers', () => {
    it('binds invocation services through the production lifecycle owner', async () => {
        const activationTarget = target();
        const records: unknown[] = [];
        const invocationServices = createProductionPluginInvocationServiceOwners({
            loggerSink: { write: (record) => { records.push(record); } },
        });
        const host = createContributionRegistrationHost({
            pluginId: activationTarget.pluginId,
            generation: '7',
            rights: [{ family: 'mcp.discoveryProviders', localId: 'config' }],
            isGenerationCurrent: () => true,
        });
        const leafWarning = {
            provider: 'acme-untrusted-self-identity',
            code: 'parse_failed' as const,
            path: '/workspace/.acme-mcp.json',
        };
        host.api.mcp.registerDiscoveryProvider('config', async (_request, context) => {
            expect(context.services.availability('logger')).toEqual({ status: 'available' });
            context.services.logger.info('MCP discovery invoked');
            return { items: [], servers: [], warnings: [leafWarning] };
        });
        const providerParams = {
            generation: 7,
            activationTargets: [activationTarget],
            targetRegistrations: host.commit().map((registration) => ({
                pluginId: activationTarget.pluginId,
                generation: '7',
                registration,
            })),
            isGenerationActive: () => true,
            invocationServices,
        };

        try {
            const providers = createTargetMcpDiscoveryProviders(providerParams);
            await expect(providers[0]?.registration.discover({
                sessionId: 'session-1',
                directory: '/workspace',
            })).resolves.toEqual({
                servers: [],
                warnings: [{
                    provider: 'codex',
                    code: 'parse_failed',
                    path: '/workspace/.acme-mcp.json',
                }],
            });
            expect(records).toHaveLength(1);
        } finally {
            await invocationServices.dispose();
        }
    });

    it('rejects a discovery result that settles after its generation retires', async () => {
        const activationTarget = target();
        let active = true;
        let resolveDiscovery!: () => void;
        const discoverySettled = new Promise<void>((resolve) => {
            resolveDiscovery = resolve;
        });
        const host = createContributionRegistrationHost({
            pluginId: activationTarget.pluginId,
            generation: '7',
            rights: [{ family: 'mcp.discoveryProviders', localId: 'config' }],
            isGenerationCurrent: () => active,
        });
        host.api.mcp.registerDiscoveryProvider('config', async () => {
            await discoverySettled;
            return { items: [], servers: [] };
        });
        const providers = createTargetMcpDiscoveryProviders({
            generation: 7,
            activationTargets: [activationTarget],
            targetRegistrations: host.commit().map((registration) => ({
                pluginId: activationTarget.pluginId,
                generation: '7',
                registration,
            })),
            isGenerationActive: () => active,
        });

        const pending = providers[0]!.registration.discover();
        active = false;
        resolveDiscovery();

        await expect(pending).rejects.toThrow(/no longer active/);
    });
});
