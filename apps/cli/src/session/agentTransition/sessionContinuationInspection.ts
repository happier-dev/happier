import { buildBackendTargetKeyV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { readBackendTargetRefV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { resolveLinkedExternalSessionAuthorityV1 } from '@happier-dev/protocol/sessions/external/linked-metadata';
import type { SessionAgentTransitionSelectionV1, SessionContinuationInspectionBatchRequestV1, SessionContinuationInspectionBatchResultV1, SessionContinuationInspectionRequestV1, SessionContinuationInspectionUnavailableReasonV1, SessionContinuationInspectionV1 } from '@happier-dev/protocol';
import { resolveAgentIdFromSessionMetadata, type AgentId } from '@happier-dev/agents';

import { readAgentCatalogSnapshot } from '@/agent/catalog/snapshot';
import type { StoredCredentials } from '@/persistence';
import { readAgentSessionCapabilities } from '@/plugins/projection/registry/agentContributionDefinition';
import { resolveSessionTransportContext } from '@/session/services/resolveSessionTransportContext';
import { tryDecryptSessionOwnerMetadataView } from '@/session/transport/encryption/sessionEncryptionContext';
import { resolveCurrentProviderSpawnDefinitiveRejection } from '@/providers/spawn/currentDefinitiveRejection';

/**
 * Live continuation eligibility for one exact selection on THIS machine.
 *
 * It projects the same underlying catalog and lifecycle checks the mutation
 * revalidates. It grants no authority, persists nothing, and adds no
 * availability cache: a stale `available` cannot cause an effect because the
 * final mutation re-proves every fact.
 */

export type SessionContinuationInspectionDeps = Readonly<{
  resolveSessionTransportContext: typeof resolveSessionTransportContext;
  decryptOwnerMetadataView: typeof tryDecryptSessionOwnerMetadataView;
  readAgentCatalogSnapshot: typeof readAgentCatalogSnapshot;
  resolveCurrentProviderSpawnDefinitiveRejection:
    typeof resolveCurrentProviderSpawnDefinitiveRejection;
}>;

export type InspectSessionContinuationParams = Readonly<{
  credentials: StoredCredentials;
  request: SessionContinuationInspectionRequestV1;
  deps?: Partial<SessionContinuationInspectionDeps>;
}>;

export type SessionContinuationTargetAgent = Readonly<{
  agentId: AgentId;
  backendTargetKey: string;
}>;

/**
 * The single daemon-side answer to "can this selection become the Session's
 * Agent on THIS machine?".
 *
 * Both transition entry points ask it here rather than each inlining the same
 * decision: a target reported switchable by the inspection must never then be
 * refused — or worse, refused only at activation, after the source is already
 * stopped — by the mutation. Two copies of one decision drift,
 * and this one drifted: each entry point checked catalog identity and backend
 * representability, and neither checked whether the Agent has a Sessions
 * surface at all.
 *
 * Catalog membership does not imply it. `AGENT_IDS` is generated from every
 * bundled Agent, and two of them — `deepsec` and `coderabbit` — declare
 * `primary: 'executionRuns'` with no `capabilities.sessions`. Such an Agent is a
 * current, identified, representable contribution that can be named directly on
 * the open wire, so it passed both gates and failed only when the target was
 * activated, by which point the source runtime was gone.
 *
 * The declaration is the whole fact, read through the canonical
 * {@link readAgentSessionCapabilities} owner rather than a second capability
 * concept or an id allowlist. An Agent whose primary surface is execution runs
 * genuinely has no Sessions capability to read, so this fails closed for exactly
 * the Agents that cannot host a Session and for no others. The UI's own
 * projected-capability check stays presentation: it decides what to offer, this
 * decides what the daemon will do.
 */
export function resolveSessionContinuationTargetAgent(params: Readonly<{
  readAgentCatalogSnapshot: typeof readAgentCatalogSnapshot;
  agentId: string;
}>): SessionContinuationTargetAgent | null {
  const contribution = params.readAgentCatalogSnapshot().agentDefinitionsById.get(params.agentId);
  if (!contribution?.identity) return null;
  if (!readAgentSessionCapabilities(contribution.richDefinition?.definition)) return null;
  try {
    return {
      agentId: contribution.id as AgentId,
      backendTargetKey: buildBackendTargetKeyV2(
        readBackendTargetRefV2({ kind: 'backend', backendId: contribution.id, sourceKind: 'built_in' }),
      ),
    };
  } catch {
    return null;
  }
}

function unavailable(
  reason: SessionContinuationInspectionUnavailableReasonV1,
): SessionContinuationInspectionV1 {
  return { type: 'unavailable', reason };
}

export async function inspectSessionContinuation(
  params: InspectSessionContinuationParams,
): Promise<SessionContinuationInspectionV1> {
  const result = await inspectSessionContinuations({
    credentials: params.credentials,
    request: {
      v: 1,
      sourceSessionId: params.request.sourceSessionId,
      selections: [params.request.selection],
    },
    ...(params.deps ? { deps: params.deps } : {}),
  });
  return result.inspections[0] ?? unavailable('unsupported_session');
}

type SessionContinuationSource =
  | Readonly<{ type: 'available'; sourceAgentId: string }>
  | Readonly<{ type: 'unavailable'; reason: 'unsupported_session' }>;

async function loadSessionContinuationSource(params: Readonly<{
  credentials: StoredCredentials;
  sourceSessionId: string;
  deps: SessionContinuationInspectionDeps;
}>): Promise<SessionContinuationSource> {
  const transport = await params.deps.resolveSessionTransportContext({
    credentials: params.credentials,
    idOrPrefix: params.sourceSessionId,
  }).catch(() => null);
  if (!transport?.ok) return { type: 'unavailable', reason: 'unsupported_session' };

  const metadata = params.deps.decryptOwnerMetadataView({
    credentials: params.credentials,
    rawSession: transport.rawSession,
    accountEncryptionMode: transport.accountEncryptionCurrentness.mode,
  });
  if (!metadata) return { type: 'unavailable', reason: 'unsupported_session' };

  // Direct/external transcript storage is excluded from in-place continuation:
  // the target cannot consume it canonically. Hosted here is a positive fact
  // the metadata has to prove, so an unresolved link is not treated as hosted.
  const transcriptAuthority = resolveLinkedExternalSessionAuthorityV1(metadata);
  if (!transcriptAuthority.ok || transcriptAuthority.transcriptStorage !== 'persisted') {
    return { type: 'unavailable', reason: 'unsupported_session' };
  }

  // The recorded machine is deliberately not a proxy gate. The stop owner,
  // native-return owner, cutover, and activation each validate the facts they
  // actually own, including Sessions legitimately moved to this host.
  const sourceAgentId = resolveAgentIdFromSessionMetadata(metadata);
  if (sourceAgentId === null) return { type: 'unavailable', reason: 'unsupported_session' };
  return { type: 'available', sourceAgentId };
}

async function inspectSessionContinuationSelection(params: Readonly<{
  source: SessionContinuationSource;
  selection: SessionAgentTransitionSelectionV1;
  deps: SessionContinuationInspectionDeps;
}>): Promise<SessionContinuationInspectionV1> {
  if (params.source.type === 'unavailable') return params.source;

  const target = resolveSessionContinuationTargetAgent({
    readAgentCatalogSnapshot: params.deps.readAgentCatalogSnapshot,
    agentId: params.selection.agentId,
  });
  if (!target) return unavailable('target_unavailable');

  const providerPreflight = await params.deps.resolveCurrentProviderSpawnDefinitiveRejection({
    agentTargetKey: target.backendTargetKey,
    agentId: target.agentId,
    selection: params.selection,
  });
  if (!providerPreflight.ok) return unavailable('target_unavailable');

  return {
    type: 'available',
    protocolVersion: 1,
    sameSessionTransition: params.source.sourceAgentId !== params.selection.agentId,
  };
}

/**
 * Resolves one ordered Agent-picker projection from one source Session read and
 * decrypt. Target-specific Provider checks remain owned by the same mutation
 * preflight, and run only after the shared source proves usable.
 */
export async function inspectSessionContinuations(params: Readonly<{
  credentials: StoredCredentials;
  request: SessionContinuationInspectionBatchRequestV1;
  deps?: Partial<SessionContinuationInspectionDeps>;
}>): Promise<SessionContinuationInspectionBatchResultV1> {
  const deps: SessionContinuationInspectionDeps = {
    resolveSessionTransportContext,
    decryptOwnerMetadataView: tryDecryptSessionOwnerMetadataView,
    readAgentCatalogSnapshot,
    resolveCurrentProviderSpawnDefinitiveRejection,
    ...params.deps,
  };
  const source = await loadSessionContinuationSource({
    credentials: params.credentials,
    sourceSessionId: params.request.sourceSessionId,
    deps,
  });
  return {
    v: 1,
    inspections: await Promise.all(params.request.selections.map(async (selection) => (
      await inspectSessionContinuationSelection({ source, selection, deps })
    ))),
  };
}
