import {
  PROVIDER_ENDPOINT_SAFETY_LIMITS,
  ProviderConnectionV1Schema,
  ProviderSettingsV1Schema,
  type QualifiedConnectedAccountPurposeBindingsV1,
  createProviderManagedRuntimeBindingEqualityKeyV1,
  createProviderDiscoveryCandidateIdV1,
  createProviderErrorV1,
  type ProviderConnectionV1,
} from '@happier-dev/protocol';

import { buildProviderDiscoveryEndpointOverrides } from '@/providers/discovery/bridge';
import { resolveProviderContributionRegistryView } from '@/providers/registry';
import type { PluginRuntimeRegistryLease } from '@/plugins/runtime/reload/controller';
import {
  normalizeProviderContributionRegistryKey,
  resolveProviderContributionRegistryEntry,
} from '@/providers/registry/lookup';
import { resolveManagedProviderPurposeBindingSnapshot } from '@/providers/managed/resolvePurposeBindingSnapshot';
import { createProviderOperationLifetime } from '@/providers/operationLifetime';
import { addProviderContributionConnection } from './authoring';
import { errorForProviderResolution, type ProviderConnectionServiceContext } from './context';
import { bindProviderConnectionSecret, setProviderConnectionGrant } from './grants';
import { readSettings, replaceSettings, savedSecretExists } from './settings';
import type {
  ProviderConnectionServiceResult,
  ProviderConnectionView,
  ProviderDetectedEnableInput,
} from './types';

function emptyManagedPurposeBindings(): QualifiedConnectedAccountPurposeBindingsV1 {
  return { v: 1, bindings: [] };
}

export function createProviderLocalOperations(context: ProviderConnectionServiceContext) {
  const { deps, featureError, assertMachine, describe } = context;

  async function enableDetected(input: ProviderDetectedEnableInput): Promise<ProviderConnectionServiceResult<ProviderConnectionView>> {
    if (!deps.featureGate.isEnabled('providers') || !deps.featureGate.isEnabled('providers.localDiscovery')) {
      return { status: 'error', error: featureError(input.connectionId) };
    }
    const machineError = assertMachine(input.machineId, input.connectionId);
    if (machineError) return { status: 'error', error: machineError };

    const lifetime = createProviderOperationLifetime({
      wallTimeMs: PROVIDER_ENDPOINT_SAFETY_LIMITS.maxWallTimeMs,
    });
    const initialSnapshot = await deps.loadSnapshot();
    const registryProjection = {
      registry: initialSnapshot.registry,
      ...(initialSnapshot.registryGeneration ? { generation: initialSnapshot.registryGeneration } : {}),
    };

    const described = await describe({
      machineId: input.machineId,
      registryProjection,
      lifetime,
    });
    if (described.status === 'error') return described;
    const candidate = described.discoveryCandidates.find((entry) => entry.candidateId === input.candidateId);
    if (!candidate
      || (candidate.connection.status === 'requires_named_connection' && input.displayName === null)
      || (candidate.connection.status !== 'requires_named_connection' && input.displayName !== null)) {
      return { status: 'error', error: createProviderErrorV1('provider_authorization_changed', {
        connectionId: input.connectionId, machineId: input.machineId,
      }) };
    }

    const snapshot = await deps.loadSnapshot(registryProjection);
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
      || (input.savedSecretId !== null && !savedSecretExists(snapshot.rawAccountSettings, input.savedSecretId))) {
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

    const preview = prepare(snapshot.rawAccountSettings, candidate.connection.status === 'enable_default');
    const previewRaw = replaceSettings(snapshot.rawAccountSettings, preview.settings);
    const dnsEvidence = await deps.collectDnsEvidence({
      accountSettings: previewRaw,
      connectionId: preview.connection.id,
      machineId: input.machineId,
      registry: snapshot.registry,
      lifetime,
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
    const finalDescription = await describe({
      machineId: input.machineId,
      connectionId: preview.connection.id,
      registryProjection,
      lifetime,
    });
    if (finalDescription.status === 'error') return finalDescription;
    const view = finalDescription.connections[0];
    return view
      ? { status: 'success', ...view }
      : { status: 'error', error: createProviderErrorV1('provider_connection_not_found', {
          connectionId: preview.connection.id, machineId: input.machineId,
        }) };
  }

  async function startLocal(input: Readonly<{
    action: 'startLocal'; machineId: string; connectionId?: string; contributionKey: string;
  }>): Promise<ProviderConnectionServiceResult<Readonly<{
    contributionKey: string; phase: 'detecting' | 'running';
  }>>> {
    if (!deps.featureGate.isEnabled('providers')
      || !deps.startManagedProviderRuntime) {
      return { status: 'error', error: featureError(input.connectionId) };
    }
    const machineError = assertMachine(input.machineId, input.connectionId);
    if (machineError) return { status: 'error', error: machineError };
    let runtimeRegistryLease: PluginRuntimeRegistryLease | null = null;
    try {
      runtimeRegistryLease = deps.acquireManagedProviderRuntimeRegistryLease
        ? await deps.acquireManagedProviderRuntimeRegistryLease()
        : null;
      const registryGeneration = runtimeRegistryLease?.registry.generation;
      if (runtimeRegistryLease && typeof registryGeneration !== 'number') {
        throw new Error('Authoritative Provider registry is missing its immutable generation tag');
      }
      const registryProjection = runtimeRegistryLease && typeof registryGeneration === 'number'
        ? Object.freeze({
            registry: resolveProviderContributionRegistryView(
              runtimeRegistryLease.registry.contributes,
              registryGeneration,
            ),
            generation: String(registryGeneration),
          })
        : undefined;
      const snapshot = await deps.loadSnapshot(registryProjection);
      const resolved = resolveProviderContributionRegistryEntry(snapshot.registry, input.contributionKey);
      const contribution = resolved?.contribution;
      const managedRuntime = contribution?.definition.managedRuntime;
      if (!resolved || !contribution || managedRuntime?.kind !== 'managed') {
        return { status: 'error', error: createProviderErrorV1('provider_connection_invalid', {
          ...(input.connectionId ? { connectionId: input.connectionId } : {}),
          machineId: input.machineId,
        }) };
      }

      const resolvePurposeBindings = async (
        candidateSnapshot: typeof snapshot,
        candidateResolved: NonNullable<typeof resolved>,
        candidateContribution: typeof contribution,
        candidateRuntime: typeof managedRuntime,
      ) => {
        const connectedAccounts = candidateRuntime.connectedAccounts ?? [];
        if (connectedAccounts.length === 0) {
          const purposeBindings = emptyManagedPurposeBindings();
          return {
            status: 'unconfigured' as const,
            purposeBindings,
            basis: createProviderManagedRuntimeBindingEqualityKeyV1({
              implementationIdentity: candidateContribution.identity,
              managedRuntime: candidateRuntime,
              purposeBindings,
            }),
          };
        }
        const selectedConnection = readSettings(candidateSnapshot.accountSettings)
          .connections.find((connection) => (
            connection.role === 'default'
            && connection.source.kind === 'contribution'
            && normalizeProviderContributionRegistryKey(connection.source.contributionKey)
              === candidateResolved.contributionKey
          ));
        if (!selectedConnection) return { status: 'missing_default' as const };

        const connectionResolution = deps.resolveConnection({
          accountSettings: candidateSnapshot.accountSettings,
          connectionId: selectedConnection.id,
          machineId: input.machineId,
          registry: candidateSnapshot.registry,
          // Managed Local deployments have no network endpoint to resolve. The
          // canonical connection resolver still validates the selected record,
          // source, deployment, and purpose-binding intent.
          dnsEvidence: new Map(),
        });
        if (
          connectionResolution.status !== 'resolved'
          || connectionResolution.record.deployment.kind !== 'managedLocal'
          || connectionResolution.record.source.kind !== 'contribution'
          || normalizeProviderContributionRegistryKey(
            connectionResolution.record.source.contributionKey,
          ) !== candidateResolved.contributionKey
          || connectionResolution.record.deployment.implementationIdentity.pluginId
            !== candidateContribution.identity.pluginId
          || connectionResolution.record.deployment.implementationIdentity.localId
            !== candidateContribution.identity.localId
          || !deps.resolveManagedPurposeBindingIntent
        ) {
          return { status: 'invalid' as const };
        }

        try {
          const purposeBindings = await resolveManagedProviderPurposeBindingSnapshot({
            implementationIdentity:
              connectionResolution.record.deployment.implementationIdentity,
            connectedAccounts:
              connectionResolution.record.deployment.managedRuntime.connectedAccounts ?? [],
            purposeBindingIntents:
              connectionResolution.record.deployment.purposeBindingIntents,
            resolveBindingIntent: deps.resolveManagedPurposeBindingIntent,
          });
          return {
            status: 'configured' as const,
            purposeBindings,
            basis: createProviderManagedRuntimeBindingEqualityKeyV1({
              implementationIdentity: candidateContribution.identity,
              managedRuntime: candidateRuntime,
              purposeBindings,
            }),
          };
        } catch {
          return { status: 'invalid' as const };
        }
      };

      const purposeBindingResolution = await resolvePurposeBindings(
        snapshot,
        resolved,
        contribution,
        managedRuntime,
      );
      if (purposeBindingResolution.status === 'missing_default') {
        return { status: 'error', error: createProviderErrorV1('provider_connection_not_found', {
          ...(input.connectionId ? { connectionId: input.connectionId } : {}),
          machineId: input.machineId,
        }) };
      }
      if (purposeBindingResolution.status === 'invalid') {
        return { status: 'error', error: createProviderErrorV1('provider_authorization_changed', {
          ...(input.connectionId ? { connectionId: input.connectionId } : {}),
          machineId: input.machineId,
        }) };
      }

      let authorizationCurrent = true;
      const isAuthorizationCurrent = () => authorizationCurrent
        && deps.featureGate.isEnabled('providers');
      const revalidateAuthorization = async (): Promise<boolean> => {
        if (!isAuthorizationCurrent()) return false;
        const current = await deps.loadSnapshot(registryProjection);
        const currentResolved = resolveProviderContributionRegistryEntry(
          current.registry,
          resolved.contributionKey,
        );
        const currentRuntime = currentResolved?.contribution.definition.managedRuntime;
        if (
          !currentResolved
          || currentResolved.contribution.identity.pluginId !== contribution.identity.pluginId
          || currentResolved.contribution.identity.localId !== contribution.identity.localId
          || currentRuntime?.kind !== 'managed'
        ) {
          authorizationCurrent = false;
          return false;
        }
        let currentPurposeBindingResolution: Awaited<ReturnType<typeof resolvePurposeBindings>>;
        try {
          currentPurposeBindingResolution = await resolvePurposeBindings(
            current,
            currentResolved,
            currentResolved.contribution,
            currentRuntime,
          );
        } catch {
          authorizationCurrent = false;
          return false;
        }
        authorizationCurrent = currentPurposeBindingResolution.status
          === purposeBindingResolution.status
          && currentPurposeBindingResolution.basis === purposeBindingResolution.basis;
        return isAuthorizationCurrent();
      };
      const started = await deps.startManagedProviderRuntime({
        contributionKey: resolved.contributionKey,
        identity: contribution.identity,
        request: {
          reason: 'explicitStartLocal',
          endpointTemplateIds: [...managedRuntime.endpointTemplateIds],
        },
        purposeBindings: purposeBindingResolution.purposeBindings,
        isAuthorizationCurrent,
        revalidateAuthorization,
        ...(runtimeRegistryLease ? { runtimeRegistryLease } : {}),
      });
      return { status: 'success', contributionKey: resolved.contributionKey, phase: started.status };
    } finally {
      // A settled live start has already transferred its cleanup to the exact
      // registry generation. A late lease-release acknowledgement must not
      // turn that success into a retryable caller failure.
      await runtimeRegistryLease?.release().catch(() => undefined);
    }
  }

  return Object.freeze({ enableDetected, startLocal });
}
