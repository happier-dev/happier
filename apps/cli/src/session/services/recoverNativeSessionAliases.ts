import { resolveProviderSessionIdForBackendTarget } from '@happier-dev/agents';
import { NativeSessionAliasesV1Schema, type NativeSessionAliasAssignmentV1 } from '@happier-dev/protocol';
import type { Credentials } from '@/persistence';
import { mergeNativeSessionAliases, parseNativeSessionAliasRegistration } from '@/session/metadata/nativeSessionAliases';
import { updateSessionMetadataWithRetry } from '@/session/metadata/updateSessionMetadataWithRetry';
import { tryDecryptSessionMetadata } from '@/session/transport/encryption/sessionEncryptionContext';
import { fetchSessionsPage, type RawSessionListRow } from '@/session/transport/http/sessionsHttp';

export type RecoverNativeSessionAliasesInput = Readonly<{
  assignments: readonly NativeSessionAliasAssignmentV1[];
  machineId?: string;
  dryRun?: boolean;
}>;

/** Caller-supplied, sanitised registrations require their original observation time. */
export function readNativeSessionAliasSnapshot(snapshot: unknown, providerId: string, observedAt: number): NativeSessionAliasAssignmentV1[] {
  if (!snapshot || typeof snapshot !== 'object' || !('registrations' in snapshot) || !Array.isArray(snapshot.registrations)) {
    throw new Error('Expected a snapshot with a registrations array');
  }
  return snapshot.registrations.map((value: unknown) => {
    const assignment = parseNativeSessionAliasRegistration(value, providerId, observedAt);
    if (!assignment) throw new Error('Invalid alias registration or observation time');
    return assignment;
  });
}

export async function recoverNativeSessionAliases(params: RecoverNativeSessionAliasesInput & Readonly<{ credentials: Credentials }>) {
  if (params.assignments.some(assignment => assignment.observedAt > Date.now())) {
    throw new Error('Invalid alias observation time: future observations cannot establish assignment evidence');
  }
  const candidates: { raw: RawSessionListRow; metadata: Record<string, unknown> }[] = [];
  // Uniqueness is an account-wide claim: never write from a partial first page.
  for (const archivedOnly of [false, true]) {
    let cursor: string | undefined;
    const cursors = new Set<string>();
    while (true) {
      const page = await fetchSessionsPage({ token: params.credentials.token, archivedOnly, ...(cursor ? { cursor } : {}) });
      for (const raw of page.sessions) {
        const value = tryDecryptSessionMetadata({ credentials: params.credentials, rawSession: raw });
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
          throw Object.assign(new Error('Incomplete session catalog: unreadable session metadata prevents proving alias identity uniqueness'), { code: 'unsupported' });
        }
        const metadata = value as Record<string, unknown>;
        if (params.machineId && metadata.machineId !== params.machineId) continue;
        candidates.push({ raw, metadata });
      }
      if (!page.hasNext) break;
      if (!page.nextCursor || cursors.has(page.nextCursor)) throw new Error('Incomplete session catalog');
      cursors.add(page.nextCursor);
      cursor = page.nextCursor;
    }
  }
  const recovered: Array<NativeSessionAliasAssignmentV1 & { sessionId: string; title: string | null }> = [];
  const unresolved: Array<{ alias: string; providerId: string; providerSessionId: string; reason: string }> = [];
  for (const assignment of params.assignments) {
    const identityMatches = (metadata: Record<string, unknown>) => (!params.machineId || metadata.machineId === params.machineId)
      && resolveProviderSessionIdForBackendTarget({ kind: 'builtInAgent', agentId: assignment.providerId }, metadata) === assignment.providerSessionId;
    const matches = candidates.filter(candidate => identityMatches(candidate.metadata));
    const targets = [...new Map(matches.map(candidate => [candidate.raw.id, candidate])).values()];
    const unresolvedEntry = (reason: string) => ({ alias: assignment.alias, providerId: assignment.providerId, providerSessionId: assignment.providerSessionId, reason });
    if (targets.length !== 1) {
      unresolved.push(unresolvedEntry(targets.length ? 'ambiguous' : 'not_found'));
      continue;
    }
    const target = targets[0];
    if (target.metadata.nativeSessionAliasesV1 !== undefined && !NativeSessionAliasesV1Schema.safeParse(target.metadata.nativeSessionAliasesV1).success) {
      unresolved.push(unresolvedEntry('unsupported_history'));
      continue;
    }
    let metadata = target.metadata;
    let identityChanged = false;
    if (!params.dryRun) {
      const updated = await updateSessionMetadataWithRetry({
        token: params.credentials.token, credentials: params.credentials, sessionId: target.raw.id, rawSession: target.raw,
        updater: current => {
          // Compare again on every conflict retry, preserving a concurrent provider cutover.
          if (!identityMatches(current)) { identityChanged = true; return current; }
          return mergeNativeSessionAliases(current, [assignment]);
        },
      });
      metadata = updated.metadata;
    }
    if (identityChanged) { unresolved.push(unresolvedEntry('identity_changed')); continue; }
    // Unknown history versions introduced concurrently must also fail closed.
    if (metadata.nativeSessionAliasesV1 !== undefined && !NativeSessionAliasesV1Schema.safeParse(metadata.nativeSessionAliasesV1).success) {
      unresolved.push(unresolvedEntry('unsupported_history'));
      continue;
    }
    const summary = metadata.summary;
    const summaryTitle = summary && typeof summary === 'object' && 'text' in summary && typeof summary.text === 'string' ? summary.text.trim() : '';
    const title = summaryTitle || (typeof metadata.name === 'string' ? metadata.name.trim() : '') || null;
    recovered.push({ ...assignment, sessionId: target.raw.id, title });
  }
  return { recovered, unresolved, dryRun: params.dryRun === true };
}
