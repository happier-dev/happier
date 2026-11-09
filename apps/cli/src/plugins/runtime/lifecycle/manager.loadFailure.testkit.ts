import { appendFile, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { PluginInstallationReviewCompatibilityDiagnosticSchema } from '@happier-dev/protocol/marketplace/internal';
import { PluginDevelopmentControlResultV1Schema } from '@happier-dev/protocol/capabilities';

import { ingestCanonicalPluginManifest } from '../../manifest/ingest';
import { createResolvedContributionRegistry } from '../../projection/registry/createResolvedContributionRegistry';
import { adaptTargetActivationFacts } from '../../projection/introspection/targetActivationFacts';
import { resolvePluginBackendSurfaceHandlers } from '@/agent/runtime/registry/resolvePluginBackendSurfaceHandlers';
import { createPluginTypeScriptCandidateScope, loadPluginModule, type PluginModuleNamespace } from '../loadPluginModule';
import { evaluatePluginAuthorRuntimeStagingSource } from '../../authoring/runtimeStagingSource';
import { createDaemonPluginChangeService } from '../../daemon/changeService';
import { describeUserPluginChangeFailure } from '../../daemon/changeClient';
import { createDaemonPluginDevelopmentRootsOwner } from '../../daemon/developmentRoots';
import { activatePluginRuntimeRegistry } from './manager';
import { mapDaemonModuleLoadErrorToDiagnostic } from './utils';

/** Current source composed in a real Node process, with real filesystem modules. */
export async function observeFailure(input: Readonly<{ root: string; entryPath: string; nativeEntryPath: string; name: string }>): Promise<Readonly<Record<string, unknown>>> {
    const { root, entryPath, nativeEntryPath, name } = input;
    const pluginId = 'acme.loaderreason';
    const manifest = {
        schemaVersion: 2, id: pluginId, version: '1.0.0', displayName: 'Loader fixture',
        engines: { happier: '^0.2.0' }, runtime: { apiVersion: 1 }, entrypoints: { daemon: './daemon.mjs' },
        contributes: { actions: [{ id: 'run', title: 'Run', scopes: ['global'], surfaces: ['cli'], execution: { target: 'daemon' }, placementBindings: ['primary'], dangerLevel: 'safe' }] },
    };
    const admitted = ingestCanonicalPluginManifest(manifest, { sourceProvenance: 'registryCustodied' });
    if (!admitted.ok) throw new Error(JSON.stringify(admitted.diagnostics));
    const contributes = createResolvedContributionRegistry({});
    const generationScope = name === 'TypeScript syntax error'
        ? await createPluginTypeScriptCandidateScope({ rootPath: root }) : undefined;
    const fileSource = { kind: 'file_backed' as const, entryPath: nativeEntryPath,
        ...(name === 'TypeScript syntax error' ? { devEntryPath: entryPath, useDevelopmentEntry: true } : {}),
        ...(generationScope ? { generationScope } : {}),
        committedAuthorization: { pluginId, immutableGenerationId: root } };
    const source = name === 'CommonJS missing module' ? {
        kind: 'bundled' as const, moduleId: root,
        load: () => {
            // Node's CommonJS loader is the genuine untyped module boundary.
            const exported: unknown = createRequire(import.meta.url)(entryPath);
            if (!exported || typeof exported !== 'object') throw new TypeError('Expected fixture module exports');
            return Promise.resolve(exported as PluginModuleNamespace);
        },
    } : fileSource;
    const registry = await activatePluginRuntimeRegistry({
        contributes: { ...contributes, activationTargets: [{
            pluginId, manifest: admitted.manifest, provenance: 'first_party', source: { kind: 'bundled' },
            manifestPath: join(root, 'plugin.json'), daemonEntryPath: entryPath, activationEvents: ['startup'],
            sourceSpec: { kind: 'package', locator: '@acme/loaderreason', trustPolicy: 'bundled_trusted', installPolicy: 'copy' },
        }] }, generation: 1, pluginIds: [pluginId], retryFailedPreparation: true,
        resolveActivationSource: () => name === 'preparation syntax error'
            ? { kind: 'bundled', moduleId: root, prepare: async () => {
                await appendFile(join(root, 'attempts'), 'x');
                await loadPluginModule({ source });
            }, load: async () => ({}) } : source,
    });
    try {
        const diagnostic = registry.pluginDiagnosticsByPluginId[pluginId]?.[0];
        const fact = registry.targetActivationFacts[0];
        if (!fact) throw new Error('Expected settled fixture activation');
        const snapshot = adaptTargetActivationFacts({ generation: 1,
            candidates: [{ pluginId, pluginVersion: fact.pluginVersion, source: fact.source, family: 'actions',
                identity: { kind: 'localId', localId: 'run' }, registration: 'required', consumer: 'action-dispatch', platforms: ['cli'] }],
            plugins: [{ pluginId, pluginVersion: fact.pluginVersion, source: fact.source }],
            targetActivationFacts: registry.targetActivationFacts, runtimeState: 'current',
        });
        const engine = await resolvePluginBackendSurfaceHandlers({
            backend: { id: 'fixture.backend', agentId: 'fixture', runtimeKind: 'acp', pluginId,
                provenance: 'external', source: { kind: 'path' }, definition: { kindVersion: 1, id: 'fixture.backend', agentId: 'fixture' } },
            agent: { id: 'fixture', provenance: 'external', source: { kind: 'path' }, definition: { kindVersion: 1, id: 'fixture', ownedBackendIds: ['fixture.backend'] } },
            runtimeRegistry: registry,
        });
        await registry.activateContributionsOnDemand([{ pluginId, family: 'actions', localId: 'run' }]);
        const attemptsAfterDemand = await readFile(join(root, 'attempts'), 'utf8').catch(() => undefined);
        const changes = createDaemonPluginChangeService({ prepare: async () => {
            await loadPluginModule({ source });
            throw new Error('Expected fixture load to fail');
        } });
        const changeResult = name === 'missing module'
            ? await changes.requestPluginChange({ kind: 'installPath', locator: root }) : undefined;
        const producerFailure = name === 'CommonJS missing module'
            ? await loadPluginModule({ source }).then(() => undefined, (error: unknown) => {
                if (!error || typeof error !== 'object') return undefined;
                return { code: 'code' in error ? error.code : undefined,
                    details: 'details' in error ? error.details : undefined };
            }) : undefined;
        let developmentControl;
        if (name === 'missing module') {
            const development = createDaemonPluginDevelopmentRootsOwner({
                happyHomeDir: join(root, 'home'),
                submitObservation: async () => await changes.requestPluginChange({ kind: 'installPath', locator: root }),
            });
            try {
                developmentControl = PluginDevelopmentControlResultV1Schema.parse(await development.control({
                    kind: 'registerExplicit', rootPath: entryPath,
                }));
            } finally {
                await development.stop();
            }
        }
        let stagingDiagnostic;
        if (name === 'activation throw') {
            const stagingEntry = join(root, 'staging.ts');
            await appendFile(stagingEntry, `\nexport const manifest = ${JSON.stringify(manifest)};`);
            const failure = await loadPluginModule({ source: { kind: 'bundled', moduleId: stagingEntry,
                load: async () => (await evaluatePluginAuthorRuntimeStagingSource({ locator: stagingEntry, rootPath: root })).evaluated.module,
            } }).then(() => undefined, (error: unknown) => error);
            stagingDiagnostic = mapDaemonModuleLoadErrorToDiagnostic(failure);
        }
        return {
            diagnostic, parsedDiagnostic: PluginInstallationReviewCompatibilityDiagnosticSchema.parse(diagnostic),
            publicDiagnostic: snapshot.diagnosticRecords.find((record) => record.data.code === diagnostic?.code),
            engineDiagnostic: engine.diagnostics[0], attemptsAfterDemand, stagingDiagnostic, changeResult, developmentControl, producerFailure,
            userFailure: changeResult?.kind === 'failed' ? describeUserPluginChangeFailure(changeResult) : undefined,
        };
    } finally {
        await registry.dispose();
    }
}
