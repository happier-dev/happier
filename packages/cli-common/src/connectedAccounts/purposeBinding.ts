import { isConnectedServiceCredentialHealthStatusReconnectRequired } from '@happier-dev/protocol/connect/connected-service-schemas';
import { HOST_CONNECTED_ACCOUNT_SERVICE_REF_V1, sameQualifiedConnectedAccountRef } from '@happier-dev/protocol/connect/qualified-connected-account-persistence';
import { isQualifiedConnectedAccountProfileUsableV4, resolveQualifiedConnectedAccountGroupActiveAccountV4 } from '@happier-dev/protocol/connect/qualified-connected-account-projections';
import { CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES } from '@happier-dev/protocol/connect/connectedServiceUxDiagnostics';
import { QualifiedConnectedAccountPurposeBindingsV1Schema, qualifiedPurposeKey, type QualifiedConnectedAccountPurposeBindingsV1 } from '@happier-dev/protocol/connect/connected-account-purpose-bindings';
import { QualifiedConnectedAccountPurposeV1Schema } from '@happier-dev/protocol/connect/connectedAccountPurposeIdentity';
import type { ConnectedAccountMaterializationRequest, QualifiedConnectedAccountPurposeV1 } from '@happier-dev/protocol/connect/connected-account-purposes';
import type { ConnectedAccountInvocationPurposeBinding } from '@happier-dev/protocol';
export type { ConnectedAccountInvocationPurposeBinding } from '@happier-dev/protocol';
import { PluginError } from '../plugins/errors.js';
import { listConnectedAccountActionFormOptions, readConnectedAccountPurposeProfileLabel,
  type ConnectedAccountPurposeTargetSource } from './purposeInventory.js';
export type { ConnectedAccountPurposeTargetSource } from './purposeInventory.js';
import { createConnectedAccountPurposeTargetAccountListing, projectConnectedAccountPurposeTargetInventory,
  type ConnectedAccountPurposeMetadataList } from './purposeAccountListing.js';
import type { ConnectedAccountConfiguredEndpoint } from './configuredOrigins.js';
export { readConnectedAccountPurposeProfileLabel } from './purposeInventory.js';
import type { PluginConnectedAccountAuthenticationV2, QualifiedConnectedAccountGroupV4, QualifiedConnectedAccountProfileV4,
  QualifiedConnectedAccountPurposeBindingTargetV1, QualifiedConnectedAccountRef } from '@happier-dev/protocol';

export type ConnectedAccountPurposeTargetObservation = Readonly<{
  authentication: PluginConnectedAccountAuthenticationV2;
  profiles: readonly QualifiedConnectedAccountProfileV4[];
  group?: QualifiedConnectedAccountGroupV4;
}>;

export type ConnectedAccountPurposeResolvedTarget = Readonly<{
  displayName: string;
  account: QualifiedConnectedAccountRef;
  group?: Readonly<{ groupId: string; generation: number }>;
  observation?: ConnectedAccountPurposeTargetObservation;
}>;

/** A confirmed health fact, distinct from absent selection or unreadable inventory. */
export class ConnectedAccountSourceReconnectRequiredError extends Error {
  readonly code = CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES.connectedServiceCredentialReconnectRequired;
  readonly retryable = false;
  constructor() {
    super(CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES.connectedServiceCredentialReconnectRequired);
    this.name = 'ConnectedAccountSourceReconnectRequiredError';
  }
}

export type ConnectedAccountPurposePortSelection = Readonly<{
  /** Exact Account chosen by the admitted Action operand, never a fallback. */
  expectedAccount?: QualifiedConnectedAccountRef;
  purpose: QualifiedConnectedAccountPurposeV1;
  serviceRefs: readonly QualifiedConnectedAccountRef['service'][];
  purposeBindings: QualifiedConnectedAccountPurposeBindingsV1;
  signal: AbortSignal;
}>;

function readsCurrent(check: () => boolean): boolean {
  try {
    return check() === true;
  } catch {
    return false;
  }
}

/** Capture one host-admitted operation before either physical host consumes its purposes. */
export function captureConnectedAccountInvocationPurposeBinding(
  input: ConnectedAccountInvocationPurposeBinding,
  expectedIdentity?: ConnectedAccountInvocationPurposeBinding['identity'],
): ConnectedAccountInvocationPurposeBinding {
  const managedOperation = input.managedOperation;
  const isCurrent = () => readsCurrent(input.isCurrent)
    && (managedOperation === undefined || readsCurrent(() => (
      managedOperation.isCurrent(managedOperation.role)
    )));
  const identity = Object.freeze({
    pluginId: input.identity.pluginId.trim(),
    localId: input.identity.localId.trim(),
  });
  const operationId = input.operationId.trim();
  if (!identity.pluginId || !identity.localId || !operationId) {
    throw new Error('managed_provider_operation_authority_identity_invalid');
  }
  if (expectedIdentity && (identity.pluginId !== expectedIdentity.pluginId || identity.localId !== expectedIdentity.localId)) {
    throw new Error('managed_provider_operation_authority_consumer_mismatch');
  }
  const purposes = Object.freeze(input.purposes.map((purposeLike) => {
    const purpose = QualifiedConnectedAccountPurposeV1Schema.parse(purposeLike);
    if (purpose.consumer.pluginId !== identity.pluginId || purpose.consumer.localId !== identity.localId) {
      throw new Error('managed_provider_operation_authority_consumer_mismatch');
    }
    return Object.freeze({ consumer: Object.freeze({ ...purpose.consumer }), purpose: purpose.purpose });
  }));
  const purposeKeys = new Set(purposes.map(qualifiedPurposeKey));
  if (purposeKeys.size !== purposes.length) {
    throw new Error('managed_provider_operation_authority_duplicate_purpose');
  }
  const purposeBindings = QualifiedConnectedAccountPurposeBindingsV1Schema.parse(input.purposeBindings);
  const bindingKeys = new Set<string>();
  for (const binding of purposeBindings.bindings) {
    const key = qualifiedPurposeKey(binding.purpose);
    if (!purposeKeys.has(key) || bindingKeys.has(key)) {
      throw new Error('managed_provider_operation_authority_binding_invalid');
    }
    bindingKeys.add(key);
  }
  Object.freeze(purposeBindings.bindings);
  return Object.freeze({ identity, operationId, purposes, purposeBindings: Object.freeze(purposeBindings), isCurrent,
    ...(managedOperation === undefined ? {} : { managedOperation }),
  });
}

function sameService(left: QualifiedConnectedAccountRef['service'], right: QualifiedConnectedAccountRef['service']): boolean {
  return left.pluginId === right.pluginId && left.localId === right.localId;
}

export function readConnectedAccountPurposeBindingTarget(
  collection: QualifiedConnectedAccountPurposeBindingsV1,
  purpose: QualifiedConnectedAccountPurposeV1,
): QualifiedConnectedAccountPurposeBindingTargetV1 | null {
  const key = qualifiedPurposeKey(purpose);
  return collection.bindings.find(binding => qualifiedPurposeKey(binding.purpose) === key)?.target ?? null;
}

/** Shared service-scope admission; the MCP host exception remains host-issued. */
export function assertConnectedAccountPurposeTargetAuthorized(
  target: QualifiedConnectedAccountPurposeBindingTargetV1,
  serviceRefs: readonly QualifiedConnectedAccountRef['service'][],
  hostMcpRequestAuth = false,
): void {
  const service = target.kind === 'account' ? target.account.service : target.service;
  if ((!hostMcpRequestAuth && sameService(service, HOST_CONNECTED_ACCOUNT_SERVICE_REF_V1))
    || !serviceRefs.some(candidate => sameService(candidate, service))) {
    throw new PluginError({ code: 'plugin_connected_account_binding_out_of_scope',
      message: 'Connected Accounts selection is outside the authorized service scope' });
  }
}

export function assertConnectedAccountPurposeResolvedTargetMatchesIntent(
  target: QualifiedConnectedAccountPurposeBindingTargetV1,
  resolved: ConnectedAccountPurposeResolvedTarget,
): void {
  const intendedService = target.kind === 'account' ? target.account.service : target.service;
  if (!sameService(resolved.account.service, intendedService)) throw new Error('connected_account_purpose_resolution_service_mismatch');
  if (target.kind === 'account' && !sameQualifiedConnectedAccountRef(resolved.account, target.account)) {
    throw new Error('connected_account_purpose_resolution_account_mismatch');
  }
}

/** Account and daemon adapters supply the same admitted selection and materializer. */
export function createConnectedAccountPurposePort<TMaterial>(source: ConnectedAccountPurposeTargetSource & Readonly<{
  resolveConnectedAccountEndpoints?(input: Readonly<{ account: QualifiedConnectedAccountRef; signal: AbortSignal }>): Promise<readonly ConnectedAccountConfiguredEndpoint[]>;
  materializeAccount(input: Readonly<{ account: QualifiedConnectedAccountRef; request: ConnectedAccountMaterializationRequest;
    signal: AbortSignal }>): Promise<TMaterial>;
}>) {
  const resolveTarget = createPurposeTargetResolver(source);
  return Object.freeze({
    /** One finite operation; bind again at the next credential acquisition. */
    async bind(input: ConnectedAccountPurposePortSelection): Promise<Readonly<{
      binding: ConnectedAccountPurposeResolvedTarget & Readonly<{ observation: ConnectedAccountPurposeTargetObservation }>;
      materialize(request: ConnectedAccountMaterializationRequest): Promise<TMaterial>;
      listAccounts(input?: Readonly<{ limit?: number }>): Promise<ConnectedAccountPurposeMetadataList>;
      materializeListedAccount(account: QualifiedConnectedAccountRef, request: ConnectedAccountMaterializationRequest): Promise<TMaterial>;
    }>> {
      input.signal.throwIfAborted();
      const target = readConnectedAccountPurposeBindingTarget(input.purposeBindings, input.purpose);
      if (!target) throw new PluginError({ code: 'plugin_connected_account_binding_unavailable',
        details: { reasonCode: 'unselected' } });
      assertConnectedAccountPurposeTargetAuthorized(target, input.serviceRefs);
      const binding = await resolveTarget(target, input.signal);
      input.signal.throwIfAborted();
      if (!binding) throw new PluginError({ code: 'plugin_connected_account_binding_unavailable',
        details: { reasonCode: 'target_unavailable' } });
      assertConnectedAccountPurposeResolvedTargetMatchesIntent(target, binding);
      if (input.expectedAccount && !sameQualifiedConnectedAccountRef(input.expectedAccount, binding.account)) {
        throw new PluginError({ code: 'plugin_connected_account_binding_out_of_scope' });
      }
      const listing = createConnectedAccountPurposeTargetAccountListing({
        readTargetAccountInventory: async request => projectConnectedAccountPurposeTargetInventory({
          target: request.target, observation: binding.observation }),
        resolveConnectedAccountEndpoints: source.resolveConnectedAccountEndpoints,
      });
      return Object.freeze({
        binding,
        listAccounts: (options: Readonly<{ limit?: number }> = {}) => listing.projectTargetAccounts({ target, signal: input.signal, ...options }),
        async materializeListedAccount(account: QualifiedConnectedAccountRef, request: ConnectedAccountMaterializationRequest) {
          const selection = { target, account, request, signal: input.signal };
          await listing.assertTargetAccountMaterializable(selection);
          const result = await source.materializeAccount({ account, request, signal: input.signal });
          input.signal.throwIfAborted();
          return result;
        },
        async materialize(request) {
          input.signal.throwIfAborted();
          const result = await source.materializeAccount({ account: binding.account, request, signal: input.signal });
          input.signal.throwIfAborted();
          return result;
        },
      });
    },
    async listActionFormConnectedAccountOptions(input: Readonly<{ serviceRefs: readonly QualifiedConnectedAccountRef['service'][];
      signal: AbortSignal }>): Promise<readonly Readonly<{ value: QualifiedConnectedAccountRef; label: string }>[]> {
      return listConnectedAccountActionFormOptions(source, input);
    },
  });
}

/** Read committed Pool membership; confirmed health rotation belongs to the switch coordinator. */
export function createPurposeTargetResolver(input: ConnectedAccountPurposeTargetSource):
  (target: QualifiedConnectedAccountPurposeBindingTargetV1, signal: AbortSignal, observationOnly?: true) => Promise<
    (ConnectedAccountPurposeResolvedTarget & Readonly<{ observation: ConnectedAccountPurposeTargetObservation }>) | null> {
  return async (target, signal, observationOnly) => {
    const service = await input.resolveService(target.kind === 'account' ? target.account.service : target.service, signal);
    if (!service || !input.available) return null;
    const group = target.kind === 'group' && input.readGroup
      ? await input.readGroup({ service: service.service, groupId: target.groupId }, signal) : null;
    signal.throwIfAborted();
    if (target.kind === 'group' && !group) return null;
    const accounts = await input.listAccounts(service.service, signal, observationOnly);
    signal.throwIfAborted();
    const selectedRef = target.kind === 'account' ? target.account
      : group?.activeConnectedAccountId && group.members.some(member => member.enabled !== false
          && member.connectedAccountId === group.activeConnectedAccountId)
        ? { service: target.service, accountId: group.activeConnectedAccountId } : null;
    const selected = selectedRef ? accounts.find(profile => sameQualifiedConnectedAccountRef(profile.ref, selectedRef)) : undefined;
    if (selected && isConnectedServiceCredentialHealthStatusReconnectRequired(selected.status)) {
      throw new ConnectedAccountSourceReconnectRequiredError();
    }
    const profile = group ? resolveQualifiedConnectedAccountGroupActiveAccountV4({ group, accounts,
      authentication: service.authentication, now: Date.now() })
      : selected && isQualifiedConnectedAccountProfileUsableV4({ profile: selected,
          authentication: service.authentication, now: Date.now() }) ? selected : null;
    if (!profile) return null;
    const memberIds = group ? new Set(group.members.map(member => member.connectedAccountId)) : null;
    return Object.freeze({
      displayName: group ? group.displayName ?? group.ref.groupId
        : readConnectedAccountPurposeProfileLabel(profile) ?? profile.ref.accountId,
      account: Object.freeze({ service: Object.freeze({ ...profile.ref.service }), accountId: profile.ref.accountId }),
      ...(group ? { group: Object.freeze({ groupId: group.ref.groupId, generation: group.generation }) } : {}),
      observation: Object.freeze({ authentication: service.authentication, ...(group ? { group } : {}), profiles: Object.freeze(group
        ? accounts.filter(candidate => memberIds!.has(candidate.ref.accountId)
          && candidate.ref.service.pluginId === service.service.pluginId && candidate.ref.service.localId === service.service.localId)
        : [profile]) }),
    });
  };
}
