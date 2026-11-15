import * as React from 'react';
import { readApprovalProfileV1, type ApprovalProfileV1 } from '@happier-dev/protocol/actions';
import type { ActionPolicySetInput } from '@happier-dev/protocol/actions/actionPolicyActionFamily';
import { useActiveServerAccountScope } from '@/sync/store/hooks';
import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import type { ApprovalProfileMachineDefault } from '@/components/approvals/ApprovalProfileSelect';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import type { ServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { subscribeScopedAccountSettings } from '@/sync/ops/account/scopedAccountSettings';

const PROFILE_SETTINGS_KEYS = ['actionsSettingsV1'] as const;
const EMPTY_PROFILES: readonly ApprovalProfileV1[] = Object.freeze([]);
const EMPTY_MACHINE_DEFAULTS: Readonly<Record<string, string>> = Object.freeze({});

type Rows = Readonly<{ profiles: readonly ApprovalProfileV1[]; machineApprovalProfiles: Readonly<Record<string, string>> }>;

/** Account profile preferences and acknowledged edits; admission remains with the Action owner. */
export function useApprovalProfiles(approvalProfileId?: string | null, scopeOrHome?: ServerAccountScope | string | null) {
    const scope = useActiveServerAccountScope();
    const execution = useMountedActionExecution(scopeOrHome === undefined ? scope : scopeOrHome);
    const [projection, setProjection] = React.useState<Readonly<{
        binding: ServerCredentialAccountScopeBinding;
        rows: Rows | null;
    }> | null>(null);
    const binding = execution.binding;
    React.useEffect(() => {
        if (!binding || !execution.ready) return;
        return subscribeScopedAccountSettings(binding, PROFILE_SETTINGS_KEYS, settings => {
            const profiles = settings === null ? null : settings.actionsSettingsV1.approvalProfiles ?? EMPTY_PROFILES;
            const machineApprovalProfiles = settings?.actionsSettingsV1.machineApprovalProfiles ?? EMPTY_MACHINE_DEFAULTS;
            setProjection(previous => previous?.binding === binding
                && previous.rows?.profiles === profiles && previous.rows?.machineApprovalProfiles === machineApprovalProfiles
                ? previous : { binding, rows: profiles === null ? null : { profiles, machineApprovalProfiles } });
        });
    }, [binding, execution.ready]);
    const current = execution.ready && projection?.binding === binding ? projection : null;
    const ready = current !== null && current.rows !== null;
    const unavailable = current !== null && current.rows === null;
    const profiles = current?.rows?.profiles ?? EMPTY_PROFILES;
    const machineApprovalProfiles = current?.rows?.machineApprovalProfiles ?? EMPTY_MACHINE_DEFAULTS;
    const selection = React.useMemo(() => !ready || approvalProfileId == null ? null
        : readApprovalProfileV1({ approvalProfiles: profiles }, approvalProfileId), [profiles, approvalProfileId, ready]);
    const execute = React.useCallback((input: ActionPolicySetInput) => execution.execute('actions.policy.set', input),
        [execution.execute]);
    return React.useMemo(() => ({ profiles, machineApprovalProfiles, selection, ready, unavailable, execute, execution }),
        [profiles, machineApprovalProfiles, selection, ready, unavailable, execute, execution]);
}

/** What "Machine default" means for a Session on this Machine: its saved profile, or the Account settings. */
export function resolveApprovalProfileMachineDefault(
    source: Pick<ReturnType<typeof useApprovalProfiles>, 'profiles' | 'machineApprovalProfiles'>,
    machineId: string | null | undefined,
): ApprovalProfileMachineDefault {
    if (!machineId) return null;
    const id = source.machineApprovalProfiles[machineId];
    return { profile: id ? source.profiles.find(profile => profile.id === id) ?? null : null };
}
