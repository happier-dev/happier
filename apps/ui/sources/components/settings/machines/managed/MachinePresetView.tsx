import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';
import { useHappierCollectionLayout } from '@happier-dev/plugin-ui/presentation';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { useLocalSearchParams, useRouter } from '@/components/appShell/workspace/destinationRoute';
import { useActionApprovalContinuation } from '@/components/approvals/useActionApprovalContinuation';
import type { ActionApprovalRegistration } from '@/components/approvals/actionApprovalContinuation';
import { AttentionBanner } from '@/components/ui/lists/AttentionBanner';
import { RowArrivalReveal } from '@/components/settings/shell/SettingRow';
import { Icon } from '@/components/ui/icons/Icon';
import { ItemList } from '@/components/ui/lists/ItemList';
import { PageHeader } from '@/components/ui/layout/PageHeader';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Switch } from '@/components/ui/forms/Switch';
import { SegmentedChoiceItem } from '@/components/ui/lists/SegmentedChoiceItem';
import { machinePresetEditDraftUpdatePatch } from '@/sync/domains/machines/presets/machinePresetEditDraft';
import { SectionActionButton } from '@/components/ui/lists/SectionActionButton';
import { useTeamBinding } from '@/hooks/teams/useTeamBinding';
import { getServerProfileById, resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';
import { useServerScopedMachine, useMachineListForServer } from '@/sync/domains/state/storage';
import { resolveMachinePickerPresence } from '@/sync/domains/machines/identity/resolveMachinePickerPresence';
import { useMachineReachabilityRevision } from '@/sync/domains/machines/reachability/useMachineReachabilityRevision';
import { useMachinePresenceNowMs } from '@/hooks/machine/useMachinePresenceNowMs';
import { getMachineDisplayName, getMachineSentenceName } from '@/utils/sessions/machineDisplayNames';
import { runGuardedNavigation } from '@/utils/navigation/runGuardedNavigation';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { t } from '@/text';
import { formatMachineBytes } from '@/components/machines/vitals/machineVitalsPresentation';
import { formatAsOfTime } from '@/utils/time/formatAsOfTime';
import { MachinePresetDetail, managedPresetLimitRow, type MachinePresetDetailModel } from './MachinePresetDetail';
import { MachinePresetProjectFilesSection } from './MachinePresetProjectFilesSection';
import { describePreparedImageBuilt, describePresetImage, projectPresetPreparationSteps } from './presetPreparationPresentation';
import { SectionContentRow } from '@/components/ui/lists/SectionContentRow';
import { SetupSteps } from '@/components/ui/setupBlocks/SetupSteps';
import { resolvePresetSharedSections } from './managedPresetReach';
import type { SessionProjectFilesV1 } from '@happier-dev/protocol/sessions/creation/sessionPlacementSelectionV1';
import { buildManagedMachineConfigurationRoute } from './managedMachineConfigurationRoute';
import { isManagedControllerCandidate, useManagedControllerScope } from './useManagedControllerScope';
import { buildManagedConfigurationReceipt, managedCredentialReceiptTargets } from './managedConfigurationPresentation';
import { describeManagedPresetAvailabilityFailure, describeManagedPresetKeyPending } from './managedNativeFailurePresentation';
import { findPresetLastSavedFacts } from './managedPresetHistory';
import { useQualifiedConnectedAccountTargetPresentations } from '@/hooks/server/connectedServices/useQualifiedConnectedAccountTargetPresentations';
import { useMachinePresetDetail, useMachinePresetConfiguration, useMachinePresetPreparation } from './useMachinePresets';
import { useManagedProvisioners } from './useManagedProvisioners';
import { ManagedPresetMark, MANAGED_PROVISIONER_MARK_SIZE, useManagedProvisionerPresentation } from './useManagedProvisionerPresentation';
import { hasOpenedManagedMachinePresetCreationV1, type OpenedManagedMachinePresetV1 } from '@/sync/ops/machines/machinePresetCollectionClient';
import { useManagedProvisionerOptionsInput } from './useManagedProvisionerOptionsInput';
import { resolveHomeDisplayLabel } from '@/components/settings/server/homeDisplayName';
import { isAuthoritativeScopedSnapshotRefusal } from '@/sync/domains/scope/scopedSnapshotFacts';
import { ManagedCreationDisabledBanner } from './ManagedMachineStateRow';
import { useManagedMachineRouteScope } from './useManagedMachineRouteScope';
import { KnownHomeGate } from '@/components/sessions/access/KnownHomeGate';
import { ManagedMachineConfigurationView } from './ManagedMachineConfigurationView';
import { useMachinePoolName } from '@/sync/engine/machines/useMachinePoolProjections';
import { describeActionOperationStatusLabel, resolveActionOperationStatus } from '@/components/inbox/actionOperations/actionOperationPresentation';
import { isActionOperationTerminal } from '@/sync/domains/actionOperations/actionOperationStore';

/**
 * "Prepare ahead" (lab scene 5): one sheet right after Setup, because it bakes that setup. The preference row, then
 * the image's state with its one next step, then where it builds. The builder is a visible Machine choice; an old
 * operation keeps its own admitted address.
 */
type PresetPreparation = NonNullable<OpenedManagedMachinePresetV1['preparation']>;
type WhenHappierUpdates = NonNullable<PresetPreparation['whenHappierUpdates']>;

function MachinePresetPrepareSection(props: Readonly<{
    serverId: string; preset: OpenedManagedMachinePresetV1; canManage: boolean; busy: boolean; onChanged: () => void;
    /** Whether the receipt's billing fact bills anyone; a No bill preset drops the provider charge clause. */
    bills: boolean;
    /** The preference as it will be after any edit still being saved; the switch and the update choice edit it. */
    preparation: PresetPreparation;
    onPreparationChange?: (next: PresetPreparation) => void;
}>) {
    const target = useManagedControllerScope({ serverId: props.serverId, preferred: props.preset.controller,
        delegatedPreset: props.preset.controller !== undefined, observeThisComputer: false,
        disabled: !props.canManage || props.busy, testIDPrefix: 'machine-preset.preparation.target' });
    const machineId = props.preset.controller?.machineId ?? target.controller?.machineId ?? null;
    const preparation = useMachinePresetPreparation({ serverId: props.serverId, preset: props.preset,
        machineId, onChanged: props.onChanged });
    const operation = preparation.operation;
    const active = !preparation.interrupted && (preparation.awaitingOperation
        || operation !== null && !isActionOperationTerminal(operation.snapshot.state));
    const retry = preparation.interrupted || preparation.reportedStatus === 'failed' || preparation.reportedStatus === 'cancelled'
        || operation?.snapshot.state === 'failed' || operation?.snapshot.state === 'cancelled';
    // The image's reported state in the one owner's words (the Presets table says the same): "Image ready", "Image out
    // of date", "Not built yet". A live operation, an interruption or a failed request says its own word first.
    const image = describePresetImage({ ...props.preset, preparation: props.preparation }, preparation.readySummary);
    const settledReady = preparation.reportedStatus === 'ready' && !active && !retry;
    const status = preparation.error ? t('ui.pluginUi.actionFailed') : preparation.interrupted ? t('voiceAssistant.interrupted')
        : settledReady ? image.word
        : operation
            ? describeActionOperationStatusLabel(resolveActionOperationStatus(operation.snapshot, operation.observation).label)
            : preparation.awaitingOperation ? t('inbox.actionOperations.status.accepted')
                : image.word;
    const disabled = !props.canManage || props.busy || preparation.pending;
    const built = preparation.reportedStatus === 'ready';
    // The row's operations are quiet section actions that keep to their label's line (lab scene 5 "a quiet Rebuild").
    const action = preparation.canCancel ? <SectionActionButton testID="machine-preset.preparation.stop"
            title={t('common.stop')} disabled={disabled || preparation.stopControl.pending || preparation.stopControl.stopRequested}
            loading={preparation.stopControl.pending} onPress={preparation.stopControl.requestStop} />
        : !active ? <SectionActionButton testID={retry ? 'machine-preset.preparation.retry' : 'machine-preset.preparation.prepare'}
            title={retry || preparation.error ? t('common.retry') : built ? t('machinePresets.prepareRebuild') : t('machinePresets.prepareBuild')}
            disabled={disabled || machineId === null} loading={preparation.pending}
            onPress={() => fireAndForget(preparation.prepare(), { tag: 'MachinePresetView.prepare' })} /> : null;
    const enabled = props.preparation.enabled;
    const onChange = props.onPreparationChange;
    // Off, the switch says it all; an image kept from before is Archive's to explain (its cleanup help).
    const showsImage = enabled;
    const summary = preparation.readySummary;
    // A running build names itself and when it started; its owner-named steps follow (lab scene 5 `building`).
    const building = active && operation !== null;
    const startedAt = operation?.snapshot.startedAt ?? operation?.snapshot.createdAt;
    const statusLine = building ? startedAt != null ? t('machinePresets.prepareStarted', { time: formatAsOfTime(startedAt) }) : null
        : describePreparedImageBuilt(summary);
    const steps = building || retry ? projectPresetPreparationSteps(preparation.steps) : [];
    return <ItemGroup testID="machine-preset.prepare" title={t('machinePresets.prepareSection')}
        description={t(props.bills ? 'machinePresets.prepareSectionHelp' : 'machinePresets.prepareSectionHelpLocal')}>
        {/* A standing preference of the preset: a switch, and building is its consequence (lab scene 5). */}
        <Item testID="machine-preset.prepare.keep" title={t('machinePresets.prepareKeep')} subtitle={t('machinePresets.prepareKeepHelp')}
            subtitleLines={0} mode="info" showChevron={false}
            rightElement={<Switch testID="machine-preset.prepare.keep.switch" accessibilityLabel={t('machinePresets.prepareKeep')}
                value={enabled} disabled={!onChange} onValueChange={next => onChange?.({ ...props.preparation, enabled: next })} />} />
        {/* A ready image says when and from which revision it was built (lab scene 5 `ready`), then the storage it keeps
            when the builder measured it; an unknown fact stays unsaid (S1). */}
        {showsImage ? <Item testID="machine-preset.preparation" title={building ? t('machinePresets.prepareBuilding') : status}
            {...(statusLine ? { subtitle: statusLine } : {})}
            subtitleLines={0} mode="info" showChevron={false}
            loading={active && steps.length === 0} rightElement={action ?? undefined} /> : null}
        {showsImage && steps.length > 0 ? <SectionContentRow testID="machine-preset.preparation.steps" continuesRow>
            <SetupSteps variant="compact" steps={steps} testID="machine-preset.preparation.step" />
        </SectionContentRow> : null}
        {/* The storage a ready image keeps is its own line (lab scene 5), said only when the builder measured it. */}
        {showsImage && summary?.storageBytes != null ? <Item testID="machine-preset.preparation.storage" title={t('machinePresets.prepareStorage')}
            subtitle={t('machinePresets.prepareStorageKept', { size: formatMachineBytes(summary.storageBytes, 'storage') })}
            subtitleLines={0} mode="info" showChevron={false} /> : null}
        {/* Only while an image is kept ready: what a Happier update does to it, with its cost (lab F5). */}
        {enabled ? <SegmentedChoiceItem<WhenHappierUpdates> testID="machine-preset.prepare.updates" testIDPrefix="machine-preset.prepare.updates"
            title={t('machinePresets.prepareUpdates')} disabled={!onChange}
            value={props.preparation.whenHappierUpdates ?? 'update-at-start'}
            onChange={next => onChange?.({ ...props.preparation, whenHappierUpdates: next })}
            options={[
                { id: 'update-at-start', label: t('machinePresets.prepareUpdateAtStart'), description: t('machinePresets.prepareUpdateAtStartHelp') },
                { id: 'rebuild-automatically', label: t('machinePresets.prepareRebuildAutomatically'), description: t('machinePresets.prepareRebuildAutomaticallyHelp') },
            ]} /> : null}
        {showsImage && !props.preset.controller && target.chip ? <Item testID="machine-preset.prepare.builder" title={t('managedMachines.config.managedFrom')}
            mode="info" showChevron={false} accessoryLayout="adaptive" rightElement={target.chip} /> : null}
    </ItemGroup>;
}

function parameter(value: string | string[] | undefined): string {
    return (Array.isArray(value) ? value[0] : value)?.trim() ?? '';
}

export function MachinePresetScreen() {
    const params = useLocalSearchParams<{ presetId?: string | string[]; serverId?: string | string[]; edit?: string | string[] }>();
    const serverId = useManagedMachineRouteScope(params.serverId);
    // A setup-only preset has no provisioner to open the editor under, so its Edit opens the same editor here.
    return <KnownHomeGate serverId={serverId} testIDPrefix="managed-route">{parameter(params.edit) === 'true'
        ? <ManagedMachineConfigurationView serverId={serverId} provisioner="" presetId={parameter(params.presetId)} presetOnly />
        : <MachinePresetView serverId={serverId} presetId={parameter(params.presetId)} />}</KnownHomeGate>;
}

/** The preset is a future launch; opening it and its history never submits an allocation. */
export function MachinePresetView(props: Readonly<{ serverId: string; presetId: string }>) {
    const serverId = resolveServerProfileScopeIdForIdentifier(props.serverId) || props.serverId;
    return <MachinePresetViewBody key={JSON.stringify([serverId, props.presetId])} serverId={serverId} presetId={props.presetId} />;
}

function MachinePresetViewBody(props: Readonly<{ serverId: string; presetId: string }>) {
    useMachineReachabilityRevision();
    const { theme } = useUnistyles();
    const router = useRouter();
    const layout = useHappierCollectionLayout();
    const approvalHandler = React.useRef<(registration: ActionApprovalRegistration) => void>(() => {});
    const onApprovalPending = React.useCallback((registration: ActionApprovalRegistration) => approvalHandler.current(registration), []);
    const detail = useMachinePresetDetail(props.serverId, props.presetId, onApprovalPending);
    const approval = useActionApprovalContinuation({ scopeKey: JSON.stringify([props.serverId, detail.accountId, props.presetId]),
        serverId: props.serverId, onExecuted: detail.refresh });
    approvalHandler.current = approval.requestApproval;
    const preset = detail.state.value?.preset;
    const delegated = preset?.teamAcquireDelegated === true;
    // Creation (launch + controller) is optional: a setup-only preset makes no Machines and reads no provider catalog.
    const creation = hasOpenedManagedMachinePresetCreationV1(preset) ? preset : undefined;
    const controllerRow = useServerScopedMachine(props.serverId, creation?.controller?.machineId ?? '');
    const controller = creation?.controller && controllerRow?.id === creation.controller.machineId
        && controllerRow.installationId === creation.controller.installationId ? controllerRow : undefined;
    const privateController = !delegated && controller ? creation?.controller : undefined;
    const catalog = useManagedProvisioners(props.serverId, onApprovalPending, privateController,
        { enabled: !!creation && !delegated && (!creation.controller || !!controller) });
    const providerKey = creation ? buildQualifiedPluginContributionKey(creation.launch.provider) : null;
    const provisioner = catalog.provisioners.find(row => buildQualifiedPluginContributionKey(row.contribution) === providerKey);
    const presentation = useManagedProvisionerPresentation({ serverId: props.serverId, controller: privateController, accountScope: catalog.binding?.scope, provisioner,
        provider: creation?.launch.provider, schemaVersion: creation?.launch.schemaVersion });
    const optionsInput = useManagedProvisionerOptionsInput({ binding: catalog.binding, controller: privateController, provisioner: delegated ? undefined : provisioner });
    const team = useTeamBinding(props.serverId, preset?.owner.kind === 'team' ? preset.owner.teamId : '');
    const teamState = team.kind === 'bound' && team.state.kind === 'ready' ? team.state : null;
    const machines = useMachineListForServer(props.serverId);
    const presenceNowMs = useMachinePresenceNowMs(machines ?? []);
    const [mutating, setMutating] = React.useState(false);
    type EditPatch = Parameters<typeof detail.update>[0];
    const [pendingEdit, setPendingEdit] = React.useState<EditPatch | null>(null);
    const [savingEdit, setSavingEdit] = React.useState<EditPatch | null>(null);
    const [mutationError, setMutationError] = React.useState<string | null>(null);
    const revealArchiveFeedback = React.useRef(false);
    const busy = mutating || approval.approvalPending;
    const teamDenied = preset?.owner.kind === 'team' && (teamState?.team.capabilities.viewTeam === false
        || (team.kind === 'bound' && team.state.kind === 'unavailable' && isAuthoritativeScopedSnapshotRefusal(team.state.error)));
    const visiblePreset = teamDenied ? undefined : preset;
    const visibleCreation = teamDenied ? undefined : creation;
    // A pool-backed preset is managed by whichever connected machine in its pool takes it: the page names the pool.
    const poolName = useMachinePoolName(props.serverId, visiblePreset?.controllerPoolId ?? null);
    const credentialTargets = React.useMemo(() => visibleCreation ? managedCredentialReceiptTargets(visibleCreation.launch) : [], [visibleCreation?.launch]);
    const credentialAccounts = useQualifiedConnectedAccountTargetPresentations({ binding: catalog.binding, targets: credentialTargets });
    const configuration = useMachinePresetConfiguration({ binding: catalog.binding, resolution: catalog.resolution, client: catalog.client, homeId: catalog.homeId,
        preset: visiblePreset, provisioner, optionsInput, onApprovalPending, refreshPreset: detail.refresh, refreshRevision: detail.refreshRevision,
        catalogReading: catalog.reading, onOccurrenceStale: catalog.refresh });
    const canManage = visiblePreset?.owner.kind === 'account'
        ? visiblePreset.owner.accountId === detail.accountId
        : Boolean(teamState?.mutationsAvailable && teamState.team.capabilities.manageSettings);
    const canUse = visiblePreset?.owner.kind === 'account'
        ? visiblePreset.owner.accountId === detail.accountId
        : Boolean(teamState?.team.capabilities.viewTeam);
    const mark = presentation.mark;
    const rowMark = presentation.markAt(MANAGED_PROVISIONER_MARK_SIZE.row);
    const homeName = resolveHomeDisplayLabel(getServerProfileById(props.serverId), props.serverId);
    const navigate = (href: string) => {
        const result = runGuardedNavigation(() => router.push(href as never));
        if (result !== true) fireAndForget(result, { tag: 'MachinePresetView.navigate' });
    };
    const openConfiguration = (edit: boolean) => {
        if (!visibleCreation) return;
        const contribution = buildQualifiedPluginContributionKey(visibleCreation.launch.provider);
        navigate(buildManagedMachineConfigurationRoute({ serverId: props.serverId, provisioner: contribution, presetId: visibleCreation.id,
            ...(edit ? { presetOnly: true } : {}) }));
    };
    const runMutation = React.useCallback(async (mutation: () => ReturnType<typeof detail.archiveOrRestore>, revealFeedback = false) => {
        if (!canManage || busy) return;
        revealArchiveFeedback.current = revealFeedback;
        setMutating(true);
        setMutationError(null);
        try {
            const result = await mutation();
            if (result.kind === 'failed') setMutationError(result.code);
            if (result.kind === 'failed' || (result.kind === 'succeeded' && result.value.kind !== 'saved')) {
                setPendingEdit(null);
            }
        } catch {
            setMutationError('request_failed');
            setPendingEdit(null);
        }
        finally { setMutating(false); }
    }, [canManage, busy]);
    const archiveOrRestore = () => runMutation(detail.archiveOrRestore, preset?.archivedAt === undefined);
    const edit = (patch: EditPatch) => {
        if (canManage) setPendingEdit(current => ({ ...current, ...patch }));
    };
    React.useEffect(() => {
        if (!pendingEdit || busy || !canManage) return;
        setPendingEdit(null);
        setSavingEdit(pendingEdit);
        // Drain after rendering the saved revision, so the next Action reviews that revision.
        fireAndForget(runMutation(() => detail.update(pendingEdit)).finally(() => setSavingEdit(null)), { tag: 'MachinePresetView.edit' });
    }, [pendingEdit, busy, canManage, detail.update, runMutation]);
    const desiredEdit = { ...savingEdit, ...pendingEdit };
    // Prepare ahead is private content: the one editor draft carries it, with the preset's own name, setup and launch.
    const desiredPreparation: PresetPreparation = desiredEdit.privateContent?.preparation ?? preset?.preparation ?? { enabled: false };
    // Project files is private content too: every in-place edit carries both, so one never drops the other.
    const desiredProjectFiles = desiredEdit.privateContent ? desiredEdit.privateContent.projectFiles : preset?.projectFiles;
    // The Credential broker opt-in is private content as well, carried by the same full edit.
    const desiredBroker = (desiredEdit.privateContent ? desiredEdit.privateContent.credentialBroker : preset?.credentialBroker) === true;
    const editContent = (next: Readonly<{ preparation?: PresetPreparation; projectFiles?: SessionProjectFilesV1; credentialBroker?: boolean }>) => {
        if (!creation) return;
        const projectFiles = next.projectFiles ?? desiredProjectFiles;
        const credentialBroker = next.credentialBroker ?? desiredBroker;
        const preparation = next.preparation ?? (desiredEdit.privateContent ? desiredEdit.privateContent.preparation : preset?.preparation);
        edit(machinePresetEditDraftUpdatePatch({ name: creation.name, setup: creation.setup,
            ...(preparation ? { preparation } : {}), ...(projectFiles ? { projectFiles } : {}),
            ...(credentialBroker ? { credentialBroker: true } : {}),
            creation: { launch: creation.launch,
                ...(creation.controllerPoolId ? { controllerPoolId: creation.controllerPoolId } : creation.controller ? { controller: creation.controller } : {}),
                ...(creation.retention ? { retention: creation.retention } : {}),
                ...(creation.wakeOnAcceptedMessage !== undefined ? { wakeOnAcceptedMessage: creation.wakeOnAcceptedMessage } : {}),
                ...(creation.simultaneousLimit ? { simultaneousLimit: creation.simultaneousLimit } : {}) } }));
    };
    const approvalNotice = approval.approvalId ? <AttentionBanner testID="machine-preset.approval" tone="neutral"
        title={t('approvals.title')} description={t('approvals.status.open')}
        action={{ label: t('approvals.details'), onPress: () => navigate(`/inbox/approvals/${encodeURIComponent(approval.approvalId!)}?serverId=${encodeURIComponent(props.serverId)}`) }} /> : null;
    const keyPending = describeManagedPresetKeyPending(detail.state.error);
    if (!visiblePreset) return <ItemList><PageHeader title={t('machinePresets.title')} description={t('machinePresets.futureOnly')} />
        {approvalNotice}
        <SurfaceStateCard testID="machine-preset.read-state" kind={detail.state.loading ? 'loading' : teamDenied ? 'denied' : 'unavailable'}
            title={keyPending?.title ?? (detail.state.loading ? t('machinePresets.loading') : teamDenied || detail.state.error === 'permission_denied'
                || detail.state.error === 'preset_not_found' || detail.state.error === 'signed_out' ? t('machinePresets.accessLost') : t('machinePresets.loadFailed'))}
            reason={keyPending?.reason} diagnosticCode={keyPending ? undefined : detail.state.error}
            action={detail.state.loading || keyPending ? undefined : { label: t('common.retry'), onPress: detail.refresh }} />
    </ItemList>;

    // Named apart from same-named machines in this Home, as the Machines list and the configurator chip name it.
    // A controller with no readable name is "the computer that manages it" in sentences, never "Unknown".
    const knownControllerName = getMachineDisplayName(controller, machines ?? undefined) ?? visiblePreset.controllerDisplayName;
    const pooled = visiblePreset.controllerPoolId !== undefined;
    const controllerName = pooled ? poolName ?? t('machinePresets.controllerPoolAny')
        : knownControllerName ?? t('managedMachines.receipt.managingComputer');
    const controllerSentenceName = pooled ? poolName ? t('machinePresets.controllerPoolIn', { pool: poolName }) : t('machinePresets.controllerPoolInUnnamed')
        : controller ? getMachineSentenceName(controller, controllerName) : controllerName;
    const memberCreateOn = (desiredEdit.teamAcquireDelegated ?? visiblePreset.teamAcquireDelegated) === true;
    const desiredLimit = desiredEdit.simultaneousLimit === undefined ? visiblePreset.simultaneousLimit : desiredEdit.simultaneousLimit;
    const desiredController = desiredEdit.controller ?? visibleCreation?.controller;
    const presenceOf = (machine: NonNullable<typeof controller>) =>
        resolveMachinePickerPresence(machine, presenceNowMs, catalog.binding?.isCurrent() ? catalog.binding.scope : null);
    const presenceLabel = (machine: NonNullable<typeof controller>) => {
        const presence = presenceOf(machine);
        return presence.status === 'online' ? t('status.online') : presence.status === 'offline' ? t('status.offline') : t('common.unknown');
    };
    // Managed from is edited in place among this Home's machines that can manage; the server re-checks the launch on it.
    const controllerChoices = canManage ? (machines ?? []).filter(isManagedControllerCandidate) : [];
    const ownerTitle = visiblePreset.owner.kind === 'account' ? t('machinePresets.onlyYou')
        : teamState?.team.name ?? t('common.loading');
    const conflict = detail.mutationResult?.kind === 'conflict';
    const refusal = detail.mutationResult?.kind === 'refused' ? detail.mutationResult.code : null;
    const archived = visiblePreset.archivedAt !== undefined;
    const cleanupRequired = visiblePreset.prepared?.status === 'cancelled'
        && visiblePreset.prepared.code === 'preparation_cleanup_required';
    const cleanupHostId = cleanupRequired ? visiblePreset.prepared?.binding?.machineId : undefined;
    const cleanupHost = cleanupHostId
        ? getMachineDisplayName(machines?.find(machine => machine.id === cleanupHostId), machines ?? undefined) ?? cleanupHostId
        : t('common.unknown');
    // The archived notice owns the state and its way back; Archive closes an active preset's page.
    const restore = canManage && archived ? () => fireAndForget(archiveOrRestore(), { tag: 'MachinePresetView.restore' }) : undefined;
    const archiveActions = canManage && !archived ? { onArchive: () => fireAndForget(archiveOrRestore(), { tag: 'MachinePresetView.archive' }) } : {};
    // Why this preset can't create here is said once, by the line above the page; Create one then waits for it.
    const configurationUnavailable = configuration.unavailable;
    const cannotCreateHere = Boolean(catalog.error) || configurationUnavailable;
    // That line is the page's one cause: Managed from and the receipt inherit it rather than restating it.
    const causeShown = !archived && cannotCreateHere;
    // Archive is below the fold; reveal its existing feedback inside the page scroller.
    const notice = <RowArrivalReveal testID="machine-preset.feedback-reveal"
        active={revealArchiveFeedback.current && (approval.approvalPending || (!mutating && Boolean(conflict || mutationError || refusal)))}>
        <>{approvalNotice}
        {configuration.creationDisabled ? <ManagedCreationDisabledBanner testID="machine-preset.creation-disabled" /> : null}
        {archived ? <AttentionBanner testID="machine-preset.archived" tone={cleanupRequired ? 'warning' : 'neutral'} title={t('machinePresets.archived')}
            description={cleanupRequired ? t('machinePresets.preparedImageCleanupRequired', { host: cleanupHost }) : undefined}
            action={restore ? { label: t('common.restore'), onPress: restore, loading: busy, disabled: busy } : undefined} /> : null}
        {/* The page's one cause, on the sections' column edge. */}
        {(!archived && (catalog.error || configurationUnavailable)) || detail.state.error || conflict || mutationError || refusal
            ? <ItemGroup surface="none">
            {/* Why a preset can't create is moot once it is archived: its notice is the one message. */}
            {!archived && catalog.error ? <SurfaceStateCard testID="machine-preset.provider-error" kind="unavailable" size="line"
                title={t('managedMachines.providers.unavailable')} diagnosticCode={catalog.error}
                action={{ label: t('common.retry'), onPress: catalog.refresh }} /> : null}
            {/* The provider not answering is the one cause; its options failing with it says nothing new. */}
            {!archived && !catalog.error && configurationUnavailable ? <SurfaceStateCard testID="machine-preset.configuration-unavailable"
                kind="unavailable" size="line" title={configuration.error ? describeManagedPresetAvailabilityFailure(configuration.error) : t('managedMachines.options.unavailable')} diagnosticCode={configuration.error ?? undefined}
                action={{ label: t('common.retry'), onPress: configuration.refresh }} /> : null}
            {detail.state.error ? <SurfaceStateCard testID="machine-preset.refresh-error" kind="unavailable" size="line" lineLayout="notice"
                title={keyPending?.title ?? t('machinePresets.loadFailed')} reason={keyPending?.reason}
                diagnosticCode={keyPending ? undefined : detail.state.error}
                action={keyPending ? undefined : { label: t('common.retry'), onPress: detail.refresh }} /> : null}
            {conflict || mutationError || refusal ? <SurfaceStateCard testID="machine-preset.mutation-error" kind="error" size="line"
                title={conflict ? t('machinePresets.conflict') : refusal === 'permission_denied' ? t('machinePresets.accessLost')
                    : revealArchiveFeedback.current ? t('machinePresets.archiveFailed') : t('machinePresets.loadFailed')}
                diagnosticCode={mutationError ?? refusal ?? undefined} action={{ label: t(conflict ? 'managedMachines.actions.review' : 'common.retry'), onPress: () => { setMutationError(null); detail.refresh(); } }} /> : null}
        </ItemGroup> : null}
        </>
    </RowArrivalReveal>;
    // What it puts on a Machine leads the page; whoever can manage it edits it in the one editor.
    const editSetup = canManage && !archived ? visibleCreation ? () => openConfiguration(true)
        : () => navigate(`/settings/machines/presets/${encodeURIComponent(visiblePreset.id)}?serverId=${encodeURIComponent(props.serverId)}&edit=true`) : undefined;
    const setup: MachinePresetDetailModel['setup'] = { value: visiblePreset.setup, scope: detail.scope, ...(editSetup ? { onEdit: editSetup } : {}) };
    const audience: MachinePresetDetailModel['audience'] = { title: ownerTitle,
        description: visiblePreset.owner.kind === 'account' ? t('machinePresets.audiencePersonalHelp') : undefined,
        leading: <Icon name={visiblePreset.owner.kind === 'team' ? 'users' : 'user-circle'} color={theme.colors.text.secondary} />,
        subtitle: [canUse ? t('machinePresets.canUse') : null, canManage ? t('machinePresets.canManage') : null].filter(Boolean).join(' · ') };
    // A setup-only preset: what it sets up, who can use it, and archive; nothing about creating Machines.
    if (!visibleCreation) return <MachinePresetDetail compact={layout?.mode !== 'split'} testID="machine-preset.detail" model={{
        name: visiblePreset.name, setup,
        mark: <ManagedPresetMark serverId={props.serverId} preset={visiblePreset} size={MANAGED_PROVISIONER_MARK_SIZE.header} />,
        description: t('machinePresets.setupOnlyPurpose'),
        meta: [{ key: 'home', text: homeName }, { key: 'owner', text: visiblePreset.owner.kind === 'account' ? t('machinePresets.ownerPersonal') : ownerTitle }],
        audience,
        // Its setup facts are the receipt's rows; a spec line would only repeat them.
        receipt: { caption: t('machinePresets.setup.title'), name: visiblePreset.name,
            mark: <ManagedPresetMark serverId={props.serverId} preset={visiblePreset} size={MANAGED_PROVISIONER_MARK_SIZE.receipt} />,
            spec: '', facts: [], cost: null, ...(visiblePreset.setup ? { setup: visiblePreset.setup } : {}),
            // The same Edit as a preset that creates Machines, into the one editor.
            ...(canManage && visiblePreset.archivedAt === undefined ? { secondary: [{ label: t('machinePresets.editSetup'), testID: 'machine-preset.edit',
                onPress: () => navigate(`/settings/machines/presets/${encodeURIComponent(visiblePreset.id)}?serverId=${encodeURIComponent(props.serverId)}&edit=true`),
                disabled: busy }], secondaryNote: t('machinePresets.setupOnlyEditNote') } : {}) },
        archiveHelp: t('machinePresets.archiveSetupHelp'),
        ...archiveActions, archivePending: busy, notice,
    }} />;
    const lastSaved = findPresetLastSavedFacts({ launch: visibleCreation.launch, history: detail.history });
    const receipt = buildManagedConfigurationReceipt({ launch: visibleCreation.launch, reviewedFacts: configuration.facts ?? undefined,
        savedLaunchPresentation: presentation.savedLaunchPresentation,
        credentialPresentations: credentialAccounts.presentationsByKey, ...(lastSaved ? { lastSaved } : {}),
        providerTitle: presentation.title, localized: presentation.localized,
        controllerName, homeName,
        ...(pooled ? { pooledController: { sentenceName: controllerSentenceName } } : {}), declaredBilling: presentation.billing, setup: visiblePreset.setup,
        preset: { id: visiblePreset.id, revision: visiblePreset.revision, name: visiblePreset.name },
        presetPolicy: { ...(visiblePreset.retention ? { retention: visiblePreset.retention } : {}),
            ...(visiblePreset.wakeOnAcceptedMessage !== undefined ? { wakeOnAcceptedMessage: visiblePreset.wakeOnAcceptedMessage } : {}) },
        caption: t('managedMachines.receipt.eachOne', { revision: visiblePreset.revision }),
        mark: presentation.markAt(MANAGED_PROVISIONER_MARK_SIZE.receipt), ...(causeShown ? { headroomUnreadable: true } : {}) });
    // "Hetzner server": the provider and what it creates, from the provisioner's own declaration.
    const what = presentation.title && presentation.kindTitle
        ? t('managedMachines.detail.kindFact', { provider: presentation.title, kind: presentation.kindTitle })
        : presentation.title ?? presentation.kindTitle ?? t('common.machine');
    // Where member-made machines are billed: a local VM runs on the controller and bills no one; a cloud one
    // bills the account the preset names, or the provider account its controller holds.
    const credentialAccount = credentialTargets.length === 1 ? credentialAccounts.presentationsByKey[credentialTargets[0]!.key]?.primaryLabel : undefined;
    // Managed from names the controller once, above; here it is the managing computer.
    const managingComputer = t('managedMachines.receipt.managingComputer');
    const memberCreateHelp = receipt.cost?.kind === 'local'
        ? t('machinePresets.memberCreateHelpLocal', { controller: managingComputer })
        : credentialAccount ? t('machinePresets.memberCreateHelpAccount', { controller: managingComputer, account: credentialAccount })
            : t('machinePresets.memberCreateHelp', { controller: managingComputer });
    // Sections for presets made for others wait for the kind, then leave a personal local sandbox preset (decision 3).
    const sharedSections = resolvePresetSharedSections({ ownerKind: visiblePreset.owner.kind,
        descriptor: provisioner?.descriptor, kindLoading: catalog.loading });
    const sessionSandbox = sharedSections !== 'show';
    const model: MachinePresetDetailModel = {
        name: visiblePreset.name, mark, setup,
        // The page says what this preset makes and who may make it; the edit rule sits under Edit choices.
        // An archived preset makes nothing: its notice is the one message, so no creation sentence stands beside it.
        description: archived ? undefined : visiblePreset.owner.kind === 'account' ? t('machinePresets.purposePersonal', { what })
            : teamState ? t(memberCreateOn ? 'machinePresets.purposeTeam' : 'machinePresets.purposeTeamOff', { what, team: teamState.team.name }) : what,
        meta: [{ key: 'home', text: homeName }, { key: 'owner', text: visiblePreset.owner.kind === 'account' ? t('machinePresets.ownerPersonal') : ownerTitle }],
        ...(sessionSandbox ? {} : { audience }),
        ...(teamState ? { memberCreate: { description: memberCreateHelp,
            title: t('machinePresets.memberCreateRow'), value: memberCreateOn, disabled: !canManage || approval.approvalPending, readOnly: !canManage,
            subtitle: !canManage ? t('machinePresets.memberCreateManagersOnly', { team: teamState.team.name })
                : memberCreateOn ? t('machinePresets.memberCreateWithdraw') : undefined,
            onChange: (next: boolean) => edit({ teamAcquireDelegated: next }) } } : {}),
        // A local machine runs on its controller and bills nobody, so the billing caveat only speaks for a cloud one.
        ...(sessionSandbox ? {} : { limit: { ...(receipt.cost?.kind === 'local' ? {} : { description: t('machinePresets.limitHelp') }), row: canManage
            ? managedPresetLimitRow({ limit: desiredLimit?.maximum, disabled: approval.approvalPending,
                onChange: next => edit({ simultaneousLimit: next ? { maximum: next } : null }) })
            : { title: visiblePreset.simultaneousLimit
                ? `${t('machinePresets.atMost')} ${visiblePreset.simultaneousLimit.maximum}` : t('machinePresets.limitNone'),
                ...(visiblePreset.simultaneousLimit ? { subtitle: t('machinePresets.limitWaits') } : {}) } } }),
        // Its row names the controller; the description says only why it matters, and an online controller needs none.
        controller: { description: pooled ? t('machinePresets.controllerPoolHelp')
            : causeShown || controller && presenceOf(controller).status === 'online' ? undefined : t('managedMachines.controller.requiredUnnamed'),
            row: pooled ? { title: controllerName, ...(poolName ? { subtitle: t('machinePresets.controllerPoolAny') } : {}),
                leading: <Icon name="stack" color={theme.colors.text.secondary} /> } : controllerChoices.length ? {
                title: t('machinePresets.controllerRow'),
                ...(controller ? { subtitle: presenceLabel(controller) } : {}),
                choices: controllerChoices.map(machine => ({ id: machine.id, title: getMachineDisplayName(machine, machines ?? undefined) ?? machine.id,
                    subtitle: presenceLabel(machine) })),
                value: desiredController?.machineId, disabled: approval.approvalPending,
                onChange: id => {
                    const machine = controllerChoices.find(candidate => candidate.id === id);
                    if (!machine?.installationId || id === desiredController?.machineId
                        && machine.installationId === desiredController?.installationId) return;
                    edit({ controller: { machineId: machine.id, installationId: machine.installationId }, controllerPoolId: null });
                },
            // The controller's name and presence when this Account can see it; one it can't see says so as its typed
            // state, by the name the preset saved when it has one, never a placeholder without presence (TH D7, D-K).
            } : { title: knownControllerName ?? t('machinePresets.controllerNotShared'),
                ...(controller ? { subtitle: presenceLabel(controller) }
                    : machines && !causeShown ? { subtitle: t('machinePresets.controllerStatusNotShared') } : {}) } },
        // Under "Made from this preset" a row is the machine, who made it and its state (lab m-presets); an
        // older revision says so, since edits apply only to machines made after them.
        machines: detail.history.map(row => ({ id: row.managedId, title: row.title,
            subtitle: [row.machine.custodianAccountId === detail.accountId ? t('machinePresets.historyYou') : null,
                row.presetRevision !== visiblePreset.revision ? t('machinePresets.historyRevision', { revision: row.presetRevision }) : null,
                row.subtitle].filter(Boolean).join(' · '),
            mark: rowMark, onPress: () => navigate(row.href) })),
        // A preset's receipt describes each machine it will make: its cost is one of its facts, not the page's lead.
        receipt: { ...receipt, costPlacement: 'fact',
            ...(canManage ? { secondary: [{ label: t('machinePresets.editChoices'), testID: 'machine-preset.edit', onPress: () => openConfiguration(true), disabled: busy }],
                secondaryNote: t('machinePresets.futureOnly') } : {}) },
        // Create one stays the page's primary while the line above says why it can't create here yet.
        ...(!sessionSandbox && canUse && visiblePreset.archivedAt === undefined && configuration.creationEnabled
            ? { onCreateOne: () => openConfiguration(false), ...(cannotCreateHere ? { createOneDisabled: true } : {}) } : {}),
        // Archive attempts to delete the image it keeps ready; its retained report says when cleanup is needed.
        ...(visiblePreset.preparation?.enabled || visiblePreset.prepared !== undefined
            ? { archiveHelp: t('machinePresets.archivePreparedHelp') } : {}),
        // How each new machine gets the session's folder; an archived preset makes none.
        ...(!archived ? { projectFiles: <MachinePresetProjectFilesSection testID="machine-preset.project-files" value={desiredProjectFiles}
            serverId={props.serverId} machineId={desiredController?.machineId ?? null}
            {...(canManage && !approval.approvalPending ? { onChange: (projectFiles: SessionProjectFilesV1) => editContent({ projectFiles }) } : {})} /> } : {}),
        // Offered wherever its provider can keep an image ready, and kept for a preset that already prepares.
        ...(!archived && (provisioner?.descriptor.preparation || visiblePreset.preparation?.enabled || visiblePreset.prepared)
            ? { prepare: <MachinePresetPrepareSection serverId={props.serverId}
                preset={visiblePreset} canManage={canManage} busy={busy} onChanged={detail.refresh}
                preparation={desiredPreparation} bills={receipt.cost?.kind !== 'local'}
                {...(canManage && !approval.approvalPending ? { onPreparationChange: (preparation: PresetPreparation) => editContent({ preparation }) } : {})} /> } : {}),
        // Each machine it makes can lend connected accounts to the person's other machines; off unless chosen (owner 11-20).
        ...(!archived ? { broker: <ItemGroup testID="machine-preset.broker" title={t('machineDetailPage.roles.title')}>
            <Item testID="machine-preset.broker.row" title={t('machineDetailPage.roles.broker.title')}
                subtitle={t('machineDetailPage.roles.broker.description')}
                rightElement={<Switch testID="machine-preset.broker.switch" accessibilityLabel={t('machineDetailPage.roles.broker.title')}
                    value={desiredBroker} disabled={!canManage || approval.approvalPending}
                    onValueChange={next => editContent({ credentialBroker: next })} />} />
        </ItemGroup> } : {}),
        ...archiveActions,
        archivePending: busy, notice,
    };
    return <MachinePresetDetail model={model} compact={layout?.mode !== 'split'} testID="machine-preset.detail" />;
}
