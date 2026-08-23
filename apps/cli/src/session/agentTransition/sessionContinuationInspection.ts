import {
  buildBackendTargetKeyV2,
  readBackendTargetRefV2,
  resolveLinkedExternalSessionAuthorityV1,
  type SessionContinuationInspectionRequestV1,
  type SessionContinuationInspectionUnavailableReasonV1,
  type SessionContinuationInspectionV1,
} from '@happier-dev/protocol';
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
  const deps: SessionContinuationInspectionDeps = {
    resolveSessionTransportContext,
    decryptOwnerMetadataView: tryDecryptSessionOwnerMetadataView,
    readAgentCatalogSnapshot,
    resolveCurrentProviderSpawnDefinitiveRejection,
    ...params.deps,
  };

  const transport = await deps.resolveSessionTransportContext({
    credentials: params.credentials,
    idOrPrefix: params.request.sourceSessionId,
  }).catch(() => null);
  if (!transport?.ok) return unavailable('unsupported_session');

  const metadata = deps.decryptOwnerMetadataView({
    credentials: params.credentials,
    rawSession: transport.rawSession,
    accountEncryptionMode: transport.accountEncryptionCurrentness.mode,
  });
  if (!metadata) return unavailable('unsupported_session');

  // Direct/external transcript storage is excluded from in-place continuation:
  // the target cannot consume it canonically. "Hosted here" is a POSITIVE fact
  // the metadata has to prove, so it is read through the discriminated
  // authority owner: a link that exists but cannot be trusted is unresolved,
  // not hosted, and reporting such a Session `available` arms a mutation that
  // stops the source before it can discover the truth.
  const transcriptAuthority = resolveLinkedExternalSessionAuthorityV1(metadata);
  if (!transcriptAuthority.ok || transcriptAuthority.transcriptStorage !== 'persisted') {
    return unavailable('unsupported_session');
  }

  // Deliberately NOT gated on the Session's recorded machine. A machine id is a
  // PROXY for "can this Session be continued here", and the components that
  // actually know already answer it: the stop owner finds no local process and
  // reports it, an absent DEVICE-LOCAL native-return record already degrades to
  // a full replay, the cutover is server-side and machine-agnostic, and
  // activating the target succeeds or fails here loudly. The proxy was wrong in
  // both directions — it refused a Session a user had legitimately moved to this
  // host, while still admitting a same-id Session whose vendor conversation was
  // long gone — so it removed real capability to prevent nothing.

  const targetAgentId = params.request.selection.agentId;
  const target = resolveSessionContinuationTargetAgent({
    readAgentCatalogSnapshot: deps.readAgentCatalogSnapshot,
    agentId: targetAgentId,
  });
  if (!target) {
    return unavailable('target_unavailable');
  }
  const providerPreflight = await deps.resolveCurrentProviderSpawnDefinitiveRejection({
    agentTargetKey: target.backendTargetKey,
    agentId: target.agentId,
    selection: params.request.selection,
  });
  if (!providerPreflight.ok) return unavailable('target_unavailable');

  const currentAgentId = resolveAgentIdFromSessionMetadata(metadata);
  // A Session whose current Agent cannot be named has no authoritative source
  // to transition away from.
  if (currentAgentId === null) return unavailable('unsupported_session');

  return {
    type: 'available',
    protocolVersion: 1,
    sameSessionTransition: currentAgentId !== targetAgentId,
  };
}
