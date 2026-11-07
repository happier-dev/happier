import * as React from 'react';
import { View } from 'react-native';
import type { ManagedControllerV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import type { MachineProvisionersListResultV1 } from '@happier-dev/protocol/plugins/contributions/machineProvisioners';
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
import { MachineProvisionerSections } from './MachineProvisionerSections';
import { ManagedScopeRow } from './ManagedScopeRow';
import type { ManagedProvisionerCard } from './managedMachineDisplay';
import { useManagedControllerScope, type ManagedControllerScope } from './useManagedControllerScope';
import { buildManagedMachineConfigurationRoute } from './managedMachineConfigurationRoute';
import { readMachineProvisionerHostAvailability } from '@happier-dev/cli-common/machines/managed/provisioners';
import { showManagedGetTheAppModal } from './ManagedGetTheAppModal';
import { homeAdministrationReachPath } from '@/components/settings/home/governance/homeAdministrationRoutes';

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
    /**
     * The "Managed from" scope of a page that shows its chip itself (beside the Add page's ways in). The
     * picker then reads that controller and draws no chip of its own; without it, the picker owns one.
     */
    scope?: ManagedControllerScope;
}>;

export function MachineProvisionerPicker(props: MachineProvisionerPickerProps) {
    useServerProfilesGeneration();
    const [selectedHome, setSelectedHome] = React.useState(props.serverId);
    if (!selectedHome) return <View testID="managed-picker"><ItemGroup title={t('managedMachines.receipt.joins')}>
        {listServerProfiles().map(home => <Item key={home.id} testID={`managed-picker.home:${home.id}`} title={resolveHomeDisplayLabel(home, home.id)} onPress={() => setSelectedHome(home.id)} />)}
    </ItemGroup></View>;
    const shared = { serverId: selectedHome, presetOnly: props.presetOnly, onSelectProvisioner: props.onSelectProvisioner,
        onSetUpThisComputer: props.onSetUpThisComputer };
    // A page's scope speaks only for the Home it was made for.
    return props.scope && selectedHome === props.serverId
        ? <MachineProvisionerCatalog key={selectedHome} {...shared} scope={props.scope} pageOwnsChip />
        : <MachineProvisionerOwnScopeCatalog key={selectedHome} {...shared} />;
}

function MachineProvisionerOwnScopeCatalog(props: Omit<MachineProvisionerPickerProps, 'scope'>) {
    const scope = useManagedControllerScope({ serverId: props.serverId, testIDPrefix: 'managed-picker.controller' });
    return <MachineProvisionerCatalog {...props} scope={scope} pageOwnsChip={false} />;
}

function MachineProvisionerCatalog(props: Omit<MachineProvisionerPickerProps, 'scope'> & Readonly<{ scope: ManagedControllerScope; pageOwnsChip: boolean }>) {
    useMachineReachabilityRevision();
    const handler = React.useRef<(registration: ActionApprovalRegistration) => void>(() => {});
    const onApprovalPending = React.useCallback((registration: ActionApprovalRegistration) => handler.current(registration), []);
    // The invoking host can place an Account role on the selected controller when the browser cannot run it.
    const scope = props.scope;
    const controller = scope.controller;
    const catalog = useManagedProvisioners(props.serverId, onApprovalPending, controller);
    const { checks, setChecks } = catalog;
    const approval = useActionApprovalContinuation({ serverId: props.serverId, scopeKey: JSON.stringify([props.serverId, catalog.binding?.accountId]), onExecuted: () => {} });
    handler.current = approval.requestApproval;
    const router = useRouter();
    const [error, setError] = React.useState<string | null>(null);
    const compact = useViewportClass() === 'compact';
    const presentation = useManagedProvisionerPresentation({ serverId: props.serverId, controller, accountScope: catalog.binding?.scope });
    const { localized, markFor } = presentation;
    const accountHost = useManagedProvisionerRuntimeHost({ serverId: props.serverId, accountScope: catalog.binding?.scope });
    const repairAbort = React.useRef<AbortController | null>(null);
    React.useEffect(() => () => repairAbort.current?.abort(), [catalog.binding, controller]);
    React.useEffect(() => {
        const binding = catalog.binding;
        if (!binding || !catalog.homeId || !catalog.client || catalog.reading) return;
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
    }, [catalog.binding, catalog.homeId, catalog.client, catalog.provisioners, catalog.reading, controller, onApprovalPending, accountHost, setChecks]);
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
        const kind = provisioner.descriptor.kindTitle ? localized(provisioner.contribution.pluginId, provisioner.descriptor.kindTitle) : undefined;
        // A kind reads inside a title ("Cua sandbox"); shown on its own, as a badge or row subtitle, it starts a label.
        return [{ id, title,
            kind: kind ? kind.charAt(0).toLocaleUpperCase() + kind.slice(1) : undefined,
            description: provisioner.descriptor.description ? localized(provisioner.contribution.pluginId, provisioner.descriptor.description) : '',
            location: location === 'local' ? 'local' : 'cloud', acquire: provisioner.acquireExecutionTarget, mark: (size: number) => markFor(provisioner, size),
            // Amber means "needs you": a service nobody connected or a tool not yet installed is an offer, so it stays quiet.
            status: { tone: check?.available && location !== 'unknown' && !caveat ? 'ready'
                : noAccount || (check && !check.available && missingExecutable) ? 'none' : check ? 'attention' : 'none',
                label: [statusLabel, location === 'unknown' ? t('managedMachines.add.status.billingUnknown') : null].filter(Boolean).join(' · ') },
            action: needsApp ? { kind: 'handoff', label: t('managedMachines.add.action.getTheApp'),
                onPress: () => showManagedGetTheAppModal(title) }
            : unreadable || catalog.error ? { kind: 'retry', label: t('common.retry'), onPress: catalog.refresh }
            : repairAction ? { kind: 'repair', label: t(noAccount ? 'managedMachines.add.action.connect'
                : missingExecutable ? 'managedMachines.add.action.getApp' : 'managedMachines.add.action.setUp'), onPress: () => {
                const binding = catalog.binding;
                if (!binding?.isCurrent()) return;
                repairAbort.current?.abort();
                const abort = new AbortController(); repairAbort.current = abort;
                void presentation.repair(repairAction, binding, abort.signal).then(outcome => {
                    if (abort.signal.aborted || !binding.isCurrent()) return;
                    if (outcome.ok) catalog.refresh(); else setError(outcome.reason);
                }).catch(() => { if (!abort.signal.aborted && binding.isCurrent()) setError('unavailable'); });
            } } : { kind: 'choose', label: t(noAccount ? 'managedMachines.add.action.connect' : 'managedMachines.add.action.choose'),
                onPress: () => open(id, placement.controller, noAccount ? provisioner.credentialPurposes?.[0]?.purpose.purpose : undefined),
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
    // The controller's own state, said once under the chip that changes it.
    // A catalog that answered speaks for itself; presence only explains an empty or failed one.
    const scopeState = !controller ? (scope.hasCandidates ? <SurfaceStateCard testID="managed-picker.no-online-controller" kind="unavailable" size="line"
            title={t('managedMachines.add.noOnlineController')} /> : null)
        : (failure || cards.length === 0) && controllerPresence === 'offline' ? <SurfaceStateCard testID="managed-picker.offline" kind="unavailable" size="line"
            title={t('managedMachines.add.controllerOffline', { controller: controllerName })} action={{ label: t('common.retry'), onPress: catalog.refresh }} />
        : failure || cards.length === 0 && controllerPresence === 'unknown' ? <SurfaceStateCard testID="managed-picker.unavailable" kind={controllerPresence === 'unknown' ? 'unavailable' : 'error'} size="line" diagnosticCode={failure ?? undefined}
            diagnosticDetail={failure ? describeManagedProvisionerFailure(failure) : undefined}
            title={t(partialRead ? 'managedMachines.add.checksUnreadable' : 'managedMachines.add.controllerUnreadable', { controller: controllerName })}
            action={{ label: t('common.retry'), onPress: catalog.refresh }} />
        : catalog.loading && cards.length === 0 ? <SurfaceStateCard kind="loading" size="line" title={t('managedMachines.providers.loading')} />
        : !catalog.loading && cards.length === 0 ? <SurfaceStateCard kind="empty" size="line" title={t('managedMachines.providers.empty')} />
        : null;
    const localResources = Object.values(checks).flatMap(result => result.kind === 'succeeded' && result.value.localResources
        ? [result.value.localResources] : [])[0];
    const localDescription = !compact && localResources?.availableCpuCores !== undefined && localResources.availableMemoryBytes !== undefined
        && localResources.availableDiskBytes !== undefined
        ? t('managedMachines.add.localDescription', { computer: controllerName, cores: String(localResources.availableCpuCores),
            memory: formatHappierDataBytes(localResources.availableMemoryBytes, { kind: 'memory' }), disk: formatHappierDataBytes(localResources.availableDiskBytes, { kind: 'storage' }) })
        : t('managedMachines.add.localDescriptionShort', { computer: controllerName });
    // Controller scope stays above the catalog throughout loading and settling. A provider's
    // presence or execution target cannot move the control that changes all its checks.
    const pageSections = useListPresentation() === 'page' && !compact;
    const chip = props.pageOwnsChip ? null : scope.chip;
    const scopeRow = chip ? <View testID="managed-picker.scope-anchor">{pageSections
        ? <ItemGroup title={t('managedMachines.config.managedFrom')} action={chip} surface="none" />
        : <ManagedScopeRow testID="managed-picker.scope" chip={chip} />}</View> : null;
    const shown = cards.length > 0 || waiting.length > 0;
    const retryMachineList = () => { void getSyncSingleton().refreshMachines({ serverId: props.serverId }).catch(() => {}); };
    const setUpThisComputer = props.onSetUpThisComputer ?? (() => router.push('/settings/machines/add?path=thisComputer' as never));
    return <View testID="managed-picker">
        {scopeRow}
        {approval.approvalId ? <AttentionBanner testID="managed-picker.approval" title={t('approvals.title')} description={t('approvals.status.open')}
            action={{ label: t('approvals.details'), onPress: () => router.push(`/inbox/approvals/${encodeURIComponent(approval.approvalId!)}?serverId=${encodeURIComponent(props.serverId)}` as never) }} /> : null}
        {!scope.hasCandidates && !shown && catalog.error ? <SurfaceStateCard testID="managed-picker.unavailable" kind="error"
            title={t('managedMachines.providers.unavailable')} diagnosticCode={catalog.error}
            diagnosticDetail={describeManagedProvisionerFailure(catalog.error)} action={{ label: t('common.retry'), onPress: catalog.refresh }} />
            : !scope.hasCandidates && !shown && scope.machineList === 'loading' ? <SurfaceStateCard testID="managed-picker.machines-loading" kind="loading" size="line"
            title={t('managedMachines.providers.loading')} />
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
                <MachineProvisionerSections cards={cards} compact={compact} testID="managed-picker.provisioners"
                    localCollapsed={waiting.length > 0 ? { names: waiting, onAddComputer: setUpThisComputer } : undefined}
                    localTitle={t('managedMachines.add.onThisComputer')} localDescription={localDescription}
                    onHandoff={showCloudHandoff} />
            </> : pageSections ? <ItemGroup surface="none">{scopeState}</ItemGroup>
            : scopeState}
    </View>;
}
