import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';

export function useInboxAvailable(): boolean {
    const inboxEnabled = useFeatureEnabled('inbox.global');
    const approvalsEnabled = useFeatureEnabled('actions.approvals');
    return inboxEnabled || approvalsEnabled;
}
