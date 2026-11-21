import axios from 'axios';
import tweetnacl from 'tweetnacl';
import { afterEach, expect, it, vi } from 'vitest';

import { AutomationSourceSelectorIdV1Schema } from '@happier-dev/protocol/automations/automationEventJsonBoundsV1';
import { sealAutomationTriggerDefinitionStoredEnvelopeV1 } from '@happier-dev/protocol/automations/automationTriggerDefinitionStoredContent';
import { AutomationTriggerIdSchema } from '@happier-dev/protocol/automations/automationTriggerIdentity';
import { encodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { PLUGIN_MANIFEST } from '@happier-dev/plugins-machine-services';

import { configuration } from '@/configuration';
import * as installation from '@/daemon/identity/currentMachineInstallation';
import { loadInstalledPlugins } from '@/plugins/discovery/load/installed';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { projectLoadedPluginContributes } from '@/plugins/projection/registry/fullProjection';
import { createAuthoredAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';
import { createActionSettingsProvider } from '@/settings/actionsSettingsProvider';
import { createAccountEncryptionCurrentnessFixture } from '@/testkit/backends/sessionFixtures';
import { installAxiosRequestMethodAdapter } from '@/testkit/http/axiosAdapter';

afterEach(() => vi.restoreAllMocks());

it('replays saved Machine presence when composing an executable plugin registry', async () => {
    const pluginId = PLUGIN_MANIFEST.id;
    const event = PLUGIN_MANIFEST.contributes.events.find(event => event.id === 'machine-offline')!;
    const setupAction = PLUGIN_MANIFEST.contributes.actions.find(action => action.id === 'machine-offline/setup')!;
    const binding = {
        v: 1 as const,
        automationId: 'presence-workflow',
        triggerId: AutomationTriggerIdSchema.parse('11111111-1111-4111-8111-111111111111'),
        triggerRevision: 1,
        triggerKind: 'pluginEvent' as const,
        eventRef: { pluginId, localId: event.id },
        sourceSelectorId: AutomationSourceSelectorIdV1Schema.parse('c79a9957-537c-4f21-a08d-289245801c05'),
    };
    const keypair = tweetnacl.sign.keyPair();
    const machineId = 'observing-machine';
    const producerId = 'producer-machine';
    const token = 'presence-fixture-token';
    const serverId = configuration.activeServerId;
    vi.spyOn(installation, 'readCurrentMachineInstallation').mockResolvedValue({
        machineId,
        identity: { version: 1, installationId: 'installation', createdAt: 1,
            publicKey: encodeBase64(keypair.publicKey, 'base64url'), privateKey: encodeBase64(keypair.secretKey, 'base64url') },
    });
    const presenceReads: string[] = [];
    const homeRequests: string[] = [];
    installAxiosRequestMethodAdapter();
    vi.spyOn(axios, 'get').mockImplementation(async url => {
        const path = new URL(url).pathname;
        homeRequests.push(`GET ${path}`);
        if (path === `/v1/machines/${producerId}/presence`) {
            presenceReads.push(path);
            return { status: 200, data: { kind: 'present', machineId: producerId, transitions: null } };
        }
        if (path === '/v1/account/profile') return { status: 200, data: { id: 'presence-owner' } };
        return { status: 200, data: createAccountEncryptionCurrentnessFixture({ mode: 'plain' }) };
    });
    let materializationId: string | undefined;
    vi.spyOn(axios, 'post').mockImplementation(async url => {
        const path = new URL(url).pathname;
        homeRequests.push(`POST ${path}`);
        if (path.endsWith('/source-status/report')) return { status: 200, data: {} };
        return { status: 200, data: { kind: 'page', revision: '7',
            eventDeclarationRelease: { release: { pluginId, version: '1.0.0' }, archiveDigestSha256: `sha256:${'a'.repeat(64)}` },
            definitions: [{
                automationId: binding.automationId,
                triggerId: binding.triggerId,
                triggerRevision: binding.triggerRevision,
                eventRef: binding.eventRef,
                sourceSelectorId: binding.sourceSelectorId,
                sourceContractVersion: 1,
                observationTransport: { kind: 'checkpointedPull',
                    watcherMaterializationRef: { pluginId, machineId, materializationId } },
                payloadSchema: { type: 'object', additionalProperties: true },
                storedDefinitionEnvelope: sealAutomationTriggerDefinitionStoredEnvelopeV1({ mode: 'plain', binding,
                    definition: { v: 1, sourceInstanceId: 'presence-source', displayLabel: 'Producer', filter: null,
                        maximumObservationAgeMs: null,
                        sourceConfig: { v: 1, serverId, machineId: producerId, afterRevision: 1 } } }),
            }], nextCursor: null } };
    });

    const fixture = await createAuthoredAdmittedPluginRuntimeFixture({
        plugins: [{
            manifest: createPluginManifestV2Fixture({ id: pluginId, activation: { events: [{ kind: 'startup' }] },
                contributes: { events: [event], actions: [setupAction] } }),
            files: { 'daemon.mjs': `export function activate(api) {
                api.actions.register(${JSON.stringify(setupAction.id)}, () => null);
            }` },
        }],
        async resolveContributes(happyHomeDir) {
            const contributes = createResolvedContributionRegistry(projectLoadedPluginContributes({
                loadResult: await loadInstalledPlugins({ happyHomeDir }),
                provenance: 'external',
            }));
            materializationId = contributes.materializationIdsByPluginId?.[pluginId];
            expect(materializationId).toBeTypeOf('string');
            return contributes;
        },
        runtimeOptions: {
            resolveCurrentMachineId: () => machineId,
            scopedActionRuntime: { credentials: { token, encryption: null }, actionsSettingsProvider: createActionSettingsProvider() },
        },
    });
    try {
        expect(fixture.registry.targetActivationFacts).toContainEqual(expect.objectContaining({ pluginId, status: 'active' }));
        expect(fixture.registry.resolveCurrentPluginMaterializationRef?.(pluginId)).toEqual({ pluginId, machineId, materializationId });
        expect(presenceReads, JSON.stringify(homeRequests)).toEqual([`/v1/machines/${producerId}/presence`]);
    } finally {
        await fixture.dispose();
    }
});
