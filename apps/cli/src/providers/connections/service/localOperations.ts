import {
  ProviderConnectionV1Schema,
  ProviderSettingsV1Schema,
  areProviderContributionKeysEqualV1,
  createProviderDiscoveryCandidateIdV1,
  createProviderErrorV1,
  type ProviderConnectionV1,
} from '@happier-dev/protocol';

import { buildProviderDiscoveryEndpointOverrides } from '@/providers/discovery/bridge';
import {
  normalizeProviderContributionRegistryKey,
  resolveProviderContributionRegistryEntry,
} from '@/providers/registry/lookup';
import { addProviderContributionConnection } from './authoring';
import { errorForProviderResolution, type ProviderConnectionServiceContext } from './context';
import { bindProviderConnectionSecret, setProviderConnectionGrant } from './grants';
import { readSettings, replaceSettings, savedSecretExists } from './settings';
import type {
  ProviderConnectionServiceResult,
  ProviderConnectionView,
  ProviderDetectedEnableInput,
} from './types';

export function createProviderLocalOperations(context: ProviderConnectionServiceContext) {
  const { deps, featureError, assertMachine, describe } = context;

  async function enableDetected(input: ProviderDetectedEnableInput): Promise<ProviderConnectionServiceResult<ProviderConnectionView>> {
    if (!deps.featureGate.isEnabled('providers') || !deps.featureGate.isEnabled('providers.localDiscovery')) {
      return { status: 'error', error: featureError(input.connectionId) };
    }
    const machineError = assertMachine(input.machineId, input.connectionId);
    if (machineError) return { status: 'error', error: machineError };

    const described = await describe({ machineId: input.machineId });
    if (described.status === 'error') return described;
    const candidate = described.discoveryCandidates.find((entry) => entry.candidateId === input.candidateId);
    if (!candidate
      || (candidate.connection.status === 'requires_named_connection' && input.displayName === null)
      || (candidate.connection.status !== 'requires_named_connection' && input.displayName !== null)) {
      return { status: 'error', error: createProviderErrorV1('provider_authorization_changed', {
        connectionId: input.connectionId, machineId: input.machineId,
      }) };
    }

    const snapshot = await deps.loadSnapshot();
    const resolved = resolveProviderContributionRegistryEntry(snapshot.registry, candidate.contributionKey);
    const contribution = resolved?.contribution;
    if (!resolved || !contribution?.definition.discovery) {
      return { status: 'error', error: createProviderErrorV1('provider_contribution_unavailable', {
        connectionId: input.connectionId, machineId: input.machineId,
      }) };
    }
    const currentCandidateId = createProviderDiscoveryCandidateIdV1({
      machineId: candidate.machineId,
      contributionKey: resolved.contributionKey,
      endpointTemplateId: candidate.endpointTemplateId,
      normalizedEndpointUrl: candidate.normalizedEndpointUrl,
    });
    if (candidate.machineId !== input.machineId || candidate.candidateId !== currentCandidateId) {
      return { status: 'error', error: createProviderErrorV1('provider_authorization_changed', {
        connectionId: input.connectionId, machineId: input.machineId,
      }) };
    }
    const credential = contribution.definition.credential;
    if ((credential?.required === true && input.savedSecretId === null)
      || (credential === undefined && input.savedSecretId !== null)
      || (input.savedSecretId !== null && !savedSecretExists(snapshot.accountSettings, input.savedSecretId))) {
      return { status: 'error', error: createProviderErrorV1(
        credential === undefined ? 'provider_credential_transport_unavailable' : 'provider_secret_missing',
        { connectionId: input.connectionId, machineId: input.machineId },
      ) };
    }

    const matchedConnectionId = candidate.connection.status === 'matched'
      ? candidate.connection.connectionId
      : null;
    const allocatedConnectionId = matchedConnectionId ?? input.connectionId;
    const endpointOverrides = buildProviderDiscoveryEndpointOverrides({
      contribution: contribution.definition,
      endpointTemplateId: candidate.endpointTemplateId,
      normalizedEndpointUrl: candidate.normalizedEndpointUrl,
    });

    const prepare = (raw: Readonly<Record<string, unknown>>, requireCreate: boolean) => {
      let settings = readSettings(raw);
      let connection: ProviderConnectionV1;
      if (matchedConnectionId) {
        const existing = settings.connections.find((entry) => entry.id === matchedConnectionId);
        if (!existing || existing.source.kind !== 'contribution'
          || normalizeProviderContributionRegistryKey(existing.source.contributionKey) !== resolved.contributionKey) {
          throw createProviderErrorV1('provider_authorization_changed', {
            connectionId: allocatedConnectionId, machineId: input.machineId,
          });
        }
        connection = existing;
      } else {
        const mutation = addProviderContributionConnection({
          settings,
          contributionKey: resolved.contributionKey,
          contributionName: contribution.definition.name,
          connectionId: input.connectionId,
          displayName: input.displayName,
          now: deps.now(),
        });
        if (requireCreate && !mutation.created) {
          throw createProviderErrorV1('provider_authorization_changed', {
            connectionId: input.connectionId, machineId: input.machineId,
          });
        }
        settings = mutation.settings;
        connection = mutation.connection;
      }
      const updatedConnection = ProviderConnectionV1Schema.parse({
        ...connection,
        endpointOverridesByMachineId: {
          ...(connection.endpointOverridesByMachineId ?? {}),
          [input.machineId]: endpointOverrides,
        },
        revision: connection.revision + 1,
        updatedAt: deps.now(),
      });
      settings = ProviderSettingsV1Schema.parse({
        ...settings,
        connections: settings.connections.map((entry) => entry.id === connection.id ? updatedConnection : entry),
      });
      settings = bindProviderConnectionSecret({
        settings,
        connectionId: updatedConnection.id,
        machineId: input.machineId,
        slotId: credential?.slotId ?? 'apiKey',
        savedSecretId: input.savedSecretId,
      });
      return { settings, connection: updatedConnection };
    };

    const preview = prepare(snapshot.accountSettings, candidate.connection.status === 'enable_default');
    const previewRaw = replaceSettings(snapshot.accountSettings, preview.settings);
    const dnsEvidence = await deps.collectDnsEvidence({
      accountSettings: previewRaw,
      connectionId: preview.connection.id,
      machineId: input.machineId,
      registry: snapshot.registry,
    });
    const previewResolution = deps.resolveConnection({
      accountSettings: previewRaw,
      connectionId: preview.connection.id,
      machineId: input.machineId,
      registry: snapshot.registry,
      dnsEvidence,
    });
    if (previewResolution.status !== 'resolved') {
      return { status: 'error', error: errorForProviderResolution(previewResolution, input.machineId) };
    }

    await deps.updateAccountSettings((raw) => {
      const prepared = prepare(raw, candidate.connection.status === 'enable_default');
      const candidateRaw = replaceSettings(raw, prepared.settings);
      const resolution = deps.resolveConnection({
        accountSettings: candidateRaw,
        connectionId: prepared.connection.id,
        machineId: input.machineId,
        registry: snapshot.registry,
        dnsEvidence,
      });
      if (resolution.status !== 'resolved'
        || resolution.record.connectionSecurityFingerprint !== previewResolution.record.connectionSecurityFingerprint
        || resolution.record.endpointSetFingerprint !== previewResolution.record.endpointSetFingerprint) {
        throw createProviderErrorV1('provider_authorization_changed', {
          connectionId: prepared.connection.id, machineId: input.machineId,
        });
      }
      return replaceSettings(raw, setProviderConnectionGrant({
        settings: prepared.settings,
        connectionId: prepared.connection.id,
        machineId: input.machineId,
        scope: 'machine',
        enabled: true,
        connectionSecurityFingerprint: resolution.record.connectionSecurityFingerprint,
        endpointSetFingerprint: resolution.record.endpointSetFingerprint,
        now: deps.now(),
      }));
    });
    if (deps.refreshOnEnable) {
      await deps.refreshOnEnable(
        { connectionId: preview.connection.id, machineId: input.machineId },
        'enable',
      ).catch(() => undefined);
    }
    const finalDescription = await describe({ machineId: input.machineId, connectionId: preview.connection.id });
    if (finalDescription.status === 'error') return finalDescription;
    const view = finalDescription.connections[0];
    return view
      ? { status: 'success', ...view }
      : { status: 'error', error: createProviderErrorV1('provider_connection_not_found', {
          connectionId: preview.connection.id, machineId: input.machineId,
        }) };
  }

  async function startLocal(input: Readonly<{
    action: 'startLocal'; machineId: string; connectionId: string; contributionKey: string;
  }>): Promise<ProviderConnectionServiceResult<Readonly<{
    contributionKey: string; phase: 'detecting' | 'running';
  }>>> {
    if (!deps.featureGate.isEnabled('providers')
      || !deps.featureGate.isEnabled('providers.localDiscovery')
      || !deps.featureGate.isEnabled('localServices.managed')
      || !deps.startManaged) {
      return { status: 'error', error: featureError(input.connectionId) };
    }
    const machineError = assertMachine(input.machineId, input.connectionId);
    if (machineError) return { status: 'error', error: machineError };
    const described = await describe({ machineId: input.machineId });
    if (described.status === 'error') return described;
    if (described.discoveryCandidates.some((candidate) =>
      areProviderContributionKeysEqualV1(candidate.contributionKey, input.contributionKey))) {
      return { status: 'error', error: createProviderErrorV1('provider_connection_invalid', {
        connectionId: input.connectionId, machineId: input.machineId,
      }) };
    }
    const snapshot = await deps.loadSnapshot();
    const resolved = resolveProviderContributionRegistryEntry(snapshot.registry, input.contributionKey);
    const contribution = resolved?.contribution;
    const managedStart = contribution?.definition.discovery?.managedStart;
    if (!resolved || !contribution || !managedStart) {
      return { status: 'error', error: createProviderErrorV1('provider_connection_invalid', {
        connectionId: input.connectionId, machineId: input.machineId,
      }) };
    }
    const started = await deps.startManaged({
      machineId: input.machineId,
      contributionKey: resolved.contributionKey,
      pluginId: contribution.pluginId,
      providerName: contribution.definition.name,
      lookupNames: managedStart.lookupNames,
      fixedArgs: managedStart.fixedArgs,
    });
    return { status: 'success', contributionKey: resolved.contributionKey, phase: started.status };
  }

  return Object.freeze({ enableDetected, startLocal });
}
