import * as React from 'react';
import { AppShellActionOutputSchemas } from '@happier-dev/protocol/actions/appShellActionFamily';

import type { ActivityAttentionSource } from '@/activity/source/activityAttentionSourceTypes';
import type { SessionBulkActionTarget } from '@/components/sessions/actions/sessionBulkActionTypes';
import { Modal } from '@/modal';
import { buildSessionContextFacts } from '@/sync/domains/session/presentation/sessionContextPresentation';
import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { t } from '@/text';

const executeReadAction = createFrontDoorActionExecute();

export type InboxSessionReadMarking = Readonly<{
  pendingReadKeys: ReadonlySet<string>;
  /** Known unavailable Homes retain rows, but cannot accept a read acknowledgement. */
  readUnavailableReasonBySessionAddress: ReadonlyMap<string, string>;
  markAllReadUnavailableReason: string | null;
  markAllPending: boolean;
  markRead: (targets: readonly SessionBulkActionTarget[]) => Promise<void>;
}>;

/**
 * Marking ready Sessions read through `inbox.mark_all_read`: one exact-address pending ledger, the
 * Homes that cannot take an acknowledgement now, and the error a failed acknowledgement shows. The
 * Inbox model and Home's completed Bots both mark their own targets through this one owner.
 */
export function useInboxSessionReadMarking(
  targets: readonly SessionBulkActionTarget[],
  source: Pick<
    ActivityAttentionSource,
    | 'sessionListHomeObservationByServerId'
    | 'personalSessionListQueryStatesByServerId'
  >,
): InboxSessionReadMarking {
  const [pendingReadKeys, setPendingReadKeys] = React.useState<
    ReadonlySet<string>
  >(() => new Set());
  const pendingReadKeysRef = React.useRef<ReadonlySet<string>>(pendingReadKeys);
  const markAllPending =
    targets.length > 0 &&
    targets.every((target) => pendingReadKeys.has(target.key));
  const readUnavailableReasonBySessionAddress = React.useMemo(() => {
    const reasons = new Map<string, string>();
    const homeReasons = new Map<string, string | null>();
    for (const target of targets) {
      if (!target.serverId) continue;
      if (!homeReasons.has(target.serverId)) {
        const observation =
          source.sessionListHomeObservationByServerId?.[target.serverId];
        const failureReason =
          observation?.failure?.reason ??
          source.personalSessionListQueryStatesByServerId?.[target.serverId]
            ?.failureReason;
        const freshness = buildSessionContextFacts({
          address: { serverId: target.serverId, sessionId: target.sessionId },
          homeObservation: observation,
        }).freshness;
        // A query/response error alone does not withdraw unrelated writes. Reuse
        // only the owner's offline state or its explicitly classified network failure.
        const unavailable =
          observation?.phase === 'offline' ||
          (observation?.phase === 'error' && failureReason === 'network');
        homeReasons.set(target.serverId, unavailable ? freshness.label : null);
      }
      const reason = homeReasons.get(target.serverId);
      if (reason) reasons.set(target.key, reason);
    }
    return reasons;
  }, [
    targets,
    source.sessionListHomeObservationByServerId,
    source.personalSessionListQueryStatesByServerId,
  ]);
  // Bulk acknowledgement is one intent: explain the blocked source rather than partially
  // consuming the other Homes while presenting the whole operation as available.
  const markAllReadUnavailableReason =
    readUnavailableReasonBySessionAddress.values().next().value ?? null;

  const applyPendingReadKeys = React.useCallback(
    (next: ReadonlySet<string>) => {
      pendingReadKeysRef.current = next;
      setPendingReadKeys(next);
    },
    [],
  );

  const markRead = React.useCallback(
    async (requested: readonly SessionBulkActionTarget[]) => {
      if (
        requested.some((target) =>
          readUnavailableReasonBySessionAddress.has(target.key),
        )
      )
        return;
      // A row acknowledgement may still be settling when mark-all is pressed.
      // Filter against the shared ledger so an exact Home address is submitted once.
      const pending = requested.filter(
        (target) => !pendingReadKeysRef.current.has(target.key),
      );
      if (pending.length === 0) return;
      const requestedKeys = new Set(pending.map((target) => target.key));
      applyPendingReadKeys(
        new Set([...pendingReadKeysRef.current, ...requestedKeys]),
      );
      try {
        const outcome = await executeReadAction(
          'inbox.mark_all_read',
          {
            targets: pending.map(({ serverId, sessionId }) => ({
              serverId,
              sessionId,
            })),
          },
          {
            surface: 'ui',
            authority: 'present_user',
          },
        );
        if (!outcome.ok) throw new Error(outcome.errorCode ?? 'unavailable');
        const result = AppShellActionOutputSchemas['inbox.mark_all_read'].parse(
          outcome.result,
        );
        if (result.results.some(({ status }) => status === 'failed')) {
          Modal.alert(
            t('common.error'),
            t('sessionInfo.failedToMarkSessionRead'),
          );
        }
      } catch {
        Modal.alert(
          t('common.error'),
          t('sessionInfo.failedToMarkSessionRead'),
        );
      } finally {
        const next = new Set(pendingReadKeysRef.current);
        for (const key of requestedKeys) next.delete(key);
        applyPendingReadKeys(next);
      }
    },
    [applyPendingReadKeys, readUnavailableReasonBySessionAddress],
  );

  return React.useMemo(
    () => ({
      pendingReadKeys,
      readUnavailableReasonBySessionAddress,
      markAllReadUnavailableReason,
      markAllPending,
      markRead,
    }),
    [
      pendingReadKeys,
      readUnavailableReasonBySessionAddress,
      markAllReadUnavailableReason,
      markAllPending,
      markRead,
    ],
  );
}
