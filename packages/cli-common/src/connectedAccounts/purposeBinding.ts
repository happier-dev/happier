import { isConnectedServiceCredentialHealthStatusReconnectRequired } from '@happier-dev/protocol/connect/connected-service-schemas';
import { sameQualifiedConnectedAccountRef } from '@happier-dev/protocol/connect/qualified-connected-account-persistence';
import { isQualifiedConnectedAccountProfileUsableV4, resolveQualifiedConnectedAccountGroupActiveAccountV4 } from '@happier-dev/protocol/connect/qualified-connected-account-projections';
import { CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES } from '@happier-dev/protocol/connect/connectedServiceUxDiagnostics';
import type { PluginConnectedAccountAuthenticationV2, QualifiedConnectedAccountGroupV4, QualifiedConnectedAccountProfileV4,
  QualifiedConnectedAccountPurposeBindingTargetV1, QualifiedConnectedAccountRef } from '@happier-dev/protocol';
import { readConnectedAccountPurposeProfileLabel,
  type ConnectedAccountPurposeTargetSource } from './purposeInventory.js';

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
