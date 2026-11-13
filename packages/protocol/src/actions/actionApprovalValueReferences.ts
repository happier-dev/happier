import { formatSharedSavedSecretRefV1, parseSavedSecretRefV1 } from '../account/settings/savedSecretReferenceV1.js';
import type { InputTypeReferenceV1 } from '../inputs/inputTypes.js';
import { QualifiedConnectedAccountPurposeBindingTargetV1Schema } from '../connect/connectedAccountPurposeBindings.js';
import { buildQualifiedPluginContributionKey } from '../plugins/contributionKey.js';
import { SessionModelSelectionV1Schema } from '../providers/selection/v1.js';
import { BackendTargetRefV2InputSchema, parseBackendTargetKeyV2, readBackendTargetRefV2 } from '../backends/targets/backendTargetRefV2.js';
import type { ApprovalActionReference } from './actionApprovalPresentation.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A model selection (`{ ref: { agentTargetKey, providerConnectionId, modelId } }`) read as the model it chose. */
export function readApprovalModelReference(
  value: unknown,
): ApprovalActionReference | undefined {
  const ref = isRecord(value) && isRecord(value.ref) ? value.ref : null;
  if (
    !ref ||
    typeof ref.modelId !== 'string' ||
    !ref.modelId.trim() ||
    typeof ref.agentTargetKey !== 'string'
  )
    return undefined;
  if (
    typeof ref.providerConnectionId === 'string' &&
    ref.providerConnectionId.trim()
  ) {
    return {
      kind: 'providerModel',
      id: ref.modelId,
      connectionId: ref.providerConnectionId,
      agentTargetKey: ref.agentTargetKey,
    };
  }
  return ref.providerConnectionId === null ||
    ref.providerConnectionId === undefined
    ? {
        kind: 'agentModel',
        id: ref.modelId,
        agentTargetKey: ref.agentTargetKey,
      }
    : undefined;
}

/** The declared Session model selection shape (a default model, a Session's model) reads as its model, wherever it is carried. */
export function readApprovalDeclaredModelSelection(
  value: unknown,
): ApprovalActionReference | undefined {
  return SessionModelSelectionV1Schema.safeParse(value).success
    ? readApprovalModelReference(value)
    : undefined;
}

/**
 * The Account or pool a connected-service binding names (`{ kind: 'group', service, groupId }`), read like a
 * Connected Account reference: by its service and account or pool name, never by its plugin, local and group ids.
 */
export function readApprovalConnectedAccountTarget(
  value: unknown,
): Readonly<{ id: string; reference: ApprovalActionReference }> | undefined {
  const target =
    QualifiedConnectedAccountPurposeBindingTargetV1Schema.safeParse(value);
  if (!target.success) return undefined;
  if (target.data.kind === 'group') {
    const id = target.data.groupId;
    return {
      id,
      reference: {
        kind: 'connectedAccount',
        id,
        service: buildQualifiedPluginContributionKey(target.data.service),
        pool: true,
      },
    };
  }
  const { accountId, service } = target.data.account;
  return {
    id: accountId,
    reference: {
      kind: 'connectedAccount',
      id: accountId,
      service: buildQualifiedPluginContributionKey(service),
    },
  };
}

/**
 * A Provider connection's purpose slots (`{ [purpose]: binding target }`) as the Account or pool each one names.
 * The slot's own title is the Provider's declaration, read by the client through the owner it names here.
 */
export function readApprovalPurposeBindings(
  value: unknown,
  owner: Readonly<{ contributionKey?: string; connectionId?: string }>,
): readonly Readonly<{ purpose: string; id: string; reference: ApprovalActionReference }>[] | undefined {
  if (!isRecord(value)) return undefined;
  const bindings = Object.entries(value).map(([purpose, target]) => {
    const account = readApprovalConnectedAccountTarget(target);
    return account
      ? { purpose, id: account.id, reference: { ...account.reference, purpose: { id: purpose, ...owner } } }
      : null;
  });
  return bindings.length > 0 && bindings.every((binding) => binding !== null) ? bindings : undefined;
}

/**
 * A Saved Secret named by an Action operand: the Provider `savedSecretId` is its reference, and the personal
 * Saved Secret Actions (`secrets.*`) carry its resource id. People read it by its name, never by the id.
 */
export function readApprovalSavedSecretReference(
  actionId: string,
  key: string | undefined,
  value: unknown,
  inputType?: InputTypeReferenceV1,
): ApprovalActionReference | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  if (inputType && 'hostType' in inputType && inputType.hostType === 'savedSecretReference') {
    return { kind: 'savedSecret', id: value.trim() };
  }
  if (key === 'savedSecretId') return { kind: 'savedSecret', id: value.trim() };
  if (key !== 'secretId') return undefined;
  // Nested operation inputs (notably settings.invoke Voice bindings) carry the canonical shared
  // reference without an input hint. Recognize that value-free namespace here so structured
  // approval entries name the Saved Secret without teaching the generic presenter the operation.
  try {
    if (parseSavedSecretRefV1(value.trim()).kind === 'shared_resource') {
      return { kind: 'savedSecret', id: value.trim() };
    }
  } catch {
    return undefined;
  }
  if (!actionId.startsWith('secrets.')) return undefined;
  try {
    return {
      kind: 'savedSecret',
      id: formatSharedSavedSecretRefV1(value.trim()),
    };
  } catch {
    // An id the reference codec refuses stays literal approval context.
    return undefined;
  }
}

/** An Agent target (a target key or a typed target) read as the Agent it names. */
export function readApprovalAgentReference(value: unknown): ApprovalActionReference | undefined {
  const target = BackendTargetRefV2InputSchema.safeParse(value);
  if (!target.success) return undefined;
  try {
    return { kind: 'agent', id: readBackendTargetRefV2(target.data).backendId };
  } catch {
    // Non-bundled identities are resolved by the host's Agent catalog, not by a protocol registry.
    try {
      const persisted = typeof target.data === 'string' ? parseBackendTargetKeyV2(target.data) : target.data;
      if (persisted.kind === 'agent' && 'identity' in persisted) return { kind: 'agent', id: persisted.definitionId
        ?? `${persisted.identity.pluginId}/${persisted.identity.localId}` };
    } catch { /* Malformed references remain literal approval context. */ }
  }
  return undefined;
}
