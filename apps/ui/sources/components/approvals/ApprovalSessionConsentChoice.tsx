import * as React from 'react';

import type { ActionApprovalScopeV1 } from '@happier-dev/protocol/actions/actionSettings';
import type { SessionApprovalConsentModeChangeV1 } from '@happier-dev/protocol/actions/sessionApprovalConsentsV1';

import { useSessionConsentScopeName } from '@/components/sessions/permissions/SessionAllowedActionsSection';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SegmentedChoiceItem } from '@/components/ui/lists/SegmentedChoiceItem';
import { SurfaceFreshnessLine } from '@/components/ui/surfaces/SurfaceFreshnessLine';
import { useSessionApprovalConsents } from '@/hooks/approvals/useSessionApprovalConsents';
import type { SessionAddress } from '@/sync/domains/session/sessionAddress';
import { t } from '@/text';

/** What happens the next time this Action asks in this Session. */
export type ApprovalSessionConsentChoiceValue = 'ask' | 'scoped' | 'always';

type SetRow = (
  change: SessionApprovalConsentModeChangeV1,
) => Promise<Readonly<{ ok: boolean }>>;

export type ApprovalSessionConsentChoiceInput = Readonly<{
  /** Resets the choice when the review moves to another request. */
  requestKey: string;
  /** The request's policy id when a Session row can change its Ask (`readSessionApprovalConsentActionIdV1`), else null. */
  actionId: string | null;
  /** The Session the agent asked from, when this viewer owns it; otherwise no row is offered. */
  address: SessionAddress | null;
  /** The Machine or Environment admission scoped this request to: the "On {Machine}" rung. */
  scope: ActionApprovalScopeV1 | null;
}>;

export type ApprovalSessionConsentChoice = Readonly<{
  offered: boolean;
  value: ApprovalSessionConsentChoiceValue;
  choose: (value: ApprovalSessionConsentChoiceValue) => void;
  /** Saves the chosen rung before Approve, or null when nothing is chosen. Never rejects: a failed save still lets the call be approved once. */
  saveAfterApproved: () => Promise<void> | null;
  saveFailed: boolean;
  ready: boolean;
  scope: ActionApprovalScopeV1 | null;
  serverId: string | null;
}>;

/** The approval sheet's "Next time in this Session" choice, written through the Session's consent owner. */
export function useApprovalSessionConsentChoice(
  input: ApprovalSessionConsentChoiceInput,
): ApprovalSessionConsentChoice {
  const offered = input.actionId !== null && input.address !== null;
  const { setRow, ready } = useSessionApprovalConsents(
    offered ? input.address : null,
  );
  return useApprovalSessionConsentChoiceState({
    ...input,
    offered,
    setRow,
    ready,
  });
}

/** The choice and its save, over the consent owner's writer. */
export function useApprovalSessionConsentChoiceState(
  input: ApprovalSessionConsentChoiceInput &
    Readonly<{
      offered: boolean;
      setRow: SetRow;
      ready: boolean;
    }>,
): ApprovalSessionConsentChoice {
  const { requestKey, actionId, scope, setRow } = input;
  const [chosen, setChosen] = React.useState<Readonly<{
    key: string;
    value: ApprovalSessionConsentChoiceValue;
  }> | null>(null);
  const [failedKey, setFailedKey] = React.useState<string | null>(null);
  const value =
    chosen?.key === requestKey && (chosen.value !== 'scoped' || scope)
      ? chosen.value
      : 'ask';
  const choose = React.useCallback(
    (next: ApprovalSessionConsentChoiceValue) => {
      setChosen({ key: requestKey, value: next });
    },
    [requestKey],
  );
  const saveAfterApproved = React.useCallback(() => {
    // Nothing chosen: nothing to save after the approval.
    if (!input.offered || actionId === null || value === 'ask') return null;
    setFailedKey(null);
    return setRow({
      actionId,
      audience: 'agent',
      ...(value === 'scoped' && scope ? { scope } : {}),
      mode: 'allowed',
    }).then(
      (result) => { if (!result.ok) setFailedKey(requestKey); },
      () => setFailedKey(requestKey),
    );
  }, [actionId, input.offered, requestKey, scope, setRow, value]);
  const saveFailed = failedKey === requestKey;
  const serverId = input.address?.serverId ?? null;
  // One stable controller per change, so the review's decide callback is not rebuilt on every render.
  return React.useMemo(
    () => ({ offered: input.offered, value, choose, saveAfterApproved, saveFailed, ready: input.ready, scope, serverId }),
    [choose, input.offered, input.ready, saveAfterApproved, saveFailed, scope, serverId, value],
  );
}

/**
 * "Next time in this Session": Ask again | On {Machine} | Always, with what the chosen rung means. It sits
 * right above the decision; Approve saves the choice once the approval is accepted; a refused approval and Reject save nothing.
 */
export function ApprovalSessionConsentRow(
  props: Readonly<{
    choice: ApprovalSessionConsentChoice;
    /** The request is still waiting for this person's answer. */
    open: boolean;
    agentLabel: string | null;
    actionTitle: string;
    disabled?: boolean;
  }>,
) {
  const { choice } = props;
  const targetName = useSessionConsentScopeName(choice.serverId, choice.scope);
  const agent =
    props.agentLabel ??
    t('sessionRemotePermissionGrants.consent.agentFallback');
  const options = React.useMemo(
    () => [
      {
        id: 'ask' as const,
        label: t('sessionRemotePermissionGrants.consent.askAgain'),
        description: t(
          'sessionRemotePermissionGrants.consent.askAgainDescription',
          { agent },
        ),
      },
      ...(targetName !== null
        ? [
            {
              id: 'scoped' as const,
              label: t('sessionRemotePermissionGrants.consent.onTarget', {
                target: targetName,
              }),
              description: t(
                'sessionRemotePermissionGrants.consent.onTargetDescription',
                { agent, action: props.actionTitle, target: targetName },
              ),
            },
          ]
        : []),
      {
        id: 'always' as const,
        label: t('sessionRemotePermissionGrants.consent.always'),
        description: t(
          'sessionRemotePermissionGrants.consent.alwaysDescription',
          { agent, action: props.actionTitle },
        ),
      },
    ],
    [agent, props.actionTitle, targetName],
  );
  if (!choice.offered || (!props.open && !choice.saveFailed)) return null;
  return (
    // Once answered, only the failure line stays: it stands on the page, not on a row sheet.
    <ItemGroup surface={props.open ? undefined : 'none'}>
      {props.open ? (
        <SegmentedChoiceItem
          testID="approvals.session-consent"
          testIDPrefix="approvals.session-consent"
          title={t('sessionRemotePermissionGrants.consent.nextTime')}
          options={options}
          value={choice.value}
          onChange={choice.choose}
          disabled={props.disabled || !choice.ready}
          accessoryLayout="adaptive"
        />
      ) : null}
      {choice.saveFailed ? (
        <SurfaceFreshnessLine
          testID="approvals.session-consent-failed"
          tone="warning"
          reason={t('sessionRemotePermissionGrants.consent.approvedOnce')}
        />
      ) : null}
    </ItemGroup>
  );
}
