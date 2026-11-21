import { afterEach, expect, it, vi } from 'vitest';
import axios from 'axios';
import tweetnacl from 'tweetnacl';
import { encodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { sealAutomationTriggerDefinitionStoredEnvelopeV1 } from '@happier-dev/protocol/automations/automationTriggerDefinitionStoredContent';
import { AutomationTriggerIdSchema } from '@happier-dev/protocol/automations/automationTriggerIdentity';
import { AutomationSourceSelectorIdV1Schema } from '@happier-dev/protocol/automations/automationEventJsonBoundsV1';
import { PLUGIN_MANIFEST } from '@happier-dev/plugins-machine-services';
import { ingestCanonicalPluginManifest } from '@/plugins/manifest/ingest';
import { createAccountEncryptionCurrentnessFixture } from '@/testkit/backends/sessionFixtures';
import * as installation from '@/daemon/identity/currentMachineInstallation';
import { assembleAutomationRuntime } from './automationAssembly';

afterEach(() => vi.restoreAllMocks());

it('observes native presence and recovers retained facts at adoption and reconnect without replacing occurrence history', async () => {
    const admitted = ingestCanonicalPluginManifest(PLUGIN_MANIFEST, {
        manifestAuthority: 'bundled_first_party', sourceProvenance: 'registryCustodied',
    });
    if (!admitted.ok) throw new Error(JSON.stringify(admitted.diagnostics));
    const pluginId = admitted.manifest.id;
    const caller = { pluginId, machineId: 'observer', materializationId: 'services' };
    const keys = tweetnacl.sign.keyPair();
    // The local installation adapter and Home HTTP are the only boundaries
    // replaced. Definition adoption, custody, signing and Action dispatch stay real.
    vi.spyOn(installation, 'readCurrentMachineInstallation').mockResolvedValue({ machineId: caller.machineId,
        identity: { version: 1, installationId: 'installation', createdAt: 1,
            publicKey: encodeBase64(keys.publicKey, 'base64url'), privateKey: encodeBase64(keys.secretKey, 'base64url') } });
    vi.spyOn(axios, 'get').mockImplementation(async url => ({ status: 200,
        data: String(url).endsWith('/v1/account/profile') ? { id: 'presence-owner' }
            : createAccountEncryptionCurrentnessFixture({ mode: 'plain' }) }));
    const binding = { v: 1 as const, automationId: 'presence', triggerId: AutomationTriggerIdSchema.parse('11111111-1111-4111-8111-111111111111'),
        triggerRevision: 1, triggerKind: 'pluginEvent' as const, eventRef: { pluginId, localId: 'machine-offline' },
        sourceSelectorId: AutomationSourceSelectorIdV1Schema.parse('c79a9957-537c-4f21-a08d-289245801c05') };
    const definition = { automationId: binding.automationId, triggerId: binding.triggerId,
        triggerRevision: binding.triggerRevision, eventRef: binding.eventRef, sourceSelectorId: binding.sourceSelectorId,
        sourceContractVersion: 1, observationTransport: { kind: 'checkpointedPull', watcherMaterializationRef: caller },
        payloadSchema: { type: 'object', additionalProperties: true },
        storedDefinitionEnvelope: sealAutomationTriggerDefinitionStoredEnvelopeV1({ mode: 'plain', binding,
            definition: { v: 1, sourceInstanceId: 'presence-source', sourceConfig: { v: 1, serverId: 'home', machineId: 'producer', afterRevision: 1 },
                displayLabel: 'Producer', filter: null, maximumObservationAgeMs: null } }) };
    let catalogReads = 0;
    const reports: unknown[] = [];
    const admissions: unknown[] = [];
    let presenceRevision = 1;
    vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
        if (String(url).endsWith('/source-status/report')) {
            reports.push(body);
            return { status: 200, data: {} };
        }
        if (String(url).endsWith('/events/admit')) {
            admissions.push(body);
            return { status: 200, data: { results: [{ kind: 'admitted', runId: 'presence-run', checkpointSafe: true }],
                continuation: { kind: 'ready', accountCurrentness: { mode: 'plain', version: 0, contentKeyFingerprint: null } } } };
        }
        catalogReads++;
        return { status: 200, data: { kind: 'page', revision: '7',
            eventDeclarationRelease: { release: { pluginId, version: '1.0.0' }, archiveDigestSha256: `sha256:${'a'.repeat(64)}` },
            definitions: [definition], nextCursor: null } };
    });
    const assemble = () => assembleAutomationRuntime({ credentials: { token: 'token', encryption: null },
        readNativePresence: async () => ({ kind: 'present', machineId: 'producer', transitions: null,
            occurrences: [{ v: 1, serverId: 'home', machineId: 'producer', transition: 'offline',
                revision: presenceRevision, occurredAt: 1, definitions: [{ automationId: binding.automationId,
                    triggerId: binding.triggerId, triggerRevision: binding.triggerRevision, sourceSelectorId: binding.sourceSelectorId }] }] }),
        activationTargets: [{ provenance: 'first_party', source: { kind: 'bundled' }, pluginId,
            manifestPath: '/virtual/services/plugin.json', daemonEntryPath: '/virtual/services/daemon.js',
            sourceSpec: { kind: 'package', locator: '@happier-dev/plugins-machine-services', trustPolicy: 'local_trusted', installPolicy: 'copy' },
            activationEvents: [], manifest: admitted.manifest }],
        activatedPluginIds: new Set([pluginId]), resolveCurrentMaterialization: () => caller,
        readPluginOccurrenceId: () => 'occurrence',
        readPluginSourceCustody: () => ({ kind: 'managed', immutableGenerationId: 'generation', installSource: 'archive' }),
        resolveConsumerLifecycle: () => ({ isCurrent: () => true, retirementSignal: new AbortController().signal }),
        revalidateCallerMaterialization: async () => true, revalidateCallerOccurrence: async () => true,
    });
    const assembly = assemble();
    await assembly.refreshActivatedPlugin();
    const expected = { input: { kind: 'source', automationId: binding.automationId, triggerId: binding.triggerId,
        triggerRevision: binding.triggerRevision, eventRef: binding.eventRef, sourceSelectorId: binding.sourceSelectorId,
        state: 'observing', code: 'none', nextRetryAt: null, observedDelta: 0, admittedDelta: 0, skippedDelta: 0 } };
    expect(reports).toEqual([expect.objectContaining(expected)]);
    expect(reports[0]).not.toHaveProperty('input.lastObservedAt');
    expect(reports[0]).not.toHaveProperty('input.lastDispositionAt');
    const readsBeforeFact = catalogReads;
    await assembly.admitMachinePresenceOccurrences([]);
    expect(catalogReads).toBe(readsBeforeFact);
    assembly.invalidateSourceDefinitions();
    await assembly.refreshSourceDefinitions();
    expect(reports).toEqual([expect.objectContaining(expected), expect.objectContaining(expected)]);
    await assembly.replayMachinePresence();
    expect(admissions).toEqual([]);
    presenceRevision = 2;
    await assembly.replayMachinePresence();
    expect(admissions).toHaveLength(1);
    // A restarted owner adopts the existing definition after the producer's
    // offline transition. Recovery must not wait for another invalidation.
    await assemble().refreshActivatedPlugin();
    expect(admissions).toHaveLength(2);
});
