import * as React from 'react';
import { View } from 'react-native';
import type { ManagedControllerV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import type { MachineProvisionersListResultV1 } from '@happier-dev/protocol/plugins/contributions/machineProvisioners';
import { readMachineProvisionerCredentialPurposeSelectorPathsV1 } from '@happier-dev/protocol/plugins/contributions/machineProvisioners';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { useListPresentation } from '@/components/ui/lists/listPresentation';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { useServerProfilesGeneration } from '@/hooks/server/useServerProfilesGeneration';
import { listServerProfiles } from '@/sync/domains/server/serverProfiles';
import { resolveHomeDisplayLabel } from '@/components/settings/server/homeDisplayName';
import { resolveMachinePickerPresence } from '@/sync/domains/machines/identity/resolveMachinePickerPresence';
import { useMachineReachabilityRevision } from '@/sync/domains/machines/reachability/useMachineReachabilityRevision';
import { useMachinePresenceNowMs } from '@/hooks/machine/useMachinePresenceNowMs';
import { formatHappierDataBytes } from '@happier-dev/plugin-ui/presentation';
import { getMachineSentenceName } from '@/utils/sessions/machineDisplayNames';
import { useViewportClass } from '@/utils/platform/useViewportClass';
import { useActionApprovalContinuation } from '@/components/approvals/useActionApprovalContinuation';
import type { ActionApprovalRegistration } from '@/components/approvals/actionApprovalContinuation';
import { AttentionBanner } from '@/components/ui/lists/AttentionBanner';
import { t } from '@/text';
import { getSyncSingleton } from '@/sync/runtime/getSyncSingleton';
import { useManagedProvisioners } from './useManagedProvisioners';
import { readManagedProvisionerAvailability } from './managedProvisionerAvailability';
import { describeManagedProvisionerFailure, useManagedProvisionerPresentation, useManagedProvisionerRuntimeHost } from './useManagedProvisionerPresentation';
import { MachineProvisionerSections, MachineProvisionerSectionsSkeleton } from './MachineProvisionerSections';
import { ManagedScopeRow } from './ManagedScopeRow';
import type { ManagedProvisionerCard } from './managedMachineDisplay';
import { useManagedControllerScope } from './useManagedControllerScope';
import { buildManagedMachineConfigurationRoute } from './managedMachineConfigurationRoute';
import { readMachineProvisionerHostAvailability } from '@happier-dev/cli-common/machines/managed/provisioners';
import { showManagedGetTheAppModal } from './ManagedGetTheAppModal';
import { homeAdministrationReachPath } from '@/components/settings/home/governance/homeAdministrationRoutes';
import { createPluginSurfaceActionFailure } from '@/components/plugins/surfaces/actionFailure';
import type { ServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';

/** The cloud group's one hand-off names no single provider (R8-8). */
const showCloudHandoff = () => showManagedGetTheAppModal();

/**
 * A VM one of your computers creates (its declared acquire role) waits for a computer that can run it: with
 * none chosen it folds into one row and is not checked (lab af-add). Account-created ones never wait.
 */
function waitsForComputer(provisioner: MachineProvisionersListResultV1['provisioners'][number], controller: ManagedControllerV1 | undefined): boolean {
    return !controller && provisioner.acquireExecutionTarget === 'daemon' && provisioner.descriptor.billing.location === 'local';
}

/** Host discovery is needed before placing Account roles or any recipe without a controller. */
function needsRuntimeHost(provisioner: MachineProvisionersListResultV1['provisioners'][number], controller: ManagedControllerV1 | undefined): boolean {
    return !controller || provisioner.acquireExecutionTarget === 'account';
}

export type ManagedProvisionerSelection = Readonly<{ serverId: string; provisioner: string; controller?: ManagedControllerV1; connectPurpose?: string }>;
type MachineProvisionerPickerProps = Readonly<{
    serverId: string; presetOnly?: boolean;
    /** Where "Set up this computer" leads when no machine here can manage yet (the Add form switches its own path). */
    onSetUpThisComputer?: () => void;
    /** Local presentation handoff to the same configurator, without navigation or acquisition. */
    onSelectProvisioner?: (selection: ManagedProvisionerSelection) => void;
}>;

export function MachineProvisionerPicker(props: MachineProvisionerPickerProps) {
    useServerProfilesGeneration();
    const [selectedHome, setSelectedHome] = React.useState(props.serverId);
    if (!selectedHome) return <View testID="managed-picker"><ItemGroup title={t('managedMachines.receipt.joins')}>
        {listServerProfiles().map(home => <Item key={home.id} testID={`managed-picker.home:${home.id}`} title={resolveHomeDisplayLabel(home, home.id)} onPress={() => setSelectedHome(home.id)} />)}
    </ItemGroup></View>;
    const shared = { serverId: selectedHome, presetOnly: props.presetOnly, onSelectProvisioner: props.onSelectProvisioner,
        onSetUpThisComputer: props.onSetUpThisComputer };
    return <MachineProvisionerCatalog key={selectedHome} {...shared} />;
}

function MachineProvisionerCatalog(props: MachineProvisionerPickerProps) {
    useMachineReachabilityRevision();
    const handler = React.useRef<(registration: ActionApprovalRegistration) => void>(() => {});
    const onApprovalPending = React.useCallback((registration: ActionApprovalRegistration) => handler.current(registration), []);
    // "Managed from": the Machine that runs the offers placed on a Machine. The invoking host can also place
    // an Account role on it when the browser cannot run that role.
    const scope = useManagedControllerScope({ serverId: props.serverId, observeThisComputer: !props.presetOnly, testIDPrefix: 'managed-picker.controller' });
    const controller = props.presetOnly ? undefined : scope.controller;
    const catalog = useManagedProvisioners(props.serverId, onApprovalPending, controller);
    const { checks, setChecks } = catalog;
    const approval = useActionApprovalContinuation({ serverId: props.serverId, scopeKey: JSON.stringify([props.serverId, catalog.binding?.accountId]), onExecuted: () => {} });
    handler.current = approval.requestApproval;
    const router = useRouter();
    const [error, setError] = React.useState<string | null>(null);
    const [repairFailure, setRepairFailure] = React.useState<Readonly<{
        id: string; binding: ServerCredentialAccountScopeBinding; controller: ManagedControllerV1 | undefined;
        outcome: NonNullable<ManagedProvisionerCard['repairFailure']>;
    }> | null>(null);
    // The repair that just opened an install guide: its card asks to check again, since nothing tells us it's done.
    const [repairOpened, setRepairOpened] = React.useState<Readonly<{
        id: string; binding: ServerCredentialAccountScopeBinding; controller: ManagedControllerV1 | undefined;
    }> | null>(null);
    const compact = useViewportClass() === 'compact';
    const presentation = useManagedProvisionerPresentation({ serverId: props.serverId, controller, accountScope: catalog.binding?.scope,
        purpose: props.presetOnly ? 'presentation' : 'repair', declarationsOnly: props.presetOnly, onApprovalPending });
    const { localized, markFor } = presentation;
    const accountHost = useManagedProvisionerRuntimeHost({ serverId: props.serverId, accountScope: props.presetOnly ? undefined : catalog.binding?.scope });
    const repairAbort = React.useRef<AbortController | null>(null);
    React.useEffect(() => () => repairAbort.current?.abort(), [catalog.binding, controller]);
    React.useEffect(() => {
        const binding = catalog.binding;
        if (props.presetOnly || !binding || !catalog.homeId || !catalog.client || catalog.reading) return;
        const needsAccountHost = catalog.provisioners.some(provisioner => needsRuntimeHost(provisioner, controller));
        if (needsAccountHost && accountHost === null) return;
        if (needsAccountHost && accountHost === 'unavailable') { setError('unavailable'); return; }
        const abort = new AbortController();
        const retirement = binding.onRetire(() => abort.abort());
        // The last answers stay while this read runs, even across a refreshed binding of the same Account;
        // a settled read replaces them, and another Account never sees them.
        // Each provisioner settles on its own: a slow or failed check never holds back the others' answers.
        const current = () => !abort.signal.aborted && binding.isCurrent();
        const readChecks = async () => {
          await Promise.all(catalog.provisioners.map(async provisioner => {
            const id = buildQualifiedPluginContributionKey(provisioner.contribution);
            const placement = readMachineProvisionerHostAvailability({ host: accountHost === 'browser' ? 'browser' : 'native',
                provisioner: provisioner.descriptor, acquireExecutionTarget: provisioner.acquireExecutionTarget, controller });
            if (!placement.available) return;
            if (waitsForComputer(provisioner, controller)) return;
            const checkController = placement.controller;
            const result = await readManagedProvisionerAvailability({ binding, client: catalog.client!, occurrenceId: provisioner.occurrenceId,
                nativeInput: { homeId: catalog.homeId!, ...(checkController ? { controller: checkController } : {}), contribution: provisioner.contribution },
                signal: abort.signal, onApprovalPending });
            if (current()) setChecks(previous => ({ ...previous, [id]: result }));
          }));
        };
        void readChecks().then(() => { if (current()) setError(null); })
            .catch(() => { if (current()) setError('unavailable'); });
        return () => { abort.abort(); retirement.dispose(); };
    }, [props.presetOnly, catalog.binding, catalog.homeId, catalog.client, catalog.provisioners, catalog.reading, controller, onApprovalPending, accountHost, setChecks]);
    const open = (contribution: string, placedController: ManagedControllerV1 | undefined, connectPurpose?: string) => {
        if (!catalog.current) return;
        const handoff = placedController ? { controller: placedController } : {};
        if (props.onSelectProvisioner) {
            if (catalog.binding?.isCurrent()) props.onSelectProvisioner({ serverId: props.serverId, provisioner: contribution, ...handoff,
                ...(connectPurpose ? { connectPurpose } : {}) });
            return;
        }
        router.push(buildManagedMachineConfigurationRoute({ serverId: props.serverId, provisioner: contribution,
            ...handoff, ...(props.presetOnly ? { presetOnly: true } : {}),
            ...(connectPurpose ? { connectPurpose } : {}) }) as never);
    };
    // Home reachability belongs to the page (one line with its fix); native readiness facts stay on their cards.
    let homeUnreachable = false;
    const waiting: string[] = [];
    // Two provisioners of one product ("Cua") are told apart by what each creates, from their own declarations;
    // a card and the list of what waits for a computer name them the same way.
    const titleOf = (provisioner: (typeof catalog.provisioners)[number]) => {
        const title = localized(provisioner.contribution.pluginId, provisioner.descriptor.title);
        const kind = provisioner.descriptor.kindTitle ? localized(provisioner.contribution.pluginId, provisioner.descriptor.kindTitle) : undefined;
        const sharesTitle = catalog.provisioners.some(other => other !== provisioner
            && localized(other.contribution.pluginId, other.descriptor.title) === title);
        return sharesTitle && kind ? `${title} ${kind}` : title;
    };
    const cards: ManagedProvisionerCard[] = catalog.provisioners.flatMap(provisioner => {
        if (props.presetOnly) return [{ id: buildQualifiedPluginContributionKey(provisioner.contribution), title: titleOf(provisioner),
            description: provisioner.descriptor.description ? localized(provisioner.contribution.pluginId, provisioner.descriptor.description) : '',
            location: provisioner.descriptor.billing.location === 'local' ? 'local' : 'cloud', enrollmentRole: provisioner.descriptor.enrollmentRole,
            acquire: provisioner.acquireExecutionTarget === 'daemon' ? 'daemon' : 'account', mark: (size: number) => markFor(provisioner, size),
            status: { tone: 'none', label: '' }, action: { kind: 'choose', label: t('managedMachines.add.action.choose'),
                onPress: () => open(buildQualifiedPluginContributionKey(provisioner.contribution), undefined), disabled: !catalog.current } }];
        if (waitsForComputer(provisioner, controller)) { waiting.push(titleOf(provisioner)); return []; }
        const location = provisioner.descriptor.billing.location;
        const id = buildQualifiedPluginContributionKey(provisioner.contribution);
        const outcome = checks[id];
        // The provisioner's own browser-reachability fact, read by the same owner that refuses its acquire.
        const placement = readMachineProvisionerHostAvailability({ host: accountHost === 'browser' ? 'browser' : 'native',
            provisioner: provisioner.descriptor, acquireExecutionTarget: provisioner.acquireExecutionTarget, controller });
        const hostPending = needsRuntimeHost(provisioner, controller) && (accountHost === null || accountHost === 'unavailable');
        const needsApp = !hostPending && !placement.available;
        const check = outcome?.kind === 'succeeded' ? outcome.value : undefined;
        const repairAction = check?.prerequisites?.find(prerequisite => prerequisite.status !== 'available' && prerequisite.repairAction)?.repairAction;
        const missingExecutable = check?.prerequisites?.some(prerequisite => prerequisite.status !== 'available');
        const noAccount = check?.code === 'credential_unavailable' || outcome?.kind === 'failed' && outcome.code === 'credential_unavailable';
        // Conditionally credentialed providers enter their selector form before offering account setup.
        const connectPurpose = noAccount ? provisioner.credentialPurposes?.find(({ purpose }) =>
            readMachineProvisionerCredentialPurposeSelectorPathsV1(provisioner.descriptor, purpose.purpose).length === 0)?.purpose.purpose : undefined;
        // A failed read keeps the offer with a reason and an explicit retry, never an empty disabled card.
        const unreadable = outcome?.kind === 'failed' && !noAccount;
        const caveat = check?.available === true && check.code === 'home_not_guest_reachable';
        if (caveat) homeUnreachable = true;
        const statusLabel = needsApp ? t('managedMachines.add.status.needsApp')
            : caveat ? t('managedMachines.add.status.needsSetup')
            : check?.status ? localized(provisioner.contribution.pluginId, check.status)
            : noAccount ? t('managedMachines.add.status.noAccount')
            : check ? t(check.available ? 'managedMachines.add.status.ready'
                : missingExecutable ? 'managedMachines.add.status.notInstalled' : 'managedMachines.add.status.needsSetup')
                : unreadable ? describeManagedProvisionerFailure(outcome.code) : t('managedMachines.add.status.checking');
        const title = titleOf(provisioner);
        return [{ id, title,
            description: provisioner.descriptor.description ? localized(provisioner.contribution.pluginId, provisioner.descriptor.description) : '',
            location: location === 'local' ? 'local' : 'cloud', enrollmentRole: provisioner.descriptor.enrollmentRole,
            acquire: placement.executionTarget, mark: (size: number) => markFor(provisioner, size),
            repairFailure: repairFailure?.id === id && repairFailure.binding === catalog.binding
                && repairFailure.controller?.machineId === controller?.machineId
                && repairFailure.controller?.installationId === controller?.installationId ? repairFailure.outcome : undefined,
            // Amber means "needs you": a service nobody connected or a tool not yet installed is an offer, so it stays quiet.
            status: { tone: check?.available && location !== 'unknown' && !caveat ? 'ready'
                : noAccount || (check && !check.available && missingExecutable) ? 'none' : check ? 'attention' : 'none',
                label: [statusLabel, location === 'unknown' ? t('managedMachines.add.status.billingUnknown') : null].filter(Boolean).join(' · ') },
            action: needsApp ? { kind: 'handoff', label: t('managedMachines.add.action.getTheApp'),
                onPress: () => showManagedGetTheAppModal(title) }
            : unreadable || catalog.error ? { kind: 'retry', label: t('common.retry'), onPress: catalog.refresh }
            : repairAction && repairOpened?.id === id && repairOpened.binding === catalog.binding
                && repairOpened.controller?.machineId === controller?.machineId
                && repairOpened.controller?.installationId === controller?.installationId
                ? { kind: 'retry', label: t('machinePresets.setup.tab.checkAgain'), onPress: () => { setRepairOpened(null); catalog.refresh(); } }
            : repairAction ? { kind: 'repair', label: t(noAccount ? 'managedMachines.add.action.connect'
                : missingExecutable ? 'managedMachines.add.action.getApp' : 'managedMachines.add.action.setUp'), onPress: () => {
                const binding = catalog.binding;
                if (!binding?.isCurrent()) return;
                repairAbort.current?.abort();
                const abort = new AbortController(); repairAbort.current = abort;
                setRepairFailure(null);
                void presentation.repair(repairAction, binding, abort.signal).then(outcome => {
                    if (abort.signal.aborted || !binding.isCurrent()) return;
                    if (outcome.ok) { setRepairOpened({ id, binding, controller }); catalog.refresh(); }
                    else setRepairFailure({ id, binding, controller, outcome });
                }).catch(() => { if (!abort.signal.aborted && binding.isCurrent()) setRepairFailure({ id, binding, controller,
                    outcome: createPluginSurfaceActionFailure('unavailable', 'unavailable') }); });
            } } : { kind: 'choose', label: t(connectPurpose ? 'managedMachines.add.action.connect' : 'managedMachines.add.action.choose'),
                onPress: () => open(id, placement.controller, connectPurpose),
                // Retained checks describe the card; the current controller catalog admits the handoff.
                ...(!catalog.current || hostPending || unreadable || check?.available === false && missingExecutable
                    ? { disabled: true } : {}) } }];
    });
    const controllerName = scope.machine ? getMachineSentenceName(scope.machine) : '';
    const observedMachines = React.useMemo(() => scope.machine ? [scope.machine] : [], [scope.machine]);
    const presenceNowMs = useMachinePresenceNowMs(observedMachines);
    const controllerPresence = scope.machine ? resolveMachinePickerPresence(scope.machine, presenceNowMs,
        catalog.binding?.isCurrent() ? catalog.binding.scope : null).status : 'unknown';
    const failedCheck = Object.values(checks).find(result => result.kind === 'failed' && result.code !== 'credential_unavailable');
    const checkFailed = failedCheck?.kind === 'failed';
    const failure = catalog.error ?? error ?? (failedCheck?.kind === 'failed' ? failedCheck.code : null);
    // A list that loaded with some checks failed is a partial read: its cards stay, and the line says only that.
    const partialRead = !catalog.error && !error && checkFailed && cards.length > 0;
    // The controller's own state, said once, and only about a catalog that answered: while the first read
    // runs, the skeleton holds the page and nothing asks for a Machine yet.
    // Account providers need no Machine (plan 58): "none online" is said only once the catalog has nothing else to offer.
    const scopeState = props.presetOnly || catalog.loading ? null : !controller ? (scope.hasCandidates && (scope.hasOnlineCandidate || cards.length === 0)
            ? <SurfaceStateCard testID="managed-picker.no-online-controller" kind="unavailable" size="line"
            title={t(scope.hasOnlineCandidate ? 'managedMachines.add.chooseController' : 'managedMachines.add.noOnlineController')} />
            : null)
        : (failure || cards.length === 0) && controllerPresence === 'offline' ? <SurfaceStateCard testID="managed-picker.offline" kind="unavailable" size="line"
            title={t('managedMachines.add.controllerOffline', { controller: controllerName })} action={{ label: t('common.retry'), onPress: catalog.refresh }} />
        : failure || cards.length === 0 && controllerPresence === 'unknown' ? <SurfaceStateCard testID="managed-picker.unavailable" kind={controllerPresence === 'unknown' ? 'unavailable' : 'error'} size="line" diagnosticCode={failure ?? undefined}
            diagnosticDetail={failure ? describeManagedProvisionerFailure(failure) : undefined}
            title={t(partialRead ? 'managedMachines.add.checksUnreadable' : 'managedMachines.add.controllerUnreadable', { controller: controllerName })}
            action={{ label: t('common.retry'), onPress: catalog.refresh }} />
        : cards.length === 0 ? <SurfaceStateCard kind="empty" size="line" title={t('managedMachines.providers.empty')} />
        : null;
    const localResources = Object.values(checks).flatMap(result => result.kind === 'succeeded' && result.value.localResources
        ? [result.value.localResources] : [])[0];
    const localDescription = props.presetOnly ? '' : !compact && localResources?.availableCpuCores !== undefined && localResources.availableMemoryBytes !== undefined
        && localResources.availableDiskBytes !== undefined
        ? t('managedMachines.add.localDescription', { computer: controllerName, cores: String(localResources.availableCpuCores),
            memory: formatHappierDataBytes(localResources.availableMemoryBytes, { kind: 'memory' }), disk: formatHappierDataBytes(localResources.availableDiskBytes, { kind: 'storage' }) })
        : t('managedMachines.add.localDescriptionShort', { computer: controllerName });
    const pageSections = useListPresentation() === 'page' && !compact;
    // "Managed from" sits where it applies: on the section of offers a Machine runs (MachineProvisionerSections).
    const sectionScope = !props.presetOnly && scope.chip ? { chip: scope.chip, placement: pageSections ? 'header' as const : 'row' as const } : undefined;
    const shown = cards.length > 0 || waiting.length > 0;
    const retryMachineList = () => { void getSyncSingleton().refreshMachines({ serverId: props.serverId }).catch(() => {}); };
    const setUpThisComputer = props.onSetUpThisComputer ?? (() => router.push('/settings/machines/add?path=thisComputer' as never));
    // The first read reserves the catalog's own layout (its cards' skeletons), not a lone loading line.
    const reading = !shown && (catalog.loading || !props.presetOnly && !scope.hasCandidates && scope.machineList === 'loading');
    return <View testID="managed-picker">
        {approval.approvalId ? <AttentionBanner testID="managed-picker.approval" title={t('approvals.title')} description={t('approvals.status.open')}
            action={{ label: t('approvals.details'), onPress: () => router.push(`/inbox/approvals/${encodeURIComponent(approval.approvalId!)}?serverId=${encodeURIComponent(props.serverId)}` as never) }} /> : null}
        {(props.presetOnly || !scope.hasCandidates) && !shown && catalog.error ? <SurfaceStateCard testID="managed-picker.unavailable" kind="error"
            title={t('managedMachines.providers.unavailable')} diagnosticCode={catalog.error}
            diagnosticDetail={describeManagedProvisionerFailure(catalog.error)} action={{ label: t('common.retry'), onPress: catalog.refresh }} />
            : reading ? <MachineProvisionerSectionsSkeleton compact={compact} testID="managed-picker.loading" />
            : props.presetOnly && !shown ? <SurfaceStateCard testID="managed-picker.empty" kind="empty" size="line" title={t('managedMachines.providers.empty')} />
            : !scope.hasCandidates && !shown && scope.machineList === 'unavailable' ? <SurfaceStateCard testID="managed-picker.machines-unavailable" kind="error"
            title={t('managedMachines.providers.unavailable')} action={{ label: t('common.retry'), onPress: retryMachineList }} />
            : !scope.hasCandidates && !shown ? <SurfaceStateCard testID="managed-picker.no-controller" kind="empty"
            title={t('managedMachines.add.noControllerTitle')} reason={t('managedMachines.add.noControllerReason')}
            action={{ label: t('managedMachines.add.setUpThisComputer'), onPress: setUpThisComputer }} />
            : shown ? <>
                {/* The line is page content like the sections beneath it: an edge-only section gives it the page column. */}
                {scopeState || homeUnreachable ? <ItemGroup surface="none">{scopeState}
                    {homeUnreachable ? <SurfaceStateCard testID="managed-picker.caveat" kind="warning" size="line" title={t('managedMachines.add.homeUnreachable')}
                        action={{ label: t('homeGovernance.reach.setAddress'), onPress: () => router.push(homeAdministrationReachPath(props.serverId) as never) }} /> : null}
                </ItemGroup> : null}
                <MachineProvisionerSections cards={cards} compact={compact} testID="managed-picker.provisioners" scope={sectionScope}
                    localCollapsed={waiting.length > 0 ? { names: waiting, onAddComputer: setUpThisComputer } : undefined}
                    localTitle={t('managedMachines.add.onThisComputer')} localDescription={localDescription}
                    onHandoff={showCloudHandoff} />
            </>
            // Nothing to offer yet: the Machine choice is the only step, so its chip stays with the line that asks for it.
            : pageSections ? <ItemGroup title={scope.chip ? t('managedMachines.config.managedFrom') : undefined} action={scope.chip ?? undefined} surface="none">{scopeState}</ItemGroup>
            : <>{scope.chip ? <ManagedScopeRow testID="managed-picker.scope" chip={scope.chip} /> : null}{scopeState}</>}
    </View>;
}
