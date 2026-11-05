import * as React from 'react';
import { listApprovalProfilesV1, readApprovalProfileV1, type ApprovalProfileV1 } from '@happier-dev/protocol/actions';
import { useActiveServerAccountScope, useSetting, useSettingsReady } from '@/sync/store/hooks';
import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';

/** Account profile preferences and acknowledged edits; admission remains with the Action owner. */
export function useApprovalProfiles(approvalProfileId?: string | null) {
    const settings = useSetting('actionsSettingsV1');
    const ready = useSettingsReady();
    const scope = useActiveServerAccountScope();
    const execution = useMountedActionExecution(scope);
    const profiles = React.useMemo(() => listApprovalProfilesV1(settings), [settings.approvalProfiles]);
    const selection = React.useMemo(() => !ready || approvalProfileId == null ? null
        : readApprovalProfileV1(settings, approvalProfileId), [settings.approvalProfiles, approvalProfileId, ready]);
    const upsertProfile = React.useCallback((profile: ApprovalProfileV1) => execution.execute('actions.policy.set', {
        profileChange: { kind: 'upsert', profile },
    }), [execution.execute]);
    const deleteProfile = React.useCallback((id: string) => execution.execute('actions.policy.set', {
        profileChange: { kind: 'delete', id },
    }), [execution.execute]);
    return React.useMemo(() => ({ profiles, selection, ready, upsertProfile, deleteProfile, execution }),
        [profiles, selection, ready, upsertProfile, deleteProfile, execution]);
}
