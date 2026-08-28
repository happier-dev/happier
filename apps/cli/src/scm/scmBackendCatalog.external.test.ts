import { describe, expect, it } from 'vitest';

import { readCurrentHostingProviderRuntimeServices as readCurrentScmHostingProviderRuntimeServices } from '@happier-dev/plugin-sdk/scm/hosting';
import type { PluginApi } from '@happier-dev/plugin-sdk';

import { ingestCanonicalPluginManifest } from '@/plugins/manifest/ingest';
import type { ResolvedContributionRegistry } from '@/plugins/projection/registry/types';
import { activatePluginRuntimeRegistry } from '@/plugins/runtime/lifecycle/manager';

import { resolveDefaultScmBackendRegistry } from './scmBackendCatalog';

describe('external SCM runtime consumer parity', () => {
    it('demands qualified backend and hosting-provider registrations before resolving and invoking the backend', async () => {
        const backendManifest = ingestCanonicalPluginManifest({
            schemaVersion: 2,
            id: 'acme.scm.backend',
            version: '1.0.0',
            displayName: 'Acme external SCM backend',
            engines: { happier: '^0.2.0' }, runtime: { apiVersion: 1 },
            entrypoints: { daemon: './daemon.mjs' },
            hostAccess: { required: [], optional: [] },
            contributes: {
                scmBackends: [{
                    id: 'shared',
                    title: 'Acme backend',
                    kind: 'acme',
                    capabilities: ['detect', 'status'],
                }],
            },
        }, { sourceProvenance: 'registryCustodied' });
        const hostingManifest = ingestCanonicalPluginManifest({
            schemaVersion: 2,
            id: 'acme.scm.hosting',
            version: '1.0.0',
            displayName: 'Acme external SCM hosting provider',
            engines: { happier: '^0.2.0' }, runtime: { apiVersion: 1 },
            entrypoints: { daemon: './daemon.mjs' },
            hostAccess: { required: [], optional: [] },
            contributes: {
                scmHostingProviders: [{
                    id: 'shared',
                    title: 'Acme forge',
                    kind: 'acme',
                    capabilities: ['detect'],
                }],
            },
        }, { sourceProvenance: 'registryCustodied' });
        if (!backendManifest.ok || !hostingManifest.ok) {
            const diagnostics = [
                ...(backendManifest.ok ? [] : backendManifest.diagnostics),
                ...(hostingManifest.ok ? [] : hostingManifest.diagnostics),
            ];
            throw new Error(diagnostics.map((diagnostic) => diagnostic.message).join('\n'));
        }

        const contributes = {
            agents: [], actions: [], resources: [],
            scmBackends: [{
                pluginId: 'acme.scm.backend',
                definition: backendManifest.manifest.contributes.scmBackends[0],
            }],
            scmHostingProviders: [{
                pluginId: 'acme.scm.hosting',
                definition: hostingManifest.manifest.contributes.scmHostingProviders[0],
            }],
            activationTargets: [{
                provenance: 'external',
                source: { kind: 'path' },
                pluginId: 'acme.scm.backend',
                manifestPath: '/virtual/acme-backend/.happier-plugin/plugin.json',
                daemonEntryPath: '/virtual/acme-backend/daemon.mjs',
                sourceSpec: {
                    kind: 'path', locator: '/virtual/acme-backend', trustPolicy: 'local_trusted', installPolicy: 'link',
                },
                activationEvents: [],
                manifest: backendManifest.manifest,
            }, {
                provenance: 'external',
                source: { kind: 'path' },
                pluginId: 'acme.scm.hosting',
                manifestPath: '/virtual/acme-hosting/.happier-plugin/plugin.json',
                daemonEntryPath: '/virtual/acme-hosting/daemon.mjs',
                sourceSpec: {
                    kind: 'path', locator: '/virtual/acme-hosting', trustPolicy: 'local_trusted', installPolicy: 'link',
                },
                activationEvents: [],
                manifest: hostingManifest.manifest,
            }],
            catalogEntriesById: Object.freeze({}),
            agentDefinitionsById: new Map(),             pluginDiagnosticsByPluginId: Object.freeze({}),
        } as unknown as ResolvedContributionRegistry;
        let detectedHostingProviderId: string | null = null;
        const resolveActivationSource = (target: Readonly<{ pluginId: string }>) => ({
            kind: 'bundled' as const,
            moduleId: target.pluginId,
            load: async () => ({
                activate(api: PluginApi) {
                    if (target.pluginId === 'acme.scm.backend') {
                        api.scm.registerBackend('shared', {
                            runtime: {
                                repoModes: ['.git'],
                                capabilities: {
                                    detection: { repository: { support: 'supported' } },
                                    read: { status: { support: 'supported' } },
                                    changeSet: { model: 'working-copy', diffAreas: ['pending'] },
                                    commit: {}, remote: {}, branch: {}, worktree: {}, lifecycle: {},
                                    hosting: {}, checkpoints: {}, workspaceIntegration: {}, tooling: {}, freshness: {},
                                },
                                commands: [],
                            },
                            handlers: {
                                detection: {
                                    detectRepo: async ({ cwd }) => ({ isRepo: true, rootPath: cwd, mode: '.git' }),
                                },
                                read: {
                                    statusSnapshot: async () => {
                                        const hostingRegistry = await readCurrentScmHostingProviderRuntimeServices()
                                            ?.resolveScmHostingProviderRegistry?.();
                                        const detection = hostingRegistry?.detectRemote({
                                            remoteName: 'origin',
                                            remoteUrl: 'https://forge.example/acme/repo',
                                        });
                                        detectedHostingProviderId = detection?.kind === 'resolved'
                                            ? detection.providerId
                                            : null;
                                        return { success: true };
                                    },
                                },
                            },
                        });
                        return;
                    }
                    api.scm.registerHostingProvider('shared', {
                        adapter: {
                            routing: {
                                detectRemote: () => ({
                                    id: 'shared',
                                    kind: 'acme',
                                    displayName: 'Acme forge',
                                    baseUrl: 'https://forge.example',
                                    repositoryWebUrl: 'https://forge.example/acme/repo',
                                }),
                                buildCompareUrl: () => null,
                            },
                        },
                    });
                },
            }),
        });
        const runtimeRegistry = await activatePluginRuntimeRegistry({
            contributes,
            generation: 17,
            resolveActivationSource,
        });
        let invokeRetainedStatus: (() => Promise<unknown>) | null = null;

        try {
            expect(runtimeRegistry.activatedPluginIds.has('acme.scm.backend')).toBe(false);
            expect(runtimeRegistry.activatedPluginIds.has('acme.scm.hosting')).toBe(false);
            const registry = await resolveDefaultScmBackendRegistry({
                pluginRuntimeRegistry: Object.assign(runtimeRegistry, { contributes }),
            });
            expect(runtimeRegistry.activatedPluginIds.has('acme.scm.backend')).toBe(true);
            expect(runtimeRegistry.activatedPluginIds.has('acme.scm.hosting')).toBe(true);
            expect(runtimeRegistry.scmHostingProvidersById.get('acme.scm.hosting/shared')).toEqual(expect.objectContaining({
                pluginId: 'acme.scm.hosting',
            }));

            const selected = await registry.selectBackend({
                cwd: '/workspace',
                workingDirectory: '/workspace',
                backendPreference: { kind: 'prefer', backendId: 'acme.scm.backend/shared' },
            });
            expect(selected?.backend.id).toBe('acme.scm.backend/shared');
            if (!selected?.backend.statusSnapshot) throw new Error('Expected the external status operation');
            invokeRetainedStatus = async () => await selected.backend.statusSnapshot!({
                context: {
                    cwd: '/workspace',
                    projectKey: 'shared:/workspace',
                    detection: { isRepo: true, rootPath: '/workspace', mode: '.git' },
                },
                request: { cwd: '/workspace' },
            });
            await expect(invokeRetainedStatus()).resolves.toEqual({ success: true });
            expect(detectedHostingProviderId).toBe('acme.scm.hosting/shared');
        } finally {
            await runtimeRegistry.dispose();
        }
        if (!invokeRetainedStatus) throw new Error('Expected a retained external status operation');
        await expect(invokeRetainedStatus()).rejects.toThrow(/no longer active/);

        const reloadedRuntimeRegistry = await activatePluginRuntimeRegistry({
            contributes,
            generation: 18,
            resolveActivationSource,
        });
        let invokeReloadedStatus: (() => Promise<unknown>) | null = null;
        try {
            const reloadedRegistry = await resolveDefaultScmBackendRegistry({
                pluginRuntimeRegistry: Object.assign(reloadedRuntimeRegistry, { contributes }),
            });
            const reloadedSelection = await reloadedRegistry.selectBackend({
                cwd: '/workspace',
                workingDirectory: '/workspace',
                backendPreference: { kind: 'prefer', backendId: 'acme.scm.backend/shared' },
            });
            if (!reloadedSelection?.backend.statusSnapshot) {
                throw new Error('Expected the reloaded external status operation');
            }
            invokeReloadedStatus = async () => await reloadedSelection.backend.statusSnapshot!({
                context: {
                    cwd: '/workspace',
                    projectKey: 'shared:/workspace',
                    detection: { isRepo: true, rootPath: '/workspace', mode: '.git' },
                },
                request: { cwd: '/workspace' },
            });
            await expect(invokeReloadedStatus()).resolves.toEqual({ success: true });
            expect(detectedHostingProviderId).toBe('acme.scm.hosting/shared');
        } finally {
            await reloadedRuntimeRegistry.dispose();
        }
        if (!invokeReloadedStatus) throw new Error('Expected a retained reloaded status operation');
        await expect(invokeReloadedStatus()).rejects.toThrow(/no longer active/);
    });
});
