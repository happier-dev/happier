import { DeploymentTargetLinkProviderContentV1ProtocolSchema } from '@happier-dev/protocol/plugins/contributions/deploymentTargetRolesV1';
import { DeploymentTargetRoleInputProtocolSchemasV1, DeploymentReceiptDetailV1Schema, DeploymentTargetRoleResultV1ProtocolSchema } from '@happier-dev/deployments/contracts/v1';
import { createDeploymentEnvironmentDetailV1, createDeploymentTargetLinkHeaderV1 } from '@happier-dev/deployments/testing/v1';
import { createDeploymentReceiptHeaderV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { AutomationEventSourceDefinitionV1Schema, AutomationEventAdmitInputV1Schema } from '@happier-dev/protocol/automations/automationActionSpecsV1';
import { normalizePluginManifestV2 } from '@/plugins/manifest/normalize';
import type { LoadedPlugin } from '@/plugins/discovery/load/installed';
import { projectLoadedPluginContributes } from '@/plugins/projection/registry/fullProjection';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { createPluginRuntimeOccurrenceId } from '@/plugins/runtime/runtimeSlots';
import { createPlainAccountArtifactHttpBoundary } from '@/api/artifacts/accountArtifactStore.testkit';
import { createPlatformFailureNotices } from './platformFailureNotices';
import { PLUGIN_MANIFEST } from '../../../../packages/plugins/machine-services/src/manifest';
import { DEPLOYMENT_RECEIPT_EVENT_REFS_V1 } from '@happier-dev/protocol/deployments/deploymentReceiptEventsV1';
import { AutomationTriggerIdSchema } from '@happier-dev/protocol/automations/automationTriggerIdentity';

export function createPlatformFailureNoticeFixture(_withEnrollment = false, withCreate = false, statusIntervalMs?: number) {
    const pluginId = 'example.deploy';
    const closed = { type: 'object', properties: {}, additionalProperties: false } as const;
    const roles = [...(['inspect', 'link', 'deploy', 'observe'] as const), ...(withCreate ? ['create' as const] : [])];
    const manifest = normalizePluginManifestV2({ schemaVersion: 2, id: pluginId, version: '1.0.0', displayName: 'External target',
        entrypoints: { daemon: './daemon.js' }, contributes: {
            actions: roles.map(id => ({ id, title: id, scopes: ['global'], surfaces: ['plugin'],
                execution: { target: 'daemon' }, inputSchema: DeploymentTargetRoleInputProtocolSchemasV1[id].jsonSchema,
                resultSchema: id === 'create' ? DeploymentTargetLinkProviderContentV1ProtocolSchema.jsonSchema : DeploymentTargetRoleResultV1ProtocolSchema.jsonSchema,
                dangerLevel: id === 'create' ? 'writesRemote' : id === 'inspect' || id === 'observe' ? 'safe' : 'writesLocal' })),
            deploymentTargets: [{ ...(statusIntervalMs === undefined ? {} : { statusIntervalMs }), id: 'platform', targetKind: 'example', title: 'External target', role: 'runtime', icon: 'server-outline',
                targetSchema: closed, linkSchema: closed,
                actions: { inspect: 'inspect', link: 'link', deploy: 'deploy', observe: 'observe', ...(withCreate ? { create: 'create' } : {}) } }],
        } });
    const loaded: LoadedPlugin = { pluginId, pluginRootPath: '/plugins/example', manifestPath: '/plugins/example/plugin.json',
        daemonEntryPath: '/plugins/example/daemon.js', devDaemonEntryPath: null,
        sourceSpec: { kind: 'package', locator: pluginId, trustPolicy: 'local_trusted', installPolicy: 'copy' }, manifest };
    const machineServices: LoadedPlugin = { ...loaded, pluginId: PLUGIN_MANIFEST.id, manifest: normalizePluginManifestV2(PLUGIN_MANIFEST) };
    const inputs = projectLoadedPluginContributes({ loadResult: { loadedPlugins: [loaded, machineServices], diagnosticsByPluginId: {} }, provenance: 'external' });
    const contributes = createResolvedContributionRegistry({ ...inputs, occurrenceIdsByPluginId: Object.fromEntries([pluginId, machineServices.pluginId].map(id => [id, createPluginRuntimeOccurrenceId(id)])) });
    const { credentials, rows, writes } = createPlainAccountArtifactHttpBoundary();
    const credentialPrincipal = { kind: 'account' as const, accountId: 'owner',
        purpose: { consumer: { pluginId, localId: 'selection' }, purpose: 'action-account' },
        target: { kind: 'account' as const, account: { service: { pluginId, localId: 'account' }, accountId: 'provider-account' } } };
    const baseline = createDeploymentEnvironmentDetailV1();
    let environment = createDeploymentEnvironmentDetailV1({ environment: { ...baseline.environment, controllerMachineId: 'controller', protection: 'production' },
        targetLinks: [{ targetLink: createDeploymentTargetLinkHeaderV1({ role: 'runtime', source: { kind: 'plugin', contribution: { pluginId, localId: 'platform' } },
            state: 'provisioned', targetKind: 'example', machines: [], members: [] }),
            content: { credentialPrincipal, providerIdentity: { providerAccountId: 'native-owner', providerResourceId: 'native-project', providerEnvironment: 'production' },
                providerEnvironment: { kind: 'production' } } }] });
    const caller = { pluginId: machineServices.pluginId, machineId: 'controller', materializationId: 'installed' };
    const definition = AutomationEventSourceDefinitionV1Schema.parse({ observationOnly: { kind: 'observationOnly' },
        automationId: '11111111-1111-4111-8111-111111111111', triggerId: 'failure', triggerRevision: 1,
        sourceSelectorId: '22222222-2222-4222-8222-222222222222', sourceInstanceId: 'platform:link', sourceContractVersion: 1,
        eventRef: DEPLOYMENT_RECEIPT_EVENT_REFS_V1.failed, sourceConfig: { v: 1, serverId: 'home', environmentId: environment.environment.id,
            targetLinkId: 'target-link', credentialPrincipal, periodMs: 300000, observingSince: 1 },
        observationTransport: { kind: 'checkpointedPull', watcherMaterializationRef: caller }, filter: null, maximumObservationAgeMs: null });
    const definitionFor = (state: 'failed' | 'succeeded') => ({ ...definition,
        triggerId: AutomationTriggerIdSchema.parse(state), sourceInstanceId: `platform:link:${state}`, eventRef: DEPLOYMENT_RECEIPT_EVENT_REFS_V1[state] });
    const receiptStates = new Map<string, 'failed' | 'succeeded'>();
    const observation = (state: 'failed' | 'succeeded', observedAtMs: number) => {
        receiptStates.set(`deployment-${observedAtMs}`, state);
        return AutomationEventAdmitInputV1Schema.parse({ eventRef: DEPLOYMENT_RECEIPT_EVENT_REFS_V1[state],
        occurrenceId: `${state}-${observedAtMs}`, occurredAt: observedAtMs, observationReceivedAt: observedAtMs,
        payload: { environmentId: environment.environment.id, targetLinkId: 'target-link', deploymentId: `deployment-${observedAtMs}`,
            receiptRevision: 1, operation: 'deploy', state, observedAt: observedAtMs,
            ...(state === 'failed' ? { phase: 'build', failureCode: 'build_failed' } : {}) },
        definitions: [{ automationId: definition.automationId, triggerId: definitionFor(state).triggerId, triggerRevision: definition.triggerRevision,
            sourceSelectorId: definition.sourceSelectorId }] });
    };
    const receipt = (deploymentId = 'deployment-100', state = receiptStates.get(deploymentId) ?? 'failed') => DeploymentReceiptDetailV1Schema.parse({
        deployment: createDeploymentReceiptHeaderV1({ id: deploymentId, state }),
        content: { sourceIntent: { kind: 'repository', projectSourceId: 'source-app', sourceRevision: 1, sha: 'a'.repeat(40) },
            sourceMethod: 'gitIntegration', machines: [], images: [], machineResults: [], steps: [],
            ...(state === 'failed' ? { failure: { code: 'build_failed', phase: 'build' } } : {}),
            platform: { ...environment.targetLinks[0]!.content, targetLinkRevision: 1,
                observation: { v: 1, state, observedAtMs: 100, providerDeploymentId: `provider-${deploymentId}`,
                    urls: ['https://provider.example/deployment'], steps: [{ id: 'build', label: 'Build', state, streamRef: 'provider-log' }] } } } });
    const host = { credentials, machineId: 'controller', serverId: 'home',
        readReceipt: async ({ deploymentId }: { deploymentId: string }) => receipt(deploymentId),
        serverHttpBaseUrl: 'https://platform-notices.test', readEnvironment: async () => environment,
        acquirePluginRuntimeRegistryLease: async () => ({ registry: { contributes }, release: async () => {} }) };
    const consume = createPlatformFailureNotices(host);
    return { consume: (event = observation('failed', 100)) => consume({ caller, definition: definitionFor(event.eventRef.localId === 'deployment-succeeded' ? 'succeeded' : 'failed'), observation: event, signal: new AbortController().signal }),
        host, caller, definition: definitionFor('failed'), definitionFor, observation, receipt, credentialPrincipal, rows, writes, changeEnvironment(change: (value: typeof environment) => typeof environment) { environment = change(environment); } };
}

