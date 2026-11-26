import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { MachineSetupApplyInputV1Schema, MachineSetupRemoveInputV1Schema } from '@happier-dev/protocol/machines/managed/actionsV1';
import { MACHINE_SETUP_APPLY_ACTION_ID_V1, MACHINE_SETUP_REMOVE_ACTION_ID_V1 } from '@happier-dev/protocol/machines/managed/actionIdsV1';
import { MachineSetupChangeGroupRow } from '@/components/settings/machines/managed/MachineSetupChangeGroupRow';
import { groupMachineSetupChanges } from '@/components/settings/machines/managed/machineSetupReviewChanges';
import { reviewMachineSetupPlanScripts, type MachineSetupPlanScriptReviewFacts,
    type MachineSetupTargetSourcePresentations } from '@/components/settings/machines/managed/machineSetupReview';
import { presentUnresolvedMachineSetupSources } from '@/sync/ops/machines/managedMachinePresetCustody';
import { MachineSetupReviewedStepV1Schema } from '@happier-dev/protocol/machines/setup/machineSetupOperationV1';
import { TEAM_SETUP_RUN_ACTION_ID_V1, TeamSetupBatchInputV1Schema } from '@happier-dev/protocol/teams';
import { presentActionApproval, readActionApprovalSubject, readApprovalPreviewSummary, type ApprovalSummaryInput } from './actionApprovalPresentation';
import { readSettledSessionTeamApproval, type SettledSessionTeamApproval } from '@happier-dev/protocol/actions/actionApprovalPresentation';
import { useApprovalPrincipalName } from './approvalPrincipalReading';
import { usePreferredLanguage } from '@/text/usePreferredLanguage';
import { useApprovalHomeLayoutItemReading, useApprovalReferenceReading } from './approvalReferenceReading';
import { HOME_HUB_LAYOUT_UPDATE_ACTION_ID, readHomeLayoutApprovalEffect } from '@happier-dev/protocol/actions/specs/homeHub';
import { useAccountSettingsScope } from '@/sync/store/settingsWriters';
import { MACHINE_ADMIN_ACCESS_SET_ACTION_ID_V1 } from '@happier-dev/protocol/machines/adminAccessActionIdsV1';
import { MachineAdminAccessSetInputV1Schema } from '@happier-dev/protocol/actions/specs/machine/adminAccess';
import { SESSION_SPAWN_NEW_ACTION_ID_V1 } from '@happier-dev/protocol/actions/actionIds';
import { readTeamCredentialApprovalSources } from '@happier-dev/protocol/actions/actionExecutor';
import { readRecord } from '@happier-dev/protocol/inputs/inputRecords';
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
        {props.request?.actionId === SESSION_SPAWN_NEW_ACTION_ID_V1 && <SpawnTeamCredentialSources preview={props.preview} />}
        <MachineSetupRecipePreview request={props.request} preview={props.preview} serverId={props.serverId ?? null} />
    </>;
});

/** Hosts may place this sentence in their existing Request section while family facts stay in the shared body. */
export const ApprovalPreviewSummary = React.memo(function ApprovalPreviewSummary(props: Readonly<{ preview: unknown; request?: ApprovalSummaryInput; serverId?: string | null }>) {
    const language = usePreferredLanguage();
    const { request } = props;
    const settled = React.useMemo(() => request ? readSettledSessionTeamApproval(request) : null, [request]);
    const layoutEffect = React.useMemo(() => request?.actionId === HOME_HUB_LAYOUT_UPDATE_ACTION_ID
        ? readHomeLayoutApprovalEffect(request.actionArgs) : null, [request]);
    const summary = React.useMemo(() => settled || layoutEffect?.kind === 'groupCreate' ? null : readApprovalPreviewSummary(props.preview, request),
        [props.preview, request, language, settled, layoutEffect]);
    if (request && settled) {
        return <SettledSessionTeamPreview request={request} approval={settled} serverId={props.serverId ?? null} />;
    }
    if (request && layoutEffect?.kind === 'groupCreate') {
        return <HomeLayoutGroupPreview {...props} request={request} widgetIds={layoutEffect.widgetIds} />;
    }
    if (props.request?.actionId === 'scm.diffSummary.result.clear') return <ClearApprovalPreview {...props} request={props.request} />;
    return <ApprovalPreviewText summary={summary} />;
});

/** These family consequences remain visible even when the host already renders the review's sentence. */
export const ApprovalPreviewFacts = React.memo(function ApprovalPreviewFacts(props: Readonly<{
    request?: ApprovalSummaryInput;
    preview: unknown;
    serverId?: string | null;
}>) {
    return <>
        {props.request?.actionId === SESSION_SPAWN_NEW_ACTION_ID_V1
            && readRecord(props.preview).teamCredentialDefaults === 'unavailable_without_requester_team'
            ? <SpawnTeamCredentialDefaultsNotice /> : null}
        {props.request?.actionId === SESSION_SPAWN_NEW_ACTION_ID_V1 && <SpawnTeamCredentialSources preview={props.preview} />}
        <MachineAdminAccessPreview request={props.request} serverId={props.serverId ?? null} />
        <MachineSetupRecipePreview request={props.request} preview={props.preview} serverId={props.serverId ?? null} />
    </>;
});

function SpawnTeamCredentialSources(props: Readonly<{ preview: unknown }>) {
    usePreferredLanguage();
    return readTeamCredentialApprovalSources(props.preview).map(source => (
        <AttentionBanner key={source.resourceId} tone="neutral"
            title={t('actionConfirmations.spawnTeamCredentialSource', { team: source.teamName, account: source.accountName })} />
    ));
}

function SpawnTeamCredentialDefaultsNotice() {
    usePreferredLanguage();
    return <AttentionBanner testID="approvals.preview.team-credential-defaults" tone="neutral"
        title={t('actionConfirmations.spawnWithoutTeamCredentialDefaults')} />;
}

/** Apply runs its effect Plans and its sources' scripts; Remove carries sources only as review context. */
function readMachineSetupRecipeTargets(request?: ApprovalSummaryInput) {
    if (request?.actionId === MACHINE_SETUP_APPLY_ACTION_ID_V1) {
        const parsed = MachineSetupApplyInputV1Schema.safeParse(request.actionArgs);
        return parsed.success ? parsed.data.targets : [];
    }
    // A Team setup batch runs the same Machine Apply as its first child.
    if (request?.actionId === TEAM_SETUP_RUN_ACTION_ID_V1) {
        const parsed = TeamSetupBatchInputV1Schema.safeParse(request.actionArgs);
        return parsed.success ? parsed.data.machine?.targets ?? [] : [];
    }
    if (request?.actionId === MACHINE_SETUP_REMOVE_ACTION_ID_V1) {
        const parsed = MachineSetupRemoveInputV1Schema.safeParse(request.actionArgs);
        return parsed.success ? [parsed.data] : [];
    }
    return [];
}

/**
 * The admitting host's preview carries each target Plan's script review; the shared Setup Review owner projects it
 * over the copies this viewer can open. Scripts it cannot place read as not known, never as no change.
 */
function readMachineSetupApprovalScripts(targets: ReturnType<typeof readMachineSetupRecipeTargets>, preview: unknown) {
    const reviews = Array.isArray(readRecord(preview).scripts) ? readRecord(preview).scripts as unknown[] : [];
    return targets.flatMap((target, targetIndex): MachineSetupTargetSourcePresentations[] => {
        if (!('recipePlans' in target)) return [];
        const entry = reviews.map(readRecord).find(candidate => candidate.targetIndex === targetIndex
            && candidate.homeId === target.homeId && candidate.machineId === target.machineId);
        const review = readMachineSetupPlanScriptReviewFacts(entry?.review);
        const presentations = presentUnresolvedMachineSetupSources(target.sources);
        const reviewed = reviewMachineSetupPlanScripts(review, presentations, false);
        return [{ homeId: target.homeId, machineId: target.machineId, ...(reviewed.ok
            ? { sources: reviewed.presentations, ...(reviewed.scripts ? { scripts: reviewed.scripts } : {}) }
            : { sources: presentations, scripts: [{ label: t('machinePresets.setup.review.unknown') }] }) }];
    });
}

function readMachineSetupPlanScriptReviewFacts(value: unknown): MachineSetupPlanScriptReviewFacts | undefined {
    const record = readRecord(value);
    const effects = readRecord(record.presetUpdateEffects);
    const addresses = Array.isArray(effects.scripts) ? effects.scripts.map(readRecord) : null;
    if (typeof effects.toolchain !== 'boolean' || !addresses || addresses.some(address =>
        !Number.isInteger(address.sourceIndex) || !Number.isInteger(address.scriptIndex))) return undefined;
    const steps = Array.isArray(record.steps) ? record.steps.map(step => MachineSetupReviewedStepV1Schema.safeParse(step)) : [];
    return { presetUpdateEffects: { toolchain: effects.toolchain,
        scripts: addresses.map(address => ({ sourceIndex: address.sourceIndex as number, scriptIndex: address.scriptIndex as number })) },
        steps: steps.flatMap(step => step.success ? [step.data] : []) };
}

/** The same change groups the Setup tab's review shows (P-M6), so an agent's setup reads the same everywhere. */
function MachineSetupRecipePreview(props: Readonly<{ request?: ApprovalSummaryInput; preview: unknown; serverId: string | null }>) {
    const targets = readMachineSetupRecipeTargets(props.request);
    const machines = useMachineListForServer(props.serverId ?? '', targets.length > 0 && props.serverId !== null);
    const nameOf = React.useCallback((machineId: string) =>
        getMachineDisplayName(machines?.find(machine => machine.id === machineId)) ?? t('common.unknown'), [machines]);
    const groups = groupMachineSetupChanges(targets, readMachineSetupApprovalScripts(targets, props.preview));
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
                door, target: { machineId: input.machineId, ...((props.serverId ?? input.serverId) ? { serverId: (props.serverId ?? input.serverId)! } : {}) }, tab: { id: 'security' },
            }) as never) }} />
    );
}

function ClearApprovalPreview(props: Readonly<{ preview: unknown; request: ApprovalSummaryInput; serverId?: string | null }>) {
    const reference = readActionApprovalSubject(props.request);
    const reading = useApprovalReferenceReading(reference, '', props.serverId ?? null);
    const subject = reading.named && !reading.resolving ? reading.text : null;
    return <ApprovalPreviewText summary={readApprovalPreviewSummary(props.preview, props.request, subject)} />;
}

function SettledSessionTeamPreview(props: Readonly<{ request: ApprovalSummaryInput; approval: SettledSessionTeamApproval; serverId: string | null }>) {
    const { approval, serverId } = props;
    const reference = approval.kind === 'teamSet' && approval.teamGrantName === null ? approval.team : undefined;
    const { name } = useApprovalPrincipalName(reference, serverId);
    return <ApprovalPreviewText summary={presentActionApproval({ ...props.request, sessionTeamName: name }).summary} />;
}

function HomeLayoutGroupPreview(props: Readonly<{
    preview: unknown; request: ApprovalSummaryInput; serverId?: string | null; widgetIds: readonly string[];
}>) {
    const viewer = useAccountSettingsScope();
    const layout = useApprovalHomeLayoutItemReading(props.serverId ?? null, viewer?.serverId);
    const widgets = props.widgetIds.map(id => layout.readName(id) ?? t('common.unavailable'));
    // The page reads the whole sentence; the tray card draws it in its own bounded line (its render scope).
    return <ApprovalPreviewText summary={readApprovalPreviewSummary(props.preview, props.request, undefined, widgets)} />;
}

/** A host that sets the request's summary sentence in its own line (the composer tray's card) draws it there. */
export type ApprovalPreviewSummaryRender = (summary: string) => React.ReactNode;
const ApprovalPreviewSummaryRenderContext = React.createContext<ApprovalPreviewSummaryRender | null>(null);

/** Places the one summary sentence `ApprovalPreviewSummary` reads in the host's own line; the page's Request section is the default. */
export function ApprovalPreviewSummaryRenderScope(props: Readonly<{ render: ApprovalPreviewSummaryRender; children: React.ReactNode }>) {
    return <ApprovalPreviewSummaryRenderContext.Provider value={props.render}>{props.children}</ApprovalPreviewSummaryRenderContext.Provider>;
}

function ApprovalPreviewText(props: Readonly<{ summary: string | null }>) {
    const render = React.useContext(ApprovalPreviewSummaryRenderContext);
    if (!props.summary) return null;
    if (render) return <>{render(props.summary)}</>;

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
    // What was asked is the section's first fact, read in the ink of the facts below it, never as a muted aside.
    summary: {
        ...Typography.variant('reading'),
        color: theme.colors.text.primary,
    },
}));
