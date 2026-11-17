import * as React from 'react';
import { bindApprovalProfileV1 } from '@happier-dev/protocol/actions/approvalProfileArtifactV1';
import type { ApprovalProfileV1, ReadableApprovalProfileV1 } from '@happier-dev/protocol/actions/approvalProfiles';
import type { ActionPolicySetInput } from '@happier-dev/protocol/actions/actionPolicyActionFamily';
import { useActiveServerAccountScope } from '@/sync/store/hooks';
import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import type { ApprovalProfileMachineDefault } from '@/components/approvals/ApprovalProfileSelect';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import type { ServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { subscribeScopedAccountSettings } from '@/sync/ops/account/scopedAccountSettings';
import { requestApprovalProfileCatalog, requestApprovalProfileDescriptors, subscribeApprovalProfileCatalog,
    type ApprovalProfileDescriptor } from '@/sync/engine/settings/approvalProfileCatalog';
import { fireAndForget } from '@/utils/system/fireAndForget';

const PROFILE_SETTINGS_KEYS = ['actionsSettingsV1'] as const;
const EMPTY_PROFILES: readonly ApprovalProfileV1[] = Object.freeze([]);
const EMPTY_ROWS: readonly ReadableApprovalProfileV1[] = Object.freeze([]);
const EMPTY_MACHINE_DEFAULTS: Readonly<Record<string, string>> = Object.freeze({});

/** Profile documents use the held Artifact catalog; only Machine defaults remain Account preferences. */
export function useApprovalProfiles(approvalProfileId?: string | null, scopeOrHome?: ServerAccountScope | string | null,
    options?: Readonly<{ demand?: boolean; machineId?: string | null }>) {
    const scope = useActiveServerAccountScope();
    const execution = useMountedActionExecution(scopeOrHome === undefined ? scope : scopeOrHome);
    const binding = execution.binding;
    const [catalog, setCatalog] = React.useState<Readonly<{ binding: ServerCredentialAccountScopeBinding;
        rows: readonly ReadableApprovalProfileV1[] | null; descriptors: Readonly<Record<string, ApprovalProfileDescriptor | null>>;
        stale: boolean; unavailable: boolean }> | null>(null);
    const [preferences, setPreferences] = React.useState<Readonly<{ binding: ServerCredentialAccountScopeBinding;
        machineApprovalProfiles: Readonly<Record<string, string>> }> | null>(null);
    const demand = options?.demand !== false;
    React.useEffect(() => {
        if (!binding || !execution.ready) return;
        return subscribeApprovalProfileCatalog(binding, snapshot => {
            setCatalog(previous => previous?.binding === binding && previous.rows === snapshot.rows && previous.descriptors === snapshot.descriptors
                && previous.stale === snapshot.stale && previous.unavailable === snapshot.unavailable
                ? previous : { binding, ...snapshot });
        }, demand);
    }, [binding, execution.ready, demand]);
    React.useEffect(() => {
        if (!binding || !execution.ready) return;
        return subscribeScopedAccountSettings(binding, PROFILE_SETTINGS_KEYS, settings => {
            const machineApprovalProfiles = settings?.actionsSettingsV1.machineApprovalProfiles ?? EMPTY_MACHINE_DEFAULTS;
            setPreferences(previous => previous?.binding === binding && previous.machineApprovalProfiles === machineApprovalProfiles
                ? previous : { binding, machineApprovalProfiles });
        });
    }, [binding, execution.ready]);
    const current = execution.ready && catalog?.binding === binding ? catalog : null;
    const profileRows = current?.rows ?? EMPTY_ROWS;
    const profiles = React.useMemo(() => profileRows.length ? profileRows.map(row => row.profile) : EMPTY_PROFILES, [profileRows]);
    const ready = current?.rows !== null && current !== null && !current.stale;
    const unavailable = current?.unavailable ?? false;
    const machineApprovalProfiles = execution.ready && preferences?.binding === binding
        ? preferences.machineApprovalProfiles : EMPTY_MACHINE_DEFAULTS;
    const displayId = typeof approvalProfileId === 'string' ? approvalProfileId
        : options?.machineId ? machineApprovalProfiles[options.machineId] : undefined;
    React.useEffect(() => {
        if (!binding || !execution.ready || demand || !displayId) return;
        fireAndForget(requestApprovalProfileDescriptors(binding, [displayId]), { tag: 'ApprovalProfile.descriptor' });
    }, [binding, execution.ready, demand, displayId]);
    const displayProfiles = React.useMemo<readonly ApprovalProfileDescriptor[]>(() => ready ? profiles
        : Object.values(current?.descriptors ?? {}).filter((row): row is ApprovalProfileDescriptor => row !== null),
    [ready, profiles, current?.descriptors]);
    const selectedDescriptor = typeof displayId === 'string' ? current?.descriptors[displayId] : undefined;
    const selection = React.useMemo(() => !ready || approvalProfileId == null ? null
        : bindApprovalProfileV1(profileRows, approvalProfileId), [profileRows, approvalProfileId, ready]);
    const selectionRow = React.useMemo(() => approvalProfileId == null ? null
        : profileRows.find(row => row.id === approvalProfileId) ?? null, [profileRows, approvalProfileId]);
    const requestCatalog = React.useCallback(async () => {
        if (binding && execution.ready) await requestApprovalProfileCatalog(binding);
    }, [binding, execution.ready]);
    const execute = React.useCallback((input: ActionPolicySetInput) => execution.execute('actions.policy.set', input), [execution.execute]);
    return React.useMemo(() => ({ profiles, profileRows, displayProfiles, selectedDescriptor, machineApprovalProfiles, selection, selectionRow, ready, unavailable,
        requestCatalog, execute, execution }),
    [profiles, profileRows, displayProfiles, selectedDescriptor, machineApprovalProfiles, selection, selectionRow, ready, unavailable, requestCatalog, execute, execution]);
}

export function resolveApprovalProfileMachineDefault(
    source: Pick<ReturnType<typeof useApprovalProfiles>, 'displayProfiles' | 'machineApprovalProfiles'>,
    machineId: string | null | undefined,
): ApprovalProfileMachineDefault {
    if (!machineId) return null;
    const id = source.machineApprovalProfiles[machineId];
    return { profile: id ? source.displayProfiles.find(profile => profile.id === id) ?? null : null };
}
