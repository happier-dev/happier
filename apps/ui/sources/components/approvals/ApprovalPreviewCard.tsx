import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';
import { MachineSetupApplyInputV1Schema, MachineSetupRemoveInputV1Schema } from '@happier-dev/protocol/machines/managed/actionsV1';
import { MACHINE_SETUP_APPLY_ACTION_ID_V1, MACHINE_SETUP_REMOVE_ACTION_ID_V1 } from '@happier-dev/protocol/machines/managed/actionIdsV1';
import { MachineSetupChangeGroupRow } from '@/components/settings/machines/managed/MachineSetupChangeGroupRow';
import { groupMachineSetupChanges } from '@/components/settings/machines/managed/machineSetupReviewChanges';
import { readActionApprovalSubject, readApprovalPreviewSummary, type ApprovalSummaryInput } from './actionApprovalPresentation';
import { usePreferredLanguage } from '@/text/usePreferredLanguage';
import { useApprovalReferenceReading } from './approvalReferenceReading';
import { MACHINE_ADMIN_ACCESS_SET_ACTION_ID_V1 } from '@happier-dev/protocol/machines/adminAccessActionIdsV1';
import { MachineAdminAccessSetInputV1Schema } from '@happier-dev/protocol/actions/specs/machine/adminAccess';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { machinePageHref } from '@/components/machines/page/machinePageHref';
import { useMachinesDoor } from '@/components/machines/page/machinesDoor';
import { AttentionBanner } from '@/components/ui/lists/AttentionBanner';
import { useMachineListForServer } from '@/sync/domains/state/storage';
import { useServerScopedMachineLabel } from '@/sync/store/hooks';
import { getMachineDisplayName } from '@/utils/sessions/machineDisplayNames';
import { t } from '@/text';

export const ApprovalPreviewCard = React.memo(function ApprovalPreviewCard(props: Readonly<{ preview: unknown; request?: ApprovalSummaryInput; serverId?: string | null }>) {
    return <>
        <MachineAdminAccessPreview request={props.request} serverId={props.serverId ?? null} />
        <ApprovalPreviewSummary {...props} />
        <MachineSetupRecipePreview request={props.request} serverId={props.serverId ?? null} />
    </>;
});

/** Hosts may place this sentence in their existing Request section while family facts stay in the shared body. */
export const ApprovalPreviewSummary = React.memo(function ApprovalPreviewSummary(props: Readonly<{ preview: unknown; request?: ApprovalSummaryInput; serverId?: string | null }>) {
    const language = usePreferredLanguage();
    const summary = React.useMemo(() => readApprovalPreviewSummary(props.preview, props.request), [props.preview, props.request, language]);
    if (props.request?.actionId === 'scm.diffSummary.result.clear') return <ClearApprovalPreview {...props} request={props.request} />;
    return <ApprovalPreviewText summary={summary} />;
});

/** These family consequences remain visible even when the host already renders the review's sentence. */
export const ApprovalPreviewFacts = React.memo(function ApprovalPreviewFacts(props: Readonly<{ request?: ApprovalSummaryInput; serverId?: string | null }>) {
    return <>
        <MachineAdminAccessPreview request={props.request} serverId={props.serverId ?? null} />
        <MachineSetupRecipePreview request={props.request} serverId={props.serverId ?? null} />
    </>;
});

/** Only the reviewed effect Plans are executable here; source copies stay review context. */
function readMachineSetupRecipeTargets(request?: ApprovalSummaryInput) {
    if (request?.actionId === MACHINE_SETUP_APPLY_ACTION_ID_V1) {
        const parsed = MachineSetupApplyInputV1Schema.safeParse(request.actionArgs);
        return parsed.success ? parsed.data.targets.map(target => ({ ...target, sources: [] })) : [];
    }
    if (request?.actionId === MACHINE_SETUP_REMOVE_ACTION_ID_V1) {
        const parsed = MachineSetupRemoveInputV1Schema.safeParse(request.actionArgs);
        return parsed.success ? [parsed.data] : [];
    }
    return [];
}

/** The same change groups the Setup tab's review shows (P-M6), so an agent's setup reads the same everywhere. */
function MachineSetupRecipePreview(props: Readonly<{ request?: ApprovalSummaryInput; serverId: string | null }>) {
    const targets = readMachineSetupRecipeTargets(props.request);
    const machines = useMachineListForServer(props.serverId ?? '', targets.length > 0 && props.serverId !== null);
    const nameOf = React.useCallback((machineId: string) =>
        getMachineDisplayName(machines?.find(machine => machine.id === machineId)) ?? t('common.unknown'), [machines]);
    const groups = groupMachineSetupChanges(targets);
    return groups.length > 0 ? <>{groups.map(group => (
        <MachineSetupChangeGroupRow key={group.kind} group={group} testID={`approvals.preview.${group.kind}`}
            nameOf={nameOf} targetCount={targets.length} />
    ))}</> : null;
}

/**
 * An agent asking to preauthorize administrator access is a permission change, said first (lab `inbox/P`), with the
 * safer path beside Allow and Deny: separate users, turned on from the Machine's Security page.
 */
function MachineAdminAccessPreview(props: Readonly<{ request?: ApprovalSummaryInput; serverId: string | null }>) {
    const parsed = props.request?.actionId === MACHINE_ADMIN_ACCESS_SET_ACTION_ID_V1
        ? MachineAdminAccessSetInputV1Schema.safeParse(props.request.actionArgs) : null;
    const input = parsed?.success && parsed.data.adminAccess.mode === 'preauthorized' ? parsed.data : null;
    const router = useRouter();
    const door = useMachinesDoor();
    const name = useServerScopedMachineLabel(input ? props.serverId : null, input?.machineId ?? null);
    if (!input) return null;
    return (
        <AttentionBanner testID="approvals.preview.permission" tone="warning"
            title={t('machinePresets.setup.tab.permissionChange')}
            description={t('machinePresets.setup.tab.permissionChangeHelp', { machine: name ?? t('common.unknown') })}
            action={{ label: t('machinePresets.setup.tab.separateUsersInstead'), onPress: () => router.push(machinePageHref({
                door, target: { machineId: input.machineId, ...((props.serverId ?? input.serverId) ? { serverId: (props.serverId ?? input.serverId)! } : {}) }, page: 'security',
            }) as never) }} />
    );
}

function ClearApprovalPreview(props: Readonly<{ preview: unknown; request: ApprovalSummaryInput; serverId?: string | null }>) {
    const reference = readActionApprovalSubject(props.request);
    const reading = useApprovalReferenceReading(reference, '', props.serverId ?? null);
    const subject = reading.named && !reading.resolving ? reading.text : null;
    return <ApprovalPreviewText summary={readApprovalPreviewSummary(props.preview, props.request, subject)} />;
}

function ApprovalPreviewText(props: Readonly<{ summary: string | null }>) {
    if (!props.summary) return null;

    return (
        <View style={styles.card}>
            <Text style={styles.summary}>{props.summary}</Text>
        </View>
    );
}

const styles = StyleSheet.create((theme) => ({
    // Sheet content of the approval's "Request" section: the section owns the chrome.
    card: {
        gap: theme.space.s4,
    },
    summary: {
        fontSize: 14,
        color: theme.colors.text.secondary,
        lineHeight: 20,
    },
}));
