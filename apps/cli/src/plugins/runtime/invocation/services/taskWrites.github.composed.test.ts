import { expect, it } from 'vitest';
import type { PluginAccountApi } from '@happier-dev/plugin-sdk';
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import { projectAdmittedTargetedContributionSnapshot } from '@happier-dev/cli-common/plugins/registration';
import { TriageTaskWriteResultV1Schema } from '@happier-dev/triage-protocol/v1';
import { PLUGIN_MANIFEST as TRIAGE_MANIFEST, TRIAGE_PLUGIN } from '@happier-dev/plugins-triage/manifest';
import { PLUGIN_MANIFEST as GITHUB_MANIFEST } from '@happier-dev/plugins-scm-github';
import { createGithubTaskWriteTestkit } from '@happier-dev/plugins-scm-github/testkit';
import { createConfiguredTaskSourceStorage, TRIAGE_TASKS_EDIT_ACTION_LOCAL_ID_V1, TRIAGE_TASKS_TRANSITION_ACTION_LOCAL_ID_V1 } from '@happier-dev/plugins-triage/testkit';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { projectLoadedPluginContributes } from '@/plugins/projection/registry/fullProjection';
import { ingestCanonicalPluginManifest } from '@/plugins/manifest/ingest';
import type { LoadedPlugin } from '@/plugins/discovery/load/installed';
import type { PluginRuntimeOccurrenceId } from '@/plugins/runtime/runtimeSlots';
import { createTargetedContributionsService } from './targetedContributions';
import { createPluginInvocationActionsService } from './actions';
import { createPluginActionCallerMaterializationFixture } from './actionCaller.testkit';

function loadedPlugin(manifest: unknown, packageName: string): LoadedPlugin {
    const ingested = ingestCanonicalPluginManifest(manifest, {
        sourceProvenance: 'localSource', manifestAuthority: 'bundled_first_party', enforceEngineCompatibility: false,
    });
    if (!ingested.ok) throw new Error(ingested.diagnostics.map(item => item.code).join(', '));
    return {
        pluginId: ingested.manifest.id, pluginRootPath: packageName, manifestPath: `bundled:${ingested.manifest.id}`,
        daemonEntryPath: packageName, devDaemonEntryPath: null, manifest: ingested.manifest,
        sourceSpec: { kind: 'bundled', locator: packageName, trustPolicy: 'local_trusted', installPolicy: 'link', resolvedVersion: ingested.manifest.version },
    };
}

it.each(['refused', 'uncertain'] as const)('carries a real GitHub %s result through the admitted aggregate Task Action', async kind => {
    const source = await createGithubTaskWriteTestkit(kind);
    const loadedPlugins = [loadedPlugin(TRIAGE_MANIFEST, '@happier-dev/plugins-triage'), loadedPlugin(GITHUB_MANIFEST, '@happier-dev/plugins-scm-github')];
    const occurrence = (pluginId: string) => `${pluginId}-task-write` as PluginRuntimeOccurrenceId;
    const custody = (pluginId: string) => ({ kind: 'development' as const, registeredRootId: `test:${pluginId}` });
    const registry = createResolvedContributionRegistry({
        ...projectLoadedPluginContributes({ loadResult: { loadedPlugins, diagnosticsByPluginId: {} }, provenance: 'first_party' }),
        occurrenceIdsByPluginId: Object.fromEntries(loadedPlugins.map(plugin => [plugin.pluginId, occurrence(plugin.pluginId)])),
    });
    const lifetime = new AbortController();
    const targetedContributions = createTargetedContributionsService({
        subscribeToCatalogChanges: () => () => {},
        async readAdmittedSnapshot(params) {
            const snapshot = registry.readAdmittedTargetedContributions({ targetPluginId: params.pluginId, pointId: params.point.id, protocol: params.point.protocol });
            if (!snapshot) throw new Error('Expected the real admitted GitHub source');
            return projectAdmittedTargetedContributionSnapshot(params.point, snapshot, custody);
        },
    }).bind({ pluginId: TRIAGE_MANIFEST.id, signal: lifetime.signal, isCurrent: () => !lifetime.signal.aborted });
    const action = kind === 'refused' ? TRIAGE_TASKS_TRANSITION_ACTION_LOCAL_ID_V1 : TRIAGE_TASKS_EDIT_ACTION_LOCAL_ID_V1;
    const caller = createPluginActionCallerMaterializationFixture(TRIAGE_MANIFEST.id);
    const actions = createPluginInvocationActionsService({
        seed: { plugin: { id: TRIAGE_MANIFEST.id, version: TRIAGE_MANIFEST.version },
            contribution: { id: action, qualifiedId: `${TRIAGE_MANIFEST.id}/actions/${action}` },
            occurrenceId: occurrence(TRIAGE_MANIFEST.id), sourceCustody: custody(TRIAGE_MANIFEST.id), surface: 'ui',
            resolveCurrentPluginMaterializationRef: caller.resolveCurrentPluginMaterializationRef,
            signal: lifetime.signal, isOccurrenceCurrent: () => !lifetime.signal.aborted },
        actionExecutor: { execute: async () => { throw new Error('Unexpected native Action'); } },
        async invokeContributedAction(request) {
            if (request.input === undefined) throw new Error('Task operations require input');
            await request.beforeHandlerInvocation?.();
            return { status: 'executed', value: await source.plugin.invokeAction(request.action.localId, request.input, { surface: request.surface, signal: request.signal }) };
        },
    });
    const aggregate = await createPluginTestkit({ manifest: TRIAGE_MANIFEST, module: {
        ...TRIAGE_PLUGIN,
        activateAccount(api: PluginAccountApi) {
            TRIAGE_PLUGIN.activateAccount({ ...api, actions: { register(id, handler, options) {
                // Triage contributes to itself, so the SDK substitutes its structural
                // Action fixture. Bind the real host dispatcher to its real handlers.
                api.actions.register(id, (input, context) => handler(input, {
                    ...context, services: { ...context.services, actions },
                }), options);
            } } });
        },
    }, services: { storage: createConfiguredTaskSourceStorage(source.instance), targetedContributions, actions } });
    try {
        const address = { v: 1, sourceInstanceId: source.instance.instance.sourceInstanceId,
            entryRef: { source: source.source, ...source.localRef }, lastKnownLocator: source.locator };
        const result = TriageTaskWriteResultV1Schema.parse(await aggregate.invokeAction(action, kind === 'refused'
            ? { ...address, transitionId: 'not_planned', fieldValues: [] }
            : { ...address, fields: { title: 'Changed', labelIds: ['bug'] } }, { surface: 'ui' }));
        expect(result).toMatchObject(kind === 'refused' ? { kind: 'refused', reason: source.expectedCode }
            : { kind: 'uncertain', observation: { kind: 'present', snapshot: { title: 'Changed' } }, failure: { class: 'permission', code: source.expectedCode } });
        expect(source.readIssueReadCount()).toBeGreaterThan(0);
        expect(source.readWrites()).toEqual(kind === 'refused' ? []
            : [{ method: 'PATCH', body: { title: 'Changed' } }, { method: 'POST', body: { labels: ['bug'] } }]);
    } finally {
        lifetime.abort();
        await aggregate.dispose();
        await source.plugin.dispose();
    }
});
