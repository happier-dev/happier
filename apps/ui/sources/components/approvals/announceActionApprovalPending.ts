import { publishPresentationNotice } from '@/components/sessions/presentation/presentationNotices';
import { getActiveServerAccountScope } from '@/sync/domains/scope/activeServerAccountScope';
import { t } from '@/text';
import { buildApprovalHref } from './approvalNavigation';

/**
 * The neutral notice for an Action the person's policy sent for approval, with a way to review it. Shared by
 * callers whose surface may already be gone when the approval request comes back (a sheet that stepped aside,
 * a menu that closed).
 */
export function announceActionApprovalPending(
  artifactId: string,
  serverId: string | undefined,
): void {
  const approvalServerId = serverId ?? getActiveServerAccountScope()?.serverId;
  publishPresentationNotice({
    key: `action-approval:${artifactId}`,
    severity: 'info',
    message: t('approvals.waitingForYou'),
    ...(approvalServerId
      ? {
          undo: {
            label: t('approvals.review'),
            run: () => {
              void import('expo-router').then(({ router }) =>
                router.push(buildApprovalHref(artifactId, approvalServerId)),
              );
            },
          },
        }
      : {}),
  });
}
