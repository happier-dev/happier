import * as React from 'react';
import { View } from 'react-native';

import { ApprovalProfileSelect } from '@/components/approvals/ApprovalProfileSelect';
import { presentApprovalProfile } from '@/components/approvals/approvalProfilePresentation';
import { isStaleSessionIntent, SessionIntentConflictLine } from '@/components/sessions/work/SessionIntentConflictLine';
import { resolveSessionInstructionsAccess } from '@/components/sessions/work/instructions/SessionInstructionsSection';
import { SurfaceFreshnessLine } from '@/components/ui/surfaces/SurfaceFreshnessLine';
import { useApprovalProfiles } from '@/hooks/approvals/useApprovalProfiles';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import type { Session } from '@/sync/domains/state/storageTypes';
import { t } from '@/text';
import { fireAndForget } from '@/utils/system/fireAndForget';

export function SessionApprovalProfileSection(props: Readonly<{ session: Session; serverId: string }>) {
    if (resolveSessionInstructionsAccess(props.session) !== 'readable') return null;
    return <SessionApprovalProfileBody key={JSON.stringify([props.serverId, props.session.id])} {...props} />;
}

function SessionApprovalProfileBody({ session, serverId }: Readonly<{ session: Session; serverId: string }>) {
    const value = readSessionOwnerMetadataView(session)?.approvalProfileId ?? null;
    const source = useApprovalProfiles(value, serverId);
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
        <ApprovalProfileSelect mode="session" testID="session-approval-profile" value={pending ? pending.value : value}
            source={source} onChange={change} disabled={pending !== null} />
        {held ? <SessionIntentConflictLine testID="session-approval-profile-conflict"
            subject={t('workflows.triggers.guided.profile.title')}
            current={source.selection ? presentApprovalProfile(source.selection.profile).title
                : t('workflows.triggers.guided.profile.noExplicitSessionProfile')}
            onApply={() => change(held.value)} onKeep={() => setHeld(null)} /> : refused
            ? <SurfaceFreshnessLine testID="session-approval-profile-refused" tone="warning"
                reason={t('workflows.triggers.guided.profile.saveFailed')} /> : null}
    </View>;
}
