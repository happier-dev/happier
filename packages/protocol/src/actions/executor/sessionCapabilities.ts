import {
  resolveCapabilityApplyTimingV1, type CapabilityApplyTimingInputV1,
} from '../../reach/capabilityApplyTimingV1.js';
import {
  readSessionCapabilitySelectionFromMetadataV1, writeSessionCapabilitySelectionToMetadataV1,
} from '../../reach/sessionCapabilityMetadataV1.js';
import type { SessionCapabilitiesGetOutputV1, SessionCapabilitiesSetInputV1, SessionCapabilitiesSetOutputV1 } from '../specs/sessionCapabilities.js';
import { isMachineRpcTimeoutError, readRpcErrorCode } from '../../rpc/errors.js';
import type { ActionExecutorContext } from './types.js';
import { withActionFailureCauseDiagnostic } from './actionFailureDiagnostic.js';
import { areSessionCapabilitySelectionsEquivalentV1, readSessionCapabilityOverrideV1, setSessionCapabilitySelectionItemV1 } from '../../reach/sessionCapabilitySelectionV1.js';
import { createActionRefusalDetailsV1 } from '../actionRefusalDiagnostic.js';

export type SessionCapabilitiesActionSnapshotV1 = Readonly<{
  metadata: object; sessionRunning: boolean;
  agent: CapabilityApplyTimingInputV1['agent']; launchRestart: CapabilityApplyTimingInputV1['launchRestart'];
}>;
export type SessionCapabilitiesActionPortV1 = Readonly<{
  readSession: (input: Readonly<{ sessionId: string; serverId?: string }>, context: ActionExecutorContext) => Promise<SessionCapabilitiesActionSnapshotV1 | null>;
  resolveItem: (input: Readonly<{ kind: SessionCapabilitiesSetInputV1['kind']; id: string; sessionId: string; serverId?: string }>, context: ActionExecutorContext) => Promise<string | null>;
  writeMetadata: (input: Readonly<{ sessionId: string; serverId?: string; update: (metadata: object) => object }>, context: ActionExecutorContext) => Promise<'updated' | 'conflict'>;
}>;

/** A preview deadline says nothing about whether its Session still exists. */
export function resolveSessionCapabilitiesGetFailureV1(error: unknown): Extract<SessionCapabilitiesGetOutputV1, { ok: false }> {
  const code = error && typeof error === 'object' ? Reflect.get(error, 'errorCode') ?? Reflect.get(error, 'code') : undefined;
  return { ok: false, code: isMachineRpcTimeoutError(error) || readRpcErrorCode(error) === 'RPC_REQUEST_TIMEOUT'
    || code === 'RPC_REQUEST_TIMEOUT' ? 'preview_timeout' : 'session_unavailable' };
}

/** Opaque ids win over display names; a duplicate name must never pick an arbitrary item. */
export function resolveSessionCapabilityItemIdentityV1(items: readonly Readonly<{ id: string; name: string }>[], idOrName: string): string | null {
  const exact = items.find(item => item.id === idOrName);
  if (exact) return exact.id;
  const named = items.filter(item => item.name === idOrName);
  return named.length === 1 ? named[0]!.id : null;
}

/** All Session include/exclude writes, including D26 creates, use this operation and the metadata codec. */
export async function setSessionCapabilityV1(input: Readonly<{
  port: SessionCapabilitiesActionPortV1; request: SessionCapabilitiesSetInputV1; context: ActionExecutorContext;
}>): Promise<SessionCapabilitiesSetOutputV1> {
  const { port, request, context } = input;
  const address = { sessionId: request.sessionId, ...(context.serverId ? { serverId: context.serverId } : {}) };
  let snapshot: SessionCapabilitiesActionSnapshotV1 | null;
  try { snapshot = await port.readSession(address, context); }
  catch (error) {
    context.signal?.throwIfAborted();
    return withActionFailureCauseDiagnostic({ ok: false as const, code: 'session_unavailable' as const }, error, 'session.capabilities.read');
  }
  if (!snapshot) return { ok: false, ...createActionRefusalDetailsV1('not_found', 'session_absent') };
  const applyTiming = resolveCapabilityApplyTimingV1({ kind: request.kind, sessionRunning: snapshot.sessionRunning,
    agent: snapshot.agent, launchRestart: snapshot.launchRestart });
  if (applyTiming.t === 'new_sessions_only') return { ok: false, code: 'applies_to_new_sessions_only' };
  let id: string | null;
  try { id = await port.resolveItem({ ...address, kind: request.kind, id: request.id }, context); }
  catch (error) {
    context.signal?.throwIfAborted();
    return withActionFailureCauseDiagnostic({ ok: false as const, code: 'session_unavailable' as const }, error, 'session.capabilities.resolve');
  }
  if (!id) return { ok: false, ...createActionRefusalDetailsV1('not_found', 'capability_identity_unresolved') };
  const current = readSessionCapabilitySelectionFromMetadataV1(snapshot.metadata);
  const previous = readSessionCapabilityOverrideV1(current, request.kind, id);
  const written = await port.writeMetadata({ ...address, update: metadata => {
    const latest = readSessionCapabilitySelectionFromMetadataV1(metadata);
    // Runtime acknowledgments may advance the tuple while identity resolution is pending.
    // Preserve those fields, but never overwrite an intervening desired-selection edit.
    if (!areSessionCapabilitySelectionsEquivalentV1(current, latest)) {
      throw Object.assign(new Error('Session capability selection changed'), { code: 'conflict' });
    }
    const selection = setSessionCapabilitySelectionItemV1(latest, request.kind, id, request.state);
    return writeSessionCapabilitySelectionToMetadataV1(metadata,
      request.kind === 'mcp_server' ? { mcp: selection.mcp } : { skills: selection.skills }, { sessionActive: snapshot.sessionRunning });
  } }, context);
  return written === 'conflict' ? { ok: false, code: 'conflict' }
    : { ok: true, state: request.state, previous, applyTiming };
}
