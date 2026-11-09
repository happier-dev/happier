import { SessionFollowUpdateNotificationV1Schema } from '@happier-dev/protocol/activity/webhookPayload';
import type { SessionFollowRuleSourceEvidenceV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowRuleOccurrenceV1';
import type { SessionMetadataPublisherPreconditionV1 } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import { normalizeSessionFollowTerminalSourceOccurrence, readSessionFollowOriginalRoutes } from '@/agent/runtime/session/follow/sessionFollowRuleSourceEvidence';

import { PushNotificationClient } from '@/api/pushNotifications';
import { readAccountIdFromToken } from '@/cloud/decodeJwtPayload';
import { configuration } from '@/configuration';
import type { SessionActivityChangedResult } from '@/daemon/sessions/sessionActivityChangedContract';
import type { StoredCredentials } from '@/persistence';
import { getActiveAccountSettingsSnapshot, getActiveAccountSettingsSnapshotLifetimeToken,
  isActiveAccountSettingsSnapshotLifetimeCurrent } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { createInvocationSavedSecretOperationContextV1 } from '@/settings/secrets/savedSecretOperationContext';
import { dispatchActivityNotificationAsync } from './dispatchActivityNotification';

/** Capture before daemon IPC so a replacement Account cannot inherit an original's fallback. */
export function capturePersonalFollowMessageFallback(params: Readonly<{
  credentials: StoredCredentials | null;
  server: Readonly<{ serverId: string; serverUrl: string }>;
  sessionId: string;
  sourceMessage: Readonly<{ localId: string; seq: number }>;
  sourcePublisher?: SessionMetadataPublisherPreconditionV1;
  evidence: SessionFollowRuleSourceEvidenceV1;
  /** Host-private; only the protected original reader derives this from its receipt. */
  authorAccountId?: string;
  signal: AbortSignal;
  isCurrent: () => Promise<boolean>;
}>): ((result: SessionActivityChangedResult | void) => Promise<void>) | null {
  // Finished originals and foreground requests retain their existing rich sender.
  if (params.evidence.event.kind === 'finished' || params.evidence.event.kind === 'needs_you') return null;
  const credentials = params.credentials;
  if (params.evidence.event.kind === 'person_wrote' && credentials
    && params.authorAccountId === readAccountIdFromToken(credentials.token)) return null;
  const snapshot = getActiveAccountSettingsSnapshot();
  if (!credentials || !snapshot?.scopeKey || snapshot.source === 'none'
    || configuration.activeServerId !== params.server.serverId
    || params.evidence.facts.serverId !== params.server.serverId
    || params.evidence.ownerAccountId !== readAccountIdFromToken(credentials.token)
    || snapshot.scopeKey !== resolveAccountSettingsScopeKey(credentials)) return null;
  const lifetime = { scopeKey: snapshot.scopeKey, lifetimeToken: getActiveAccountSettingsSnapshotLifetimeToken() };
  const isCurrent = async () => !params.signal.aborted
    && configuration.activeServerId === params.server.serverId
    && isActiveAccountSettingsSnapshotLifetimeCurrent(lifetime)
    && await params.isCurrent();
  const operationContext = createInvocationSavedSecretOperationContextV1({ credentials, snapshot,
    readSourceSnapshot: getActiveAccountSettingsSnapshot, serverHttpBaseUrl: params.server.serverUrl, isCurrent });
  return async result => {
    const accepted = result?.personalFollow;
    if (accepted?.accepted === true && accepted.sourceSessionId === params.sessionId
      && accepted.sourceMessage?.localId === params.sourceMessage.localId
      && accepted.sourceMessage.seq === params.sourceMessage.seq) return;
    if (!await isCurrent()) return;
    const terminal = params.evidence.event.kind === 'failed_or_stopped'
      ? params.sourcePublisher && await normalizeSessionFollowTerminalSourceOccurrence({ credentials,
        serverHttpBaseUrl: params.server.serverUrl, signal: params.signal, isCurrent,
        occurrence: { sourceSessionId: params.sessionId, sourceMessage: params.sourceMessage,
          sourcePublisher: params.sourcePublisher, evidence: params.evidence } }) : null;
    if (params.evidence.event.kind === 'failed_or_stopped' && !terminal) return;
    const push = new PushNotificationClient(credentials.token, params.server.serverUrl, params.server.serverId);
    // Unaccepted/missing rule contributions cannot confer private eligibility;
    // the incumbent Activity owner reads ordinary explicit Follow policy itself.
    await dispatchActivityNotificationAsync({ operationContext, settings: operationContext.readSnapshot()?.settings,
      isCurrent, expoPushSender: push, fetchSessionNotificationContext: push.fetchSessionNotificationContext.bind(push),
      readAccountSessionDeliveryMutedScopes: push.readAccountSessionDeliveryMutedScopes.bind(push),
      ...(terminal ? { acceptSourceFollowDelivery: async () => !!await readSessionFollowOriginalRoutes({ credentials,
        serverHttpBaseUrl: params.server.serverUrl, signal: params.signal, isCurrent, occurrence: terminal }) } : {}),
      event: SessionFollowUpdateNotificationV1Schema.parse({ topic: 'follow_update', sessionId: params.sessionId,
        follow: terminal ? { event: terminal.evidence.event, sourceTurn: terminal.sourceTurn }
          : { event: params.evidence.event, sourceMessage: params.sourceMessage } }),
    });
  };
}
