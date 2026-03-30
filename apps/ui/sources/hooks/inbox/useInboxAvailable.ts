import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';

export function useInboxAvailable(): boolean {
    return useFeatureEnabled('inbox.global') || useFeatureEnabled('actions.approvals');
}
