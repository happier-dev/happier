import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';
import { useHappierCollectionLayout } from '@happier-dev/plugin-ui/presentation';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { useLocalSearchParams, useRouter } from '@/components/appShell/workspace/destinationRoute';
import { useActionApprovalContinuation } from '@/components/approvals/useActionApprovalContinuation';
import type { ActionApprovalRegistration } from '@/components/approvals/actionApprovalContinuation';
import { AttentionBanner } from '@/components/ui/lists/AttentionBanner';
import { Icon } from '@/components/ui/icons/Icon';
import { ItemList } from '@/components/ui/lists/ItemList';
import { PageHeader } from '@/components/ui/layout/PageHeader';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { useTeamBinding } from '@/hooks/teams/useTeamBinding';
import { getServerProfileById, resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';
import { useMachineListForServer, useServerScopedMachine } from '@/sync/domains/state/storage';
import { isMachineOnline } from '@/utils/sessions/machineUtils';
import { getMachineDisplayName } from '@/utils/sessions/machineDisplayNames';
import { runGuardedNavigation } from '@/utils/navigation/runGuardedNavigation';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { t } from '@/text';
import { MachinePresetDetail, managedPresetLimitRow, type MachinePresetDetailModel } from './MachinePresetDetail';
import { isManagedControllerCandidate } from './useManagedControllerScope';
import { buildManagedConfigurationReceipt, managedCredentialReceiptTargets } from './managedConfigurationPresentation';
import { useQualifiedConnectedAccountTargetPresentations } from '@/hooks/server/connectedServices/useQualifiedConnectedAccountTargetPresentations';
import { useMachinePresetDetail, useMachinePresetConfiguration } from './useMachinePresets';
import { useManagedProvisioners } from './useManagedProvisioners';
import { useManagedProvisionerPresentation } from './useManagedProvisionerPresentation';
import { useManagedProvisionerOptionsInput } from './useManagedProvisionerOptionsInput';
import { resolveHomeDisplayLabel } from '@/components/settings/server/homeDisplayName';
import { isAuthoritativeScopedSnapshotRefusal } from '@/sync/domains/scope/scopedSnapshotFacts';
import { ManagedCreationDisabledBanner } from './ManagedMachineStateRow';

function parameter(value: string | string[] | undefined): string {
    return (Array.isArray(value) ? value[0] : value)?.trim() ?? '';
}

export function MachinePresetScreen() {
    const params = useLocalSearchParams<{ presetId?: string | string[]; serverId?: string | string[] }>();
    return <MachinePresetView serverId={parameter(params.serverId)} presetId={parameter(params.presetId)} />;
}

/** The preset is a future recipe; opening it and its history never submits an allocation. */
export function MachinePresetView(props: Readonly<{ serverId: string; presetId: string }>) {
    const serverId = resolveServerProfileScopeIdForIdentifier(props.serverId) || props.serverId;
    return <MachinePresetViewBody key={JSON.stringify([serverId, props.presetId])} serverId={serverId} presetId={props.presetId} />;
}

function MachinePresetViewBody(props: Readonly<{ serverId: string; presetId: string }>) {
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
    const catalog = useManagedProvisioners(props.serverId, onApprovalPending, preset?.controller);
    const providerKey = preset ? buildQualifiedPluginContributionKey(preset.recipe.provider) : null;
    const provisioner = catalog.provisioners.find(row => buildQualifiedPluginContributionKey(row.contribution) === providerKey);
    const presentation = useManagedProvisionerPresentation({ serverId: props.serverId, controller: preset?.controller, provisioner });
    const optionsInput = useManagedProvisionerOptionsInput({ binding: catalog.binding, controller: preset?.controller, provisioner,
        projection: presentation.projection, projectionReady: presentation.projectionReady });
    const team = useTeamBinding(props.serverId, preset?.owner.kind === 'team' ? preset.owner.teamId : '');
    const teamState = team.kind === 'bound' && team.state.kind === 'ready' ? team.state : null;
    const controllerRow = useServerScopedMachine(props.serverId, preset?.controller.machineId ?? '');
    const machines = useMachineListForServer(props.serverId);
    const controller = controllerRow?.installationId === preset?.controller.installationId ? controllerRow : undefined;
    const [mutating, setMutating] = React.useState(false);
    const [mutationError, setMutationError] = React.useState<string | null>(null);
    const busy = mutating || approval.approvalPending;
    const teamDenied = preset?.owner.kind === 'team' && (teamState?.team.capabilities.viewTeam === false
        || (team.kind === 'bound' && team.state.kind === 'unavailable' && isAuthoritativeScopedSnapshotRefusal(team.state.error)));
    const visiblePreset = teamDenied ? undefined : preset;
    const credentialTargets = React.useMemo(() => visiblePreset ? managedCredentialReceiptTargets(visiblePreset.recipe) : [], [visiblePreset?.recipe]);
    const credentialAccounts = useQualifiedConnectedAccountTargetPresentations({ binding: catalog.binding, targets: credentialTargets });
    const configuration = useMachinePresetConfiguration({ binding: catalog.binding, client: catalog.client, homeId: catalog.homeId,
        preset: visiblePreset, provisioner, optionsInput, onApprovalPending });
    const canManage = visiblePreset?.owner.kind === 'account'
        ? visiblePreset.owner.accountId === detail.accountId
        : Boolean(teamState?.mutationsAvailable && teamState.team.capabilities.manageSettings);
    const canUse = visiblePreset?.owner.kind === 'account'
        ? visiblePreset.owner.accountId === detail.accountId
        : Boolean(teamState?.team.capabilities.viewTeam);
    const mark = presentation.mark;
    const homeName = resolveHomeDisplayLabel(getServerProfileById(props.serverId), props.serverId);
    const navigate = (href: string) => {
        const result = runGuardedNavigation(() => router.push(href as never));
        if (result !== true) fireAndForget(result, { tag: 'MachinePresetView.navigate' });
    };
    const openConfiguration = (edit: boolean) => {
        if (!visiblePreset) return;
        const contribution = buildQualifiedPluginContributionKey(visiblePreset.recipe.provider);
        navigate(`/settings/machines/add/${encodeURIComponent(contribution)}?serverId=${encodeURIComponent(props.serverId)}&presetId=${encodeURIComponent(visiblePreset.id)}${edit ? '&presetOnly=true' : ''}`);
    };
    const runMutation = async (mutation: () => ReturnType<typeof detail.archiveOrRestore>) => {
        if (!canManage || busy) return;
        setMutating(true);
        setMutationError(null);
        try {
            const result = await mutation();
            if (result.kind === 'failed') setMutationError(result.code);
        } catch { setMutationError('request_failed'); }
        finally { setMutating(false); }
    };
    const archiveOrRestore = () => runMutation(detail.archiveOrRestore);
    const edit = (patch: Parameters<typeof detail.update>[0]) => fireAndForget(runMutation(() => detail.update(patch)), { tag: 'MachinePresetView.edit' });
    const approvalNotice = approval.approvalId ? <AttentionBanner testID="machine-preset.approval" tone="neutral"
        title={t('approvals.title')} description={t('approvals.status.open')}
        action={{ label: t('approvals.details'), onPress: () => navigate(`/inbox/approvals/${encodeURIComponent(approval.approvalId!)}?serverId=${encodeURIComponent(props.serverId)}`) }} /> : null;
    if (!visiblePreset) return <ItemList><PageHeader title={t('machinePresets.title')} description={t('machinePresets.futureOnly')} />
        {approvalNotice}
        <SurfaceStateCard testID="machine-preset.read-state" kind={detail.state.loading ? 'loading' : teamDenied ? 'denied' : 'unavailable'}
            title={detail.state.loading ? t('machinePresets.loading') : teamDenied || detail.state.error === 'permission_denied'
                || detail.state.error === 'preset_not_found' || detail.state.error === 'signed_out' ? t('machinePresets.accessLost') : t('machinePresets.loadFailed')}
            diagnosticCode={detail.state.error ?? undefined} action={detail.state.loading ? undefined : { label: t('common.retry'), onPress: detail.refresh }} />
    </ItemList>;

    const controllerName = getMachineDisplayName(controller) ?? t('common.unknown');
    // Managed from is edited in place among this Home's machines that can manage; the server re-checks the recipe on it.
    const controllerChoices = canManage ? (machines ?? []).filter(isManagedControllerCandidate) : [];
    const receipt = buildManagedConfigurationReceipt({ launch: visiblePreset.recipe, reviewedFacts: configuration.facts ?? undefined,
        credentialPresentations: credentialAccounts.presentationsByKey,
        providerTitle: presentation.title ?? t('common.unknown'), localized: presentation.localized,
        controllerName, homeName, declaredBilling: provisioner?.descriptor.billing, environment: visiblePreset.environment,
        preset: { id: visiblePreset.id, revision: visiblePreset.revision, name: visiblePreset.name },
        presetPolicy: { ...(visiblePreset.retention ? { retention: visiblePreset.retention } : {}),
            ...(visiblePreset.wakeOnAcceptedMessage !== undefined ? { wakeOnAcceptedMessage: visiblePreset.wakeOnAcceptedMessage } : {}) },
        caption: t('managedMachines.receipt.eachOne', { revision: visiblePreset.revision }), mark });
    const ownerTitle = visiblePreset.owner.kind === 'account' ? t('machinePresets.onlyYou')
        : teamState?.team.name ?? t('common.loading');
    const conflict = detail.mutationResult?.kind === 'conflict';
    const refusal = detail.mutationResult?.kind === 'refused' ? detail.mutationResult.code : null;
    const notice = <>{approvalNotice}
        {configuration.creationDisabled ? <ManagedCreationDisabledBanner testID="machine-preset.creation-disabled" /> : null}
        {visiblePreset.archivedAt !== undefined ? <AttentionBanner testID="machine-preset.archived" tone="neutral" title={t('machinePresets.archived')} /> : null}
        {catalog.error ? <SurfaceStateCard testID="machine-preset.provider-error" kind="unavailable" size="line"
            title={t('managedMachines.providers.unavailable')} diagnosticCode={catalog.error}
            action={{ label: t('common.retry'), onPress: catalog.refresh }} /> : null}
        {configuration.error || configuration.facts?.optionStatus === 'unavailable' ? <SurfaceStateCard testID="machine-preset.configuration-unavailable"
            kind="unavailable" size="line" title={t('managedMachines.options.unavailable')} diagnosticCode={configuration.error ?? undefined}
            action={{ label: t('common.retry'), onPress: configuration.refresh }} /> : null}
        {detail.state.error ? <SurfaceStateCard testID="machine-preset.refresh-error" kind="unavailable" size="line" title={t('machinePresets.loadFailed')}
            diagnosticCode={detail.state.error} action={{ label: t('common.retry'), onPress: detail.refresh }} /> : null}
        {conflict || mutationError || refusal ? <SurfaceStateCard testID="machine-preset.mutation-error" kind="error" size="line"
            title={conflict ? t('machinePresets.conflict') : refusal === 'permission_denied' ? t('machinePresets.accessLost') : t('machinePresets.loadFailed')}
            diagnosticCode={mutationError ?? refusal ?? undefined} action={{ label: t('common.retry'), onPress: () => { setMutationError(null); detail.refresh(); } }} /> : null}
    </>;
    // "Hetzner server": the provider and what it creates, from the provisioner's own declaration.
    const what = presentation.title && presentation.kindTitle
        ? t('managedMachines.detail.kindFact', { provider: presentation.title, kind: presentation.kindTitle })
        : presentation.title ?? presentation.kindTitle ?? t('common.machine');
    const model: MachinePresetDetailModel = {
        name: visiblePreset.name, mark,
        // The page says what this preset makes and who may make it; the edit rule sits under Edit choices.
        description: visiblePreset.owner.kind === 'account' ? t('machinePresets.purposePersonal', { what })
            : teamState ? t('machinePresets.purposeTeam', { what, team: teamState.team.name }) : what,
        meta: [{ key: 'home', text: homeName }, { key: 'owner', text: visiblePreset.owner.kind === 'account' ? t('machinePresets.ownerPersonal') : ownerTitle }],
        audience: { title: ownerTitle, description: visiblePreset.owner.kind === 'account' ? t('machinePresets.audiencePersonalHelp')
            : teamState && presentation.title ? t('machinePresets.audienceTeamHelp', { team: teamState.team.name, provider: presentation.title }) : undefined, leading: <Icon name={visiblePreset.owner.kind === 'team' ? 'users' : 'user'} color={theme.colors.text.secondary} />,
            subtitle: [canUse ? t('machinePresets.canUse') : null, canManage ? t('machinePresets.canManage') : null].filter(Boolean).join(' · ') },
        limit: { description: t('machinePresets.limitHelp'), row: canManage
            ? managedPresetLimitRow({ limit: visiblePreset.simultaneousLimit?.maximum, disabled: busy,
                onChange: next => edit({ simultaneousLimit: next ? { maximum: next } : null }) })
            : { title: visiblePreset.simultaneousLimit
                ? `${t('machinePresets.atMost')} ${visiblePreset.simultaneousLimit.maximum}` : t('machinePresets.limitNone'),
                ...(visiblePreset.simultaneousLimit ? { subtitle: t('machinePresets.limitWaits') } : {}) } },
        controller: { description: t('managedMachines.controller.required', { controller: controllerName }),
            row: controllerChoices.length ? {
                title: t('machinePresets.controllerRow'),
                ...(controller ? { subtitle: isMachineOnline(controller) ? t('status.online') : t('status.offline') } : {}),
                choices: controllerChoices.map(machine => ({ id: machine.id, title: getMachineDisplayName(machine) ?? machine.id,
                    subtitle: isMachineOnline(machine) ? t('status.online') : t('status.offline') })),
                value: visiblePreset.controller.machineId, disabled: busy,
                onChange: id => {
                    const machine = controllerChoices.find(candidate => candidate.id === id);
                    if (!machine?.installationId || id === visiblePreset.controller.machineId
                        && machine.installationId === visiblePreset.controller.installationId) return;
                    edit({ controller: { machineId: machine.id, installationId: machine.installationId } });
                },
            } : { title: controllerName } },
        machines: detail.history.map(row => ({ id: row.managedId, title: row.title,
            subtitle: `${t('machinePresets.fromRevision', { name: visiblePreset.name, revision: row.presetRevision })} · ${row.subtitle}`,
            mark, onPress: () => navigate(row.href) })),
        receipt: { ...receipt,
            ...(canManage ? { secondary: [{ label: t('machinePresets.editChoices'), testID: 'machine-preset.edit', onPress: () => openConfiguration(true), disabled: busy }],
                secondaryNote: t('machinePresets.futureOnly') } : {}) },
        ...(canUse && visiblePreset.archivedAt === undefined && configuration.creationEnabled ? { onCreateOne: () => openConfiguration(false) } : {}),
        ...(canManage ? visiblePreset.archivedAt === undefined ? { onArchive: () => fireAndForget(archiveOrRestore(), { tag: 'MachinePresetView.archive' }) }
            : { onRestore: () => fireAndForget(archiveOrRestore(), { tag: 'MachinePresetView.restore' }) } : {}),
        archivePending: busy, notice,
    };
    return <MachinePresetDetail model={model} compact={layout?.mode !== 'split'} testID="machine-preset.detail" />;
}
