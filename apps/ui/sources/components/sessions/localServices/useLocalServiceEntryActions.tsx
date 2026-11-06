import * as React from 'react';

import type { FrontDoorRuntimeActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';

import { useActionApprovalContinuation } from '@/components/approvals/useActionApprovalContinuation';
import { useServerCredentialAccountScopeBindings } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';
import { createFrontDoorRuntimeActionExecutor } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';

import { useLocalServiceLauncherStartAction } from './launcherStartAction';
import {
  useDetectedLocalServiceForgetAction,
  useDetectedLocalServiceTerminateAction,
  useLocalServiceCopyUrlAction,
  useLocalServiceLauncherHistoryClearAction,
  useManagedLocalServiceControlAction,
} from './lifecycleActions';
import type {
  LocalServiceActionAdmission,
  LocalServiceActionInvocationOptions,
  LocalServiceEffectReview,
  LocalServiceSetupConsentReview,
} from './localServiceActionAdmission';
import type { LocalServiceEntryHandlers } from './localServiceEntryActions';
import { LocalServiceEffectReviewCard } from './LocalServiceEffectReviewCard';
import { LocalServiceSetupConsentContinuation } from './LocalServiceSetupConsentContinuation';
import { useLocalServicePublicPreviewActions } from './publicPreviewActions';
import type { LocalServiceLiveFeeds } from './useLocalServiceLiveFeeds';

export type LocalServiceEntryActionsInput = Readonly<{
  machineId: string | null;
  serverId: string | null;
  sessionId?: string;
  workspaceRoot?: string | null;
  scope: 'workspace' | 'machine';
  /** Defaults to the single front door, so ActionsSettings enablement and approval routing apply. */
  runtimeActionExecute?: FrontDoorRuntimeActionExecute;
  /** The surface's feeds: an approved Action re-reads them, and Start/Clear apply their snapshot. */
  onRefresh?: LocalServiceLiveFeeds['refresh'];
  applyLauncherSnapshot?: LocalServiceLiveFeeds['applyLauncherSnapshot'];
  testID: string;
}>;

export type LocalServiceEntryActionsWiring = Readonly<{
  /** Every entry effect, bound to this surface's admission. The opener stays the surface's own. */
  handlers: Omit<LocalServiceEntryHandlers, 'onOpenServiceInBrowser'> &
    Readonly<{
      onCopyServiceUrl: NonNullable<
        LocalServiceEntryHandlers['onCopyServiceUrl']
      >;
    }>;
  /** The setup-consent and current-effect reviews a Start/Restart waits on; the surface places it. */
  review: React.ReactElement;
  /** The Account the surface acts as: its own services carry no "Started by". */
  viewerAccountId: string | null;
}>;

/**
 * The one owner of a Local services surface's Action admission (plan 30 RU-3): the credential
 * binding and its retirement, cancellation when the Account, machine or checkout changes, the
 * approval continuation, the effect and setup reviews, and every entry Action bound to them. The
 * Services pane and the Processes port menu both act through it, so a port's Stop is the same
 * Action, with the same approval, as the Services row's.
 */
export function useLocalServiceEntryActions(
  input: LocalServiceEntryActionsInput,
): LocalServiceEntryActionsWiring {
  const { machineId, serverId, sessionId, scope } = input;
  const workspaceRoot = input.workspaceRoot ?? null;
  const onRefresh = input.onRefresh;
  // Single front door (FINALIZATION-PLAN §3.1/§12.6): local-service runtime actions dispatch
  // through ActionExecutor.execute via the canonical bridge, so ActionsSettings enablement and
  // approval routing apply — never the raw runtime executor.
  const runtimeActionExecute = React.useMemo(
    () => input.runtimeActionExecute ?? createFrontDoorRuntimeActionExecutor(),
    [input.runtimeActionExecute],
  );
  const credentialBindings = useServerCredentialAccountScopeBindings([
    serverId,
  ]);
  const credentialBinding = credentialBindings.get(
    resolveServerProfileScopeIdForIdentifier(serverId),
  );
  const actionScopeKey = JSON.stringify([
    serverId,
    credentialBinding?.accountId,
    credentialBinding?.revision,
    machineId,
    workspaceRoot,
    sessionId,
  ]);
  const cancellation = React.useMemo(
    () => new AbortController(),
    [actionScopeKey],
  );
  React.useEffect(() => {
    const retirement = credentialBinding?.onRetire(() => cancellation.abort());
    return () => {
      retirement?.dispose();
      cancellation.abort();
    };
  }, [credentialBinding, cancellation]);
  const refreshAfterApproval = React.useCallback(() => {
    void onRefresh?.();
  }, [onRefresh]);
  const approval = useActionApprovalContinuation({
    scopeKey: actionScopeKey,
    serverId: serverId ?? '',
    onExecuted: refreshAfterApproval,
  });
  const isActionScopeCurrent = React.useCallback(
    () =>
      Boolean(credentialBinding?.isCurrent()) && !cancellation.signal.aborted,
    [credentialBinding, cancellation],
  );
  const effectReview = useLocalServiceReview<LocalServiceEffectReview>();
  const setupReview = useLocalServiceReview<LocalServiceSetupConsentReview>();
  const actionAdmission: LocalServiceActionAdmission = {
    expectedAccountId: credentialBinding?.accountId,
    signal: cancellation.signal,
    isCurrent: isActionScopeCurrent,
    onApprovalPending: approval.requestApproval,
    reviewEffect: effectReview.request,
    reviewSetupConsent: setupReview.request,
  };
  const bound = {
    ...actionAdmission,
    runtimeActionExecute,
    machineId,
    serverId,
    sessionId,
  };
  const onTerminateDetectedService =
    useDetectedLocalServiceTerminateAction(bound);
  const onForgetDetectedService = useDetectedLocalServiceForgetAction(bound);
  const onCopyServiceUrl = useLocalServiceCopyUrlAction(bound);
  // Stop and Restart a managed lifetime through its exact occurrence; the result settles the row.
  const managedControl = useManagedLocalServiceControlAction(bound);
  const onStopManagedService = React.useMemo(
    () =>
      managedControl
        ? (target: Parameters<typeof managedControl>[0], options?: LocalServiceActionInvocationOptions) =>
            managedControl(target, 'localServices.actions.stopManaged', options)
        : undefined,
    [managedControl],
  );
  const onRestartManagedService = React.useMemo(
    () =>
      managedControl
        ? (target: Parameters<typeof managedControl>[0], options?: LocalServiceActionInvocationOptions) =>
            managedControl(target, 'localServices.actions.restartManaged', options)
        : undefined,
    [managedControl],
  );
  const onStartLauncherTarget = useLocalServiceLauncherStartAction({
    ...bound,
    applyLauncherSnapshot: input.applyLauncherSnapshot,
  });
  const onClearLauncherHistory = useLocalServiceLauncherHistoryClearAction({
    ...bound,
    scope,
    workspaceRoot,
    applyLauncherSnapshot: input.applyLauncherSnapshot,
  });
  const publicPreviewActions = useLocalServicePublicPreviewActions(bound);
  const handlers = React.useMemo(
    () => ({
      onTerminateDetectedService,
      onForgetDetectedService,
      onCopyServiceUrl,
      onStopManagedService,
      onRestartManagedService,
      onStartLauncherTarget,
      onClearLauncherHistory,
      publicPreviewActions,
    }),
    [
      onClearLauncherHistory,
      onCopyServiceUrl,
      onForgetDetectedService,
      onRestartManagedService,
      onStartLauncherTarget,
      onStopManagedService,
      onTerminateDetectedService,
      publicPreviewActions,
    ],
  );

  const review = (
    <>
      {setupReview.pending && credentialBinding ? (
        <LocalServiceSetupConsentContinuation
          key={JSON.stringify([
            setupReview.pending.review.target.id,
            setupReview.pending.review.consent.reviewedEffectDigest,
          ])}
          review={setupReview.pending.review}
          binding={credentialBinding}
          runtimeActionExecute={runtimeActionExecute}
          onComplete={setupReview.pending.settle}
          testID={input.testID}
        />
      ) : null}
      {effectReview.pending && serverId ? (
        <LocalServiceEffectReviewCard
          review={effectReview.pending.review}
          serverId={serverId}
          machineId={machineId}
          onDecide={effectReview.pending.settle}
          testID={`${input.testID}-effect-review`}
        />
      ) : null}
    </>
  );

  return {
    handlers,
    review,
    viewerAccountId: credentialBinding?.accountId ?? null,
  };
}

type PendingReview<T> = Readonly<{
  review: T;
  settle: (accepted: boolean) => void;
}>;

/**
 * The one current-effect review of this Services surface: Start/Restart hand it the effect the
 * daemon disclosed and wait for the person. Only an explicit Start/Restart rejoins the Action with
 * that digest; Not now, a newer review or the scope's retirement (its Account, machine or checkout
 * changing aborts the signal) settles it as declined, so nothing re-enters on its own.
 */
function useLocalServiceReview<
  T extends Readonly<{ signal?: AbortSignal }>,
>(): Readonly<{
  pending: PendingReview<T> | null;
  request: (review: T) => Promise<boolean>;
}> {
  const [pending, setPending] = React.useState<PendingReview<T> | null>(null);
  const current = React.useRef<PendingReview<T> | null>(null);
  const request = React.useCallback(
    (review: T) =>
      new Promise<boolean>((resolve) => {
        current.current?.settle(false);
        if (review.signal?.aborted) {
          resolve(false);
          return;
        }
        let settled = false;
        const onAbort = () => entry.settle(false);
        const entry: PendingReview<T> = {
          review,
          settle: (accepted) => {
            if (settled) return;
            settled = true;
            review.signal?.removeEventListener('abort', onAbort);
            if (current.current === entry) {
              current.current = null;
              setPending(null);
            }
            resolve(accepted);
          },
        };
        current.current = entry;
        setPending(entry);
        review.signal?.addEventListener('abort', onAbort, { once: true });
      }),
    [],
  );
  React.useEffect(() => () => current.current?.settle(false), []);
  return { pending, request };
}
