import * as React from 'react';
import { listApprovalProfilesV1, readApprovalProfileV1, type ApprovalProfileV1 } from '@happier-dev/protocol/actions';
import { useActiveServerAccountScope } from '@/sync/store/hooks';
import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import type { ServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { subscribeScopedAccountSettings } from '@/sync/ops/account/scopedAccountSettings';

const PROFILE_SETTINGS_KEYS = ['actionsSettingsV1'] as const;
const EMPTY_PROFILES: readonly ApprovalProfileV1[] = Object.freeze([]);

/** Account profile preferences and acknowledged edits; admission remains with the Action owner. */
export function useApprovalProfiles(approvalProfileId?: string | null, scopeOrHome?: ServerAccountScope | string | null) {
    const scope = useActiveServerAccountScope();
    const execution = useMountedActionExecution(scopeOrHome === undefined ? scope : scopeOrHome);
    const [projection, setProjection] = React.useState<Readonly<{
        binding: ServerCredentialAccountScopeBinding;
        rows: readonly ApprovalProfileV1[] | null;
    }> | null>(null);
    const binding = execution.binding;
    React.useEffect(() => {
        if (!binding || !execution.ready) return;
        return subscribeScopedAccountSettings(binding, PROFILE_SETTINGS_KEYS, settings => {
            const rows = settings === null ? null : settings.actionsSettingsV1.approvalProfiles ?? EMPTY_PROFILES;
            setProjection(previous => previous?.binding === binding && previous.rows === rows
                ? previous : { binding, rows });
        });
    }, [binding, execution.ready]);
    const current = execution.ready && projection?.binding === binding ? projection : null;
    const ready = current !== null && current.rows !== null;
    const unavailable = current !== null && current.rows === null;
    const rows = current?.rows ?? EMPTY_PROFILES;
    const profiles = React.useMemo(() => ready ? listApprovalProfilesV1({ approvalProfiles: rows }) : EMPTY_PROFILES, [rows, ready]);
    const selection = React.useMemo(() => !ready || approvalProfileId == null ? null
        : readApprovalProfileV1({ approvalProfiles: rows }, approvalProfileId), [rows, approvalProfileId, ready]);
    const upsertProfile = React.useCallback((profile: ApprovalProfileV1) => execution.execute('actions.policy.set', {
        profileChange: { kind: 'upsert', profile },
    }), [execution.execute]);
    const deleteProfile = React.useCallback((id: string) => execution.execute('actions.policy.set', {
        profileChange: { kind: 'delete', id },
    }), [execution.execute]);
    return React.useMemo(() => ({ profiles, selection, ready, unavailable, upsertProfile, deleteProfile, execution }),
        [profiles, selection, ready, unavailable, upsertProfile, deleteProfile, execution]);
}
