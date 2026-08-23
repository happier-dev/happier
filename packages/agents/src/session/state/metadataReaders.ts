import type { PermissionIntent } from '../../types.js';
import {
  parseBackendTargetKeyV2,
} from '@happier-dev/protocol/plugins/agents';
import {
  SessionModelSelectionIntentV1Schema,
  readSessionModelSelectionIntentSourceV1,
  resolveSessionModelSelectionIntentV1,
  type ProviderBoundModelRef,
  type SessionModelSelectionIntentV1,
} from '@happier-dev/protocol/providers/model-selection';
import {
  readExactSessionActiveModelSelectionV1,
} from '@happier-dev/protocol/providers/active-model-selection';
import { readSessionProviderBindingMetadataStateV1 } from '@happier-dev/protocol';
import {
  readPermissionModeIntentFromMetadata,
  readStringOverrideIntentFromMetadata,
} from './bindings/intent.js';
import { MODEL_OVERRIDE_KEY, MODEL_SELECTION_INTENT_KEY } from './bindings/metadataKeys.js';

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/**
 * Returns model selection only when the Protocol owner proves it against the
 * exact current physical runner and, for Provider-bound selections, the exact
 * applied binding. Persisted intent and fallback catalogs are excluded.
 */
export function readActiveSessionModelSelectionFromMetadata(
  metadata: unknown,
  agentTargetKey: string,
  currentRunnerProcessIdentity: Readonly<{
    pid: number;
    processStartTimeMs: number;
  }> | null,
): ProviderBoundModelRef | null {
  const record = asRecord(metadata);
  if (!record) return null;

  let targetAgentId: string;
  try {
    targetAgentId = parseBackendTargetKeyV2(agentTargetKey).backendId;
  } catch {
    return null;
  }

  return readExactSessionActiveModelSelectionV1({
    metadata: record,
    agentId: targetAgentId,
    agentTargetKey,
    currentRunnerProcessIdentity,
  })?.selection ?? null;
}

/** Resolve canonical and deployed model intent once the session's canonical target is known. */
export function resolveModelSelectionIntentFromSessionMetadata(
  metadata: unknown,
  agentTargetKey: string,
): SessionModelSelectionIntentV1 | null {
  const obj = asRecord(metadata);
  if (!obj) return null;
  return resolveSessionModelSelectionIntentV1({
    canonical: obj[MODEL_SELECTION_INTENT_KEY],
    legacy: obj[MODEL_OVERRIDE_KEY],
    agentTargetKey,
  });
}

/** The ambient Provider connection a Session can prove, or its refusal to guess. */
export type AmbientProviderConnectionForModelIntent = Readonly<
  | { status: 'resolved'; providerConnectionId: string | null }
  | {
      status: 'unreadable';
      code: 'model_selection_session_provider_state_unreadable';
    }
>;

const AMBIENT_PROVIDER_CONNECTION_UNREADABLE: AmbientProviderConnectionForModelIntent =
  Object.freeze({
    status: 'unreadable',
    code: 'model_selection_session_provider_state_unreadable',
  });

function resolvedAmbientProviderConnection(
  providerConnectionId: string | null,
): AmbientProviderConnectionForModelIntent {
  return Object.freeze({ status: 'resolved', providerConnectionId });
}

/**
 * The Provider connection a model intent means when the caller named a model id
 * WITHOUT naming a connection.
 *
 * A model id alone is not a complete selection: the same id can exist in an
 * Agent's native catalog and in several Provider connections. The only owner
 * that can complete it is the Session itself, so this is the one place that
 * decides, and both `session.model.set` and `session.message.send` consume it
 * rather than each re-deriving the rule and drifting apart.
 *
 * An ACTIVE Session is answered by the binding actually applied to its running
 * runner; an inactive one by its persisted intent. A Session with neither is
 * native, which is also what a Provider-less Session's model id has always
 * meant. Callers that DID name a connection (including an explicit `null` for
 * "native") must not call this — an explicit choice is never overridden by
 * ambient state.
 *
 * Absent state and unreadable state are different answers. A Session with no
 * binding and no persisted intent is native; a Session whose binding or
 * canonical intent is PRESENT but does not parse cannot say what it means, and
 * is refused rather than silently reported as an explicit native selection.
 */
export function resolveAmbientProviderConnectionForModelIntent(input: Readonly<{
  metadata: unknown;
  agentTargetKey: string;
  sessionActive: boolean;
}>): AmbientProviderConnectionForModelIntent {
  const record = asRecord(input.metadata);
  if (!record) return resolvedAmbientProviderConnection(null);
  if (input.sessionActive) {
    const binding = readSessionProviderBindingMetadataStateV1(record);
    if (binding.kind === 'invalid') return AMBIENT_PROVIDER_CONNECTION_UNREADABLE;
    return resolvedAmbientProviderConnection(
      binding.kind === 'valid' ? binding.binding.connectionId : null,
    );
  }
  const source = readSessionModelSelectionIntentSourceV1({
    canonical: record[MODEL_SELECTION_INTENT_KEY],
    legacy: record[MODEL_OVERRIDE_KEY],
  });
  if (source.status === 'invalid') return AMBIENT_PROVIDER_CONNECTION_UNREADABLE;
  return resolvedAmbientProviderConnection(
    resolveModelSelectionIntentFromSessionMetadata(record, input.agentTargetKey)
      ?.selection?.providerConnectionId ?? null,
  );
}

/**
 * Whether the Session's persisted model intent binds it to a model Provider
 * connection.
 *
 * Agent-native fork is impossible for such a Session: the fork lifecycle owner
 * refuses every non-replay strategy so Provider authorization completes before
 * any vendor-side fork side effect. The UI must not offer a Native card that can
 * only ever be refused, so the daemon gate and the card gate read this one fact
 * instead of each deriving it from raw metadata.
 *
 * Unlike `resolveModelSelectionIntentFromSessionMetadata` this needs no agent
 * target key. Only the canonical carrier is consulted, and that is complete:
 * `modelOverrideV1` cannot express a connection at all, and the shared effective-
 * source rule already gives a Provider-bound canonical selection priority over
 * any legacy override however recent.
 */
export function isProviderBoundSessionMetadata(metadata: unknown): boolean {
  const record = asRecord(metadata);
  if (!record) return false;
  const parsed = SessionModelSelectionIntentV1Schema.safeParse(record[MODEL_SELECTION_INTENT_KEY]);
  if (!parsed.success) {
    // An intent that declares a connection but does not parse is still evidence
    // of binding; treating it as unbound would offer the refused Native route.
    const selection = asRecord(asRecord(record[MODEL_SELECTION_INTENT_KEY])?.selection);
    const connectionId = selection?.providerConnectionId;
    return typeof connectionId === 'string' && connectionId.trim().length > 0;
  }
  return parsed.data.selection?.providerConnectionId != null;
}

/**
 * Resolve the canonical permission intent from a session metadata snapshot.
 *
 * This is shared across UI/CLI so that legacy aliases and persistence rules stay consistent.
 */
export function resolvePermissionIntentFromSessionMetadata(
  metadata: unknown,
): { intent: PermissionIntent; updatedAt: number } | null {
  const obj = asRecord(metadata);
  if (!obj) return null;

  const value = readPermissionModeIntentFromMetadata(obj);
  return value ? { intent: value.permissionMode as PermissionIntent, updatedAt: value.updatedAt } : null;
}

/**
 * Resolve a nested `{ v: 1, updatedAt, <valueKey>: string }` override from session metadata.
 *
 * Used for fields like:
 * - `metadata.modelOverrideV1 = { v: 1, updatedAt, modelId }`
 * - `metadata.acpSessionModeOverrideV1 = { v: 1, updatedAt, modeId }`
 */
export function resolveMetadataStringOverrideV1(
  metadata: unknown,
  overrideKey: string,
  valueKey: string,
): { value: string; updatedAt: number } | null {
  const obj = asRecord(metadata);
  if (!obj) return null;

  if (overrideKey === MODEL_OVERRIDE_KEY && valueKey === 'modelId') {
    // This generic string helper is a deployed-legacy reader only. Canonical provider-bound
    // selections require a known agent target and are resolved through the structured reader.
    const value = readStringOverrideIntentFromMetadata({
      metadata: obj,
      overrideKey,
      valueKey,
    });
    return typeof value?.value === 'string' && value.value.trim()
      ? { value: value.value.trim(), updatedAt: value.updatedAt }
      : null;
  }

  const value = readStringOverrideIntentFromMetadata({
    metadata: obj,
    overrideKey,
    valueKey,
  });
  return value && value.value !== null ? { value: value.value, updatedAt: value.updatedAt } : null;
}
