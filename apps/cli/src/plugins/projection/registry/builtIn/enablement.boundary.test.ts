import fastify from 'fastify';
import axios from 'axios';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { normalizeActionExecutorThrownError } from '@happier-dev/protocol/actions/executor/resultProjection';
import { resolveSessionCreationAgentTarget } from '@/session/creation/resolveSessionCreationAgentTarget';
import { prepareRunnerAgentSessionBootstrapForLease } from '@/daemon/spawn/prepareAgentRuntimeSessionBridge';
import { logger } from '@/ui/logger';
import { projectPluginCatalogEntrySnapshot } from '@/plugins/projection/introspection/catalogSnapshot';
import { projectBundledPluginCatalogEntries } from '@/plugins/projection/catalog/installed';
import { PluginAvailabilityActionHttpPathsV1 } from '@happier-dev/protocol/plugins/availability';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import { seedCurrentLocalPathPluginFixture } from '@/plugins/store/registry/currentState.testkit';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';
import { resolvePluginContributes } from '../resolvePluginContributions';
import { resolveMergedContributionRegistry } from '../merged';
import { loadCurrentBundledPluginLocatorResult } from './locators';
import { getResolvedContributionRegistry, readCurrentBundledPluginEnablement } from './snapshot';
import { BUNDLED_FIRST_PARTY_PLUGIN_METADATA } from '../sources/generatedBundledPluginManifests';
import { readRequestedIntentPluginIds } from '@/testkit/http/accountPluginAvailability';

describe('bundled admission Account boundary', () => {
    it('withdraws an installed development replacement under the same bundled Account identity and restores it', async () => {
        const happyHomeDir = await mkdtemp(join(tmpdir(), 'bundled-replacement-intent-'));
        const pluginId = 'happier.app-context';
        const bundled = loadCurrentBundledPluginLocatorResult().loadedPlugins.find(plugin => plugin.pluginId === pluginId)!;
        const pluginRoot = join(happyHomeDir, 'replacement');
        const app = fastify();
        let enabled = false;
        let censusReads = 0;
        app.post(PluginAvailabilityActionHttpPathsV1['account.plugins.availability.intents.list'], async request => {
            censusReads++;
            const ids = readRequestedIntentPluginIds(request.body);
            return { availabilityCursor: 1, pluginIds: ids, failedPluginIds: [], intentReads: ids.map(id => ({ pluginId: id,
                response: { availabilityCursor: 1, hostingCapability: { enabled: false }, intent: id === pluginId ? {
                    pluginId, desiredVersion: null, enabled, offlineUiHosting: 'disabled', writableCollections: [], revision: '1',
                } : null, release: null, uiArtifacts: [], packageAssets: [] },
            })) };
        });
        await app.ready();
        const restore = installAxiosFastifyAdapter({ app, origin: 'http://bundled-replacement-intent.test' });
        try {
            const manifestPath = join(pluginRoot, '.happier-plugin', 'plugin.json');
            await mkdir(dirname(manifestPath), { recursive: true });
            await writeFile(manifestPath, JSON.stringify(bundled.manifest));
            if (bundled.manifest.entrypoints?.daemon) {
                const daemonPath = join(pluginRoot, bundled.manifest.entrypoints.daemon);
                await mkdir(dirname(daemonPath), { recursive: true });
                await writeFile(daemonPath, 'export function activate() {}');
            }
            await seedCurrentLocalPathPluginFixture({ happyHomeDir, pluginRoot, pluginId, manifestVersion: bundled.manifest.version });
            const admit = () => resolveMergedContributionRegistry({ happyHomeDir, accountStorageDependencies: {
                readCredentials: async () => ({ token: 'fixture', encryption: null }),
                resolveBaseUrl: () => 'http://bundled-replacement-intent.test',
            } });
            const disabled = await admit();
            expect(disabled.pluginDeclarations?.some(plugin => plugin.pluginId === pluginId)).toBe(false);
            expect(disabled.activationTargets.some(target => target.pluginId === pluginId)).toBe(false);
            expect(disabled.pluginEnablementById?.[pluginId]).toMatchObject({ accountEnabled: false, machineEnabled: true, enabled: false });
            enabled = true;
            const restored = await admit();
            expect(restored.pluginDeclarations?.find(plugin => plugin.pluginId === pluginId)?.sourceSpec.kind).toBe('path');
            expect(restored.pluginEnablementById?.[pluginId]).toMatchObject({ accountEnabled: true, machineEnabled: true, enabled: true });
            expect(censusReads).toBe(2);
        } finally {
            restore();
            await app.close();
            await rm(happyHomeDir, { recursive: true, force: true });
        }
    });

    it('keeps withdrawn bundled references unavailable when exact Agent discovery expands installed peers', async () => {
        const happyHomeDir = await mkdtemp(join(tmpdir(), 'bundled-reference-withdrawal-'));
        const pluginId = 'acme.account-consumer';
        const pluginRoot = join(happyHomeDir, 'consumer');
        const manifestPath = join(pluginRoot, '.happier-plugin', 'plugin.json');
        try {
            await mkdir(dirname(manifestPath), { recursive: true });
            await writeFile(manifestPath, JSON.stringify(createPluginManifestV2Fixture({
                id: pluginId, entrypoints: {},
                hostAccess: { required: [{ id: 'claude-account', capability: 'connectedAccounts', reason: 'Use an account',
                    scope: { serviceRefs: [{ pluginId: 'happier.agent.claude', localId: 'claude-subscription' }], operations: ['use'] },
                }], optional: [] }, contributes: {},
            })));
            await seedCurrentLocalPathPluginFixture({ happyHomeDir, pluginRoot, pluginId, manifestVersion: '1.0.0' });
            const projected = await resolvePluginContributes({ happyHomeDir,
                agentIdentity: { pluginId, localId: 'agent' },
                referenceGraph: { loadedPlugins: [], diagnosticsByPluginId: {} },
            });
            expect(projected.pluginDiagnosticsByPluginId?.[pluginId]).toEqual(expect.arrayContaining([
                expect.objectContaining({ code: 'plugin_manifest_invalid', stage: 'normalization' }),
            ]));
            expect(projected.activationTargets).toEqual([]);
        } finally {
            await rm(happyHomeDir, { recursive: true, force: true });
        }
    });

    it.each([
        { status: 503, code: 'database_connection_unavailable', ingress: 'creation' },
        { status: 429, code: 'usage_limit_exceeded', ingress: 'creation' },
        { status: 503, code: 'database_connection_unavailable', ingress: 'runner' },
        { status: 429, code: 'usage_limit_exceeded', ingress: 'runner' },
    ])(
      'carries $code through $ingress admission to the Action failure', async ({ status, code, ingress }) => {
        const app = fastify();
        app.post(PluginAvailabilityActionHttpPathsV1['account.plugins.availability.intents.list'], async (_request, reply) => (
            reply.code(status).send({ error: 'unavailable', errorCode: code,
                requestId: 'census-read-503' })
        ));
        await app.ready();
        const restore = installAxiosFastifyAdapter({ app, origin: 'http://bundled-intent-unavailable.test' });
        try {
            const facts = await readCurrentBundledPluginEnablement({ machineEnabledById: {},
                accountStorageDependencies: {
                    readCredentials: async () => ({ token: 'fixture', encryption: null }),
                    resolveBaseUrl: () => 'http://bundled-intent-unavailable.test',
                } });
            expect(facts['happier.agent.pi']).toMatchObject({ enabled: false, machineEnabled: true,
                unavailableCode: 'plugin_account_census_failed',
                unavailableCause: { phase: 'plugins.account_census', errorClass: 'AxiosError', errorCode: code, httpStatus: status },
                unavailableRequestId: 'census-read-503' });
            expect(facts['happier.agent.pi']?.accountEnabled).toBeUndefined();
            const registry = getResolvedContributionRegistry({ pluginEnablementById: facts });
            expect(registry.agents).toEqual([]);
            expect(registry.unavailableAgentPluginsByBackendId?.pi?.code).toBe('plugin_account_census_failed');
            const expected = { errorCode: 'plugin_account_census_failed', failureCause: {
                phase: 'plugins.account_census', errorClass: 'AxiosError', errorCode: code, httpStatus: status,
            } };
            if (ingress === 'creation') {
                let failure: unknown;
                try {
                    resolveSessionCreationAgentTarget({ kind: 'agent', identity: { pluginId: 'happier.agent.pi', localId: 'pi' } }, registry);
                } catch (error) { failure = error; }
                expect(normalizeActionExecutorThrownError(failure)).toMatchObject(expected);
            } else {
                // The runner bootstrap consumes the same admitted facts when reopening a Session.
                const lease = { registry: { contributes: registry } } as Parameters<typeof prepareRunnerAgentSessionBootstrapForLease>[0]['lease'];
                await expect(prepareRunnerAgentSessionBootstrapForLease({ target: { kind: 'backend', backendId: 'pi', sourceKind: 'built_in' }, lease })
                    .catch(error => normalizeActionExecutorThrownError(error))).resolves.toMatchObject(expected);
            }

        } finally {
            restore();
            await app.close();
        }
    });

    it('exposes a failed census cause for every bundled row and recovers on the next admission without retrying', async () => {
        const requestId = '0b54db2b-c37b-4cc0-9ad3-a8c54aab2616';
        const failure = Object.assign(new axios.AxiosError('private payload must not escape', 'ECONNRESET'), { requestId });
        const post = vi.spyOn(axios, 'post').mockRejectedValueOnce(failure).mockImplementation(async (_url, body) => {
            const pluginIds = readRequestedIntentPluginIds(body);
            return { data: { availabilityCursor: 1, pluginIds, failedPluginIds: [], intentReads: pluginIds.map(pluginId => ({ pluginId,
                response: { availabilityCursor: 1, hostingCapability: { enabled: false }, intent: null, release: null, uiArtifacts: [], packageAssets: [] },
            })) } };
        });
        const warn = vi.spyOn(logger, 'warn');
        const read = () => readCurrentBundledPluginEnablement({ machineEnabledById: {}, accountStorageDependencies: {
            readCredentials: async () => ({ token: 'fixture', encryption: null }), resolveBaseUrl: () => 'http://census.test',
        } });
        try {
            const failed = await read();
            const cause = { phase: 'plugins.account_census', errorClass: 'AxiosError', errorCode: 'ECONNRESET', httpStatus: null };
            expect(Object.keys(failed).length).toBeGreaterThanOrEqual(87);
            for (const fact of Object.values(failed)) expect(fact).toMatchObject({ enabled: false,
                unavailableCode: 'plugin_account_census_failed', unavailableCause: cause, unavailableRequestId: requestId });
            const rows = projectBundledPluginCatalogEntries({ ...loadCurrentBundledPluginLocatorResult({ pluginEnablementById: failed }),
                pluginEnablementById: failed, bundledPluginMetadata: BUNDLED_FIRST_PARTY_PLUGIN_METADATA });
            const row = projectPluginCatalogEntrySnapshot(rows.find(row => row.pluginId === 'happier.agent.pi')!);
            expect(row.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ data: expect.objectContaining({
                details: { reason: 'plugin_account_census_failed', failureCause: cause, requestId },
            }) })]));
            expect(warn).toHaveBeenCalledWith('[PLUGIN RUNTIME] Account plugin census failed', {
                failureCause: cause, requestId,
            });
            expect(JSON.stringify(failed)).not.toContain('private payload');
            expect(post).toHaveBeenCalledTimes(1);
            const recovered = await read();
            expect(Object.values(recovered).every(fact => fact.enabled && !fact.unavailableCode)).toBe(true);
            expect(post).toHaveBeenCalledTimes(2);
        } finally { post.mockRestore(); warn.mockRestore(); }
    });
});
