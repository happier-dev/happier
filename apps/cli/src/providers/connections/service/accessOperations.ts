import {
  PROVIDER_ENDPOINT_SAFETY_LIMITS,
  ProviderSettingsLimitError,
  createProviderErrorV1,
} from '@happier-dev/protocol';
import { ZodError } from 'zod';

import type {
  ProviderConnectionResolution,
  ProviderEndpointDnsEvidence,
} from '@/providers/registry';
import { getProviderContribution } from '@/providers/registry/lookup';
import { createProviderOperationLifetime } from '@/providers/operationLifetime';
import { errorForProviderResolution, type ProviderConnectionServiceContext } from './context';
import { bindProviderConnectionSecret, setProviderConnectionGrant } from './grants';
import {
  ProviderConnectionValidationError,
  addPreparedSavedSecret,
  parseProviderError,
  readSettings,
  replaceSettings,
  savedSecretExists,
} from './settings';
import type {
  ProviderConnectionCreateInput,
  ProviderConnectionServiceResult,
  ProviderConnectionView,
} from './types';

export function createProviderAccessOperations(context: ProviderConnectionServiceContext) {
  const { deps, featureError, assertMachine, describe } = context;

  async function setEnabled(input: Readonly<{
    action: 'setEnabled'; machineId: string; connectionId: string;
    enabled: boolean; scope?: 'account' | 'machine' | 'connection';
  }>): Promise<ProviderConnectionServiceResult<ProviderConnectionView>> {
    if (!deps.featureGate.isEnabled('providers')) return { status: 'error', error: featureError(input.connectionId) };
    const machineError = assertMachine(input.machineId, input.connectionId);
    if (machineError) return { status: 'error', error: machineError };
    if (input.enabled && input.scope === 'connection') {
      return { status: 'error', error: createProviderErrorV1('provider_connection_invalid', {
        connectionId: input.connectionId, machineId: input.machineId,
      }) };
    }
    const lifetime = createProviderOperationLifetime({
      wallTimeMs: PROVIDER_ENDPOINT_SAFETY_LIMITS.maxWallTimeMs,
    });
    const snapshot = await deps.loadSnapshot();
    const registryProjection = {
      registry: snapshot.registry,
      ...(snapshot.registryGeneration ? { generation: snapshot.registryGeneration } : {}),
    };
    const connection = readSettings(snapshot.rawAccountSettings).connections.find((entry) => entry.id === input.connectionId);
    if (!connection) return { status: 'error', error: createProviderErrorV1('provider_connection_not_found', { connectionId: input.connectionId, machineId: input.machineId }) };
    let scope = input.scope ?? null;
    let dnsEvidence: ProviderEndpointDnsEvidence = new Map();
    let previewResolution: Extract<ProviderConnectionResolution, { status: 'resolved' }> | null = null;
    if (input.enabled) {
      dnsEvidence = await deps.collectDnsEvidence({
        accountSettings: snapshot.rawAccountSettings, connectionId: input.connectionId,
        machineId: input.machineId, registry: snapshot.registry,
        lifetime,
      });
      const resolution = deps.resolveConnection({
        accountSettings: snapshot.rawAccountSettings, connectionId: input.connectionId,
        machineId: input.machineId, registry: snapshot.registry, dnsEvidence,
      });
      if (resolution.status !== 'resolved') return { status: 'error', error: errorForProviderResolution(resolution, input.machineId) };
      scope = resolution.record.scope;
      previewResolution = resolution;
    }
    if (!scope) return { status: 'error', error: createProviderErrorV1('provider_connection_disabled', { connectionId: input.connectionId, machineId: input.machineId }) };
    await deps.updateAccountSettings((raw) => {
      const settings = readSettings(raw);
      const resolution = input.enabled
        ? deps.resolveConnection({
            accountSettings: raw, connectionId: input.connectionId,
            machineId: input.machineId, registry: snapshot.registry, dnsEvidence,
          })
        : null;
      if (resolution && resolution.status !== 'resolved') throw errorForProviderResolution(resolution, input.machineId);
      if (resolution && (
        !previewResolution
        || resolution.record.connectionSecurityFingerprint !== previewResolution.record.connectionSecurityFingerprint
        || resolution.record.endpointSetFingerprint !== previewResolution.record.endpointSetFingerprint
      )) {
        throw createProviderErrorV1('provider_authorization_changed', {
          connectionId: input.connectionId, machineId: input.machineId,
        });
      }
      return replaceSettings(raw, setProviderConnectionGrant({
        settings, connectionId: input.connectionId, machineId: input.machineId,
        scope: resolution?.record.scope ?? scope!,
        enabled: input.enabled,
        connectionSecurityFingerprint: resolution?.record.connectionSecurityFingerprint ?? 'unused-for-disable',
        endpointSetFingerprint: resolution?.record.endpointSetFingerprint ?? 'unused-for-disable',
        now: deps.now(),
      }));
    });
    if (input.enabled && deps.refreshOnEnable) {
      await deps.refreshOnEnable(
        { connectionId: input.connectionId, machineId: input.machineId },
        'enable',
      ).catch(() => undefined);
    }
    const described = await describe({
      machineId: input.machineId,
      connectionId: input.connectionId,
      registryProjection,
      lifetime,
    });
    if (described.status === 'error') return described;
    const view = described.connections[0];
    return view
      ? { status: 'success', ...view }
      : { status: 'error', error: createProviderErrorV1('provider_connection_not_found', { connectionId: input.connectionId, machineId: input.machineId }) };
  }

  async function bindSecret(input: Readonly<{
    action: 'bindSecret'; machineId: string; connectionId: string; credentialSlotId: string;
    savedSecretId: string | null; scope: 'account' | 'machine';
    preparedSavedSecret?: ProviderConnectionCreateInput['preparedSavedSecret'];
  }>): Promise<ProviderConnectionServiceResult<ProviderConnectionView>> {
    if (!deps.featureGate.isEnabled('providers')) return { status: 'error', error: featureError(input.connectionId) };
    const machineError = assertMachine(input.machineId, input.connectionId);
    if (machineError) return { status: 'error', error: machineError };
    const lifetime = createProviderOperationLifetime({
      wallTimeMs: PROVIDER_ENDPOINT_SAFETY_LIMITS.maxWallTimeMs,
    });
    const snapshot = await deps.loadSnapshot();
    const registryProjection = {
      registry: snapshot.registry,
      ...(snapshot.registryGeneration ? { generation: snapshot.registryGeneration } : {}),
    };
    try {
      if (input.preparedSavedSecret && input.savedSecretId !== input.preparedSavedSecret.id) {
        throw new ProviderConnectionValidationError('The prepared SavedSecret must be the exact bound secret');
      }
      await deps.updateAccountSettings((raw) => {
        const rawWithPreparedSecret = addPreparedSavedSecret(raw, input.preparedSavedSecret);
        const settings = readSettings(rawWithPreparedSecret);
        const connection = settings.connections.find((entry) => entry.id === input.connectionId);
        if (!connection) {
          throw createProviderErrorV1('provider_connection_not_found', { connectionId: input.connectionId, machineId: input.machineId });
        }
        if (
          input.savedSecretId !== null
          && connection.deployment.kind === 'managedLocal'
        ) {
          throw new ProviderConnectionValidationError(
            'Managed Provider connections do not accept SavedSecret bindings',
          );
        }
        const contribution = connection.source.kind === 'contribution'
          ? getProviderContribution(snapshot.registry, connection.source.contributionKey)
          : null;
        const credential = connection.source.kind === 'custom'
          ? connection.source.template.credential
          : contribution?.definition.credential;
        if (input.savedSecretId !== null && connection.source.kind === 'contribution' && !contribution) {
          throw createProviderErrorV1('provider_contribution_unavailable', {
            connectionId: input.connectionId, machineId: input.machineId,
          });
        }
        if (input.savedSecretId !== null && credential === undefined) {
          throw createProviderErrorV1('provider_credential_transport_unavailable', {
            connectionId: input.connectionId, machineId: input.machineId,
          });
        }
        if (credential !== undefined && input.credentialSlotId !== credential.slotId) {
          throw createProviderErrorV1('provider_credential_transport_unavailable', {
            connectionId: input.connectionId, machineId: input.machineId,
          });
        }
        if (input.savedSecretId !== null && !savedSecretExists(rawWithPreparedSecret, input.savedSecretId)) {
          throw createProviderErrorV1('provider_secret_missing', { connectionId: input.connectionId, machineId: input.machineId });
        }
        return replaceSettings(rawWithPreparedSecret, bindProviderConnectionSecret({
          settings, connectionId: input.connectionId,
          machineId: input.scope === 'machine' ? input.machineId : null,
          slotId: input.credentialSlotId, savedSecretId: input.savedSecretId,
        }));
      });
    } catch (error) {
      const providerError = parseProviderError(error);
      if (providerError) return { status: 'error', error: providerError };
      if (error instanceof ProviderSettingsLimitError) {
        return { status: 'error', error: createProviderErrorV1('provider_settings_limit_exceeded', { connectionId: input.connectionId, machineId: input.machineId }) };
      }
      if (error instanceof ProviderConnectionValidationError || error instanceof ZodError) {
        return { status: 'error', error: createProviderErrorV1('provider_connection_invalid', {
          connectionId: input.connectionId, machineId: deps.machineId,
        }) };
      }
      throw error;
    }
    const described = await describe({
      machineId: input.machineId,
      connectionId: input.connectionId,
      registryProjection,
      lifetime,
    });
    if (described.status === 'error') return described;
    const view = described.connections[0];
    return view
      ? { status: 'success', ...view }
      : { status: 'error', error: createProviderErrorV1('provider_connection_not_found', { connectionId: input.connectionId, machineId: input.machineId }) };
  }

  return Object.freeze({ setEnabled, bindSecret });
}
