import { isSessionRuntimeRunning } from '@/sync/domains/session/attention/runtimePresentation';
import * as React from 'react';
import { useShallow } from 'zustand/react/shallow';
import type { SessionQuestionHandlerV1 } from '@happier-dev/protocol/sessions/permissions/v1';
import type { SessionQuestionContextV1 } from '@happier-dev/protocol/sessions/permissions/questionV1';
import { readSessionManagerSessionIdV1 } from '@happier-dev/protocol/sessions/follow/sessionManagerV1';

import { getStorage } from '@/sync/domains/state/storageStore';
import { useServerProfilesGeneration } from '@/hooks/server/useServerProfilesGeneration';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { captureServerProfileScopeResolver } from '@/sync/domains/server/serverProfiles';
import { selectHomeQualifiedSession } from '@/sync/domains/session/selectHomeQualifiedSession';
import { readSessionListRowForServerId } from '@/sync/domains/session/listing/sessionListRowStateLookup';
import { readSessionWorkerQuestionHandlingProjection } from '@/sync/domains/session/listing/sessionListRenderable';
import { useKnownAccountActor } from '@/components/account/useKnownAccountActor';
import { getSessionName } from '@/utils/sessions/sessionUtils';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import { createSessionListPresentationSource } from '@/sync/domains/session/listing/sessionListRenderableSessionProjection';
import { hasAuthoritativeSessionRouteData, isHydratedSessionCurrentForListState } from '@/sync/domains/session/hasAuthoritativeSessionRouteData';
import { readSessionFullPublicationUpdatedAt } from '@/sync/domains/session/sessionRuntimeObservation';
import { isSessionAccessRecipient } from '@/sync/engine/sessions/normalizeSessionAccessProjection';
import { useHydrateSession } from '@/hooks/session/useHydrateSessionForRoute';
import { useSessionDisplayNameSource } from '@/sync/store/hooks';
import { resolveAskUserQuestionAnsweredByLabel, type AskUserQuestionHandler } from './askUserQuestionCardState';

/** Uses only the applied Home's already-authorized Account/profile projection. */
export function useAskUserQuestionAnsweredByLabel(answeredBy: SessionQuestionHandlerV1 | undefined, serverId: string | null): string | null {
  // A completed answer needs only its actor's display name, never role/stop metadata.
  const session = useSessionDisplayNameSource(answeredBy?.kind === 'session' && serverId ? answeredBy.sessionId : '', serverId);
  const { viewerScope, actor } = useKnownAccountActor(serverId, answeredBy?.kind === 'person' ? answeredBy.accountId : undefined);
  return resolveAskUserQuestionAnsweredByLabel({ answeredBy, serverId: viewerScope?.serverId ?? serverId, viewerScope, answeringAccountActor: actor,
    answeringSession: answeredBy?.kind === 'session' && session
      ? { sessionId: answeredBy.sessionId, name: getSessionName(session, serverId ?? undefined) } : undefined });
}

/**
 * The question's manager as a name + reachability, using scoped row-local subscriptions.
 * A person-handled question can explain its stopped/offline manager through the existing relation;
 * that display read never changes the request's handler or makes a resumed manager its handler.
 */
export function useAskUserQuestionHandler(
  handler: SessionQuestionHandlerV1 | undefined,
  serverId: string | null,
  source?: Readonly<{ sessionId: string; questionV1: SessionQuestionContextV1 }>,
): AskUserQuestionHandler | null {
  const explainUnavailableManager = handler?.kind === 'person' && source?.questionV1.lasting === false;
  useServerProfilesGeneration();
  const resolveScopeId = captureServerProfileScopeResolver();
  const activeServerId = useActiveServerSnapshot(Boolean(serverId)).serverId;
  const manager = getStorage()(useShallow((state) => {
    if (!serverId) return null;
    const sourceRow = explainUnavailableManager
      ? readSessionListRowForServerId(state.sessionListRowsByServerId, serverId, source.sessionId, resolveScopeId) : null;
    const sourceFull = explainUnavailableManager
      ? selectHomeQualifiedSession(state, source.sessionId, serverId, activeServerId) : null;
    const sourceSession = sourceRow ? createSessionListPresentationSource(sourceRow, {
      serverId, baseSession: sourceFull ?? undefined,
    }).relations : sourceFull;
    const handlerSessionId = handler?.kind === 'session' ? handler.sessionId : readSessionManagerSessionIdV1(sourceSession);
    if (!handlerSessionId) return null;
    const row = readSessionListRowForServerId(state.sessionListRowsByServerId, serverId, handlerSessionId, resolveScopeId);
    const held = selectHomeQualifiedSession(state, handlerSessionId, serverId, activeServerId);
    const admitted = row ? createSessionListPresentationSource(row, { serverId, baseSession: held ?? undefined }).baseSession : held;
    const full = admitted && hasAuthoritativeSessionRouteData(admitted)
      && (!row || isHydratedSessionCurrentForListState(admitted, () => row,
        readSessionFullPublicationUpdatedAt(admitted))) ? admitted : null;
    // Display custody and retained row presentation cannot establish private
    // role/stop facts. Only the current genuine full publication can do that.
    const handling = full ? readSessionWorkerQuestionHandlingProjection(readSessionOwnerMetadataView(full)) : null;
    const session = row ?? full;
    const recipient = isSessionAccessRecipient(session?.access, session?.accessLevel);
    const availability: AskUserQuestionHandler['availability'] = handling?.explicitlyStopped
      ? 'stopped' : session && isSessionRuntimeRunning(session) ? 'online' : 'offline';
    return { sessionId: handlerSessionId, needsFull: !full && !recipient,
      name: session ? getSessionName(session, serverId) : null, availability,
      show: Boolean(session && (handling || recipient)
        && (!explainUnavailableManager || (handling?.answersWorkerQuestions && availability !== 'online'))) };
  }));
  // This is metadata demand, not a visible transcript or live-content subscription.
  useHydrateSession(manager?.needsFull ? manager.sessionId : '', 'question-card.manager', {
    ...(serverId ? { serverId } : {}), hydrateMessages: false, includeTurnsProjection: false,
  });
  return React.useMemo(() => manager?.show && manager.name !== null
    ? { name: manager.name, availability: manager.availability } : null,
  [manager?.show, manager?.name, manager?.availability]);
}
