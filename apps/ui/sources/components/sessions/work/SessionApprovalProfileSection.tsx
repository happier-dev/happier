import * as React from 'react';
import { View } from 'react-native';

import { ApprovalProfileSelect, approvalProfileChoiceTitle } from '@/components/approvals/ApprovalProfileSelect';
import { isStaleSessionIntent, SessionIntentConflictLine } from '@/components/sessions/work/SessionIntentConflictLine';
import { resolveSessionInstructionsAccess } from '@/components/sessions/work/instructions/SessionInstructionsSection';
import { SurfaceFreshnessLine } from '@/components/ui/surfaces/SurfaceFreshnessLine';
import { Icon } from '@/components/ui/icons/Icon';
import { resolveApprovalProfileMachineDefault, useApprovalProfiles } from '@/hooks/approvals/useApprovalProfiles';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import type { Session } from '@/sync/domains/state/storageTypes';
import { t } from '@/text';
import { fireAndForget } from '@/utils/system/fireAndForget';

export function SessionApprovalProfileSection(props: Readonly<{ session: Session; serverId: string }>) {
    if (resolveSessionInstructionsAccess(props.session) !== 'readable') return null;
    return <SessionApprovalProfileBody key={JSON.stringify([props.serverId, props.session.id])} {...props} />;
}

function SessionApprovalProfileBody({ session, serverId }: Readonly<{ session: Session; serverId: string }>) {
    const metadata = readSessionOwnerMetadataView(session);
    const value = metadata?.approvalProfileId ?? null;
    const source = useApprovalProfiles(value, serverId);
    const machineId = metadata?.machineId ?? null;
    const machineDefault = React.useMemo(() => resolveApprovalProfileMachineDefault(source, machineId),
        [source.profiles, source.machineApprovalProfiles, machineId]); // eslint-disable-line react-hooks/exhaustive-deps
    const [pending, setPending] = React.useState<Readonly<{ value: string | null }> | null>(null);
    const [held, setHeld] = React.useState<Readonly<{ value: string | null }> | null>(null);
    const [refused, setRefused] = React.useState(false);
    const change = (next: string | null) => {
        if (pending !== null) return;
        setPending({ value: next });
        setHeld(null);
        setRefused(false);
        fireAndForget((async () => {
            try {
                const result = await source.execution.execute('session.approval_profile.set', {
                    sessionId: session.id, serverId, expectedMetadataRevision: session.metadataVersion, approvalProfileId: next,
                });
                if (isStaleSessionIntent(result)) setHeld({ value: next });
                else if (!result.ok) setRefused(true);
            } catch {
                setRefused(true);
            } finally {
                setPending(null);
            }
        })(), { tag: 'SessionApprovalProfile.set' });
    };
    return <View>
        {/* One value row like Role, Instructions and Memory beside it (owner 11-15 C4). */}
        <ApprovalProfileSelect mode="session" testID="session-approval-profile" value={pending ? pending.value : value}
            source={source} machineDefault={machineDefault} onChange={change} disabled={pending !== null}
            presentation="row" icon={<Icon name="shield-check" />} />
        {held ? <SessionIntentConflictLine testID="session-approval-profile-conflict"
            subject={t('workflows.triggers.guided.profile.title')}
            current={approvalProfileChoiceTitle('session', value, source.profiles, machineDefault)}
            onApply={() => change(held.value)} onKeep={() => setHeld(null)} /> : refused
            ? <SurfaceFreshnessLine testID="session-approval-profile-refused" tone="warning"
                reason={t('workflows.triggers.guided.profile.saveFailed')} /> : null}
    </View>;
}
