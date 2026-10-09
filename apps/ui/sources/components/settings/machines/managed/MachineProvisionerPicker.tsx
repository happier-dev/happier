import * as React from 'react';
import { View } from 'react-native';
import type { ManagedControllerV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import type { MachineProvisionerCheckResultV1 } from '@happier-dev/protocol/plugins/contributions/machineProvisioners';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { useServerProfilesGeneration } from '@/hooks/server/useServerProfilesGeneration';
import { listServerProfiles } from '@/sync/domains/server/serverProfiles';
import { resolveMachinePickerPresence } from '@/sync/domains/machines/identity/resolveMachinePickerPresence';
import { formatByteCapacity } from '@/utils/files/formatByteSize';
import { getMachineDisplayName } from '@/utils/sessions/machineDisplayNames';
import { useViewportClass } from '@/utils/platform/useViewportClass';
import { useActionApprovalContinuation } from '@/components/approvals/useActionApprovalContinuation';
import type { ActionApprovalRegistration } from '@/components/approvals/actionApprovalContinuation';
import { AttentionBanner } from '@/components/ui/lists/AttentionBanner';
import { t } from '@/text';
import { useManagedProvisioners } from './useManagedProvisioners';
import { useManagedProvisionerPresentation } from './useManagedProvisionerPresentation';
import { MachineProvisionerSections } from './MachineProvisionerSections';
import type { ManagedProvisionerCard } from './managedMachineDisplay';
import { useManagedControllerScope } from './useManagedControllerScope';

export type ManagedProvisionerSelection = Readonly<{ serverId: string; provisioner: string; controller: ManagedControllerV1 }>;
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
        {listServerProfiles().map(home => <Item key={home.id} testID={`managed-picker.home:${home.id}`} title={home.name} onPress={() => setSelectedHome(home.id)} />)}
    </ItemGroup></View>;
    return <MachineProvisionerCatalog key={selectedHome} serverId={selectedHome} presetOnly={props.presetOnly} onSelectProvisioner={props.onSelectProvisioner}
        onSetUpThisComputer={props.onSetUpThisComputer} />;
}

function MachineProvisionerCatalog(props: MachineProvisionerPickerProps) {
    const handler = React.useRef<(registration: ActionApprovalRegistration) => void>(() => {});
    const onApprovalPending = React.useCallback((registration: ActionApprovalRegistration) => handler.current(registration), []);
    const [checks, setChecks] = React.useState<Readonly<Record<string, MachineProvisionerCheckResultV1>>>({});
    const scope = useManagedControllerScope({ serverId: props.serverId, testIDPrefix: 'managed-picker.controller',
        onSelect: React.useCallback(() => setChecks({}), []) });
    const controller = scope.controller;
    const catalog = useManagedProvisioners(props.serverId, onApprovalPending, controller);
    const approval = useActionApprovalContinuation({ serverId: props.serverId, scopeKey: JSON.stringify([props.serverId, catalog.binding?.accountId]), onExecuted: () => {} });
    handler.current = approval.requestApproval;
    const router = useRouter();
    const [error, setError] = React.useState<string | null>(null);
    const compact = useViewportClass() === 'compact';
    const presentation = useManagedProvisionerPresentation({ serverId: props.serverId, controller });
    const { localized, markFor } = presentation;
    const repairAbort = React.useRef<AbortController | null>(null);
    React.useEffect(() => () => repairAbort.current?.abort(), [catalog.binding, controller]);
    React.useEffect(() => {
        const binding = catalog.binding;
        if (!binding || !catalog.homeId || !catalog.client || !controller) return;
        const abort = new AbortController();
        const retirement = binding.onRetire(() => { abort.abort(); setChecks({}); });
        setChecks({});
        void Promise.all(catalog.provisioners.map(async provisioner => ({
            id: buildQualifiedPluginContributionKey(provisioner.contribution),
            result: await catalog.client!.read('machines.provisioners.check', { homeId: catalog.homeId!, controller, contribution: provisioner.contribution }, { signal: abort.signal, onApprovalPending }),
        }))).then(results => {
            if (abort.signal.aborted || !binding.isCurrent()) return;
            setChecks(Object.fromEntries(results.flatMap(({ id, result }) => result.kind === 'succeeded' ? [[id, result.value]] : [])));
            setError(results.find(({ result }) => result.kind === 'failed')?.result.kind === 'failed' ? 'unavailable' : null);
        }).catch(() => { if (!abort.signal.aborted && binding.isCurrent()) setError('unavailable'); });
        return () => { abort.abort(); retirement.dispose(); };
    }, [catalog.binding, catalog.homeId, catalog.client, catalog.provisioners, controller, onApprovalPending]);
    const open = (contribution: string) => {
        if (props.onSelectProvisioner) {
            if (controller && catalog.binding?.isCurrent()) props.onSelectProvisioner({ serverId: props.serverId, provisioner: contribution, controller });
            return;
        }
        const params = new URLSearchParams({ serverId: props.serverId });
        if (props.presetOnly) params.set('presetOnly', 'true');
        if (controller) { params.set('machineId', controller.machineId); params.set('installationId', controller.installationId); }
        router.push(`/settings/machines/add/${encodeURIComponent(contribution)}?${params.toString()}` as never);
    };
    const cards: ManagedProvisionerCard[] = catalog.provisioners.flatMap(provisioner => {
        const location = provisioner.descriptor.billing.location;
        const id = buildQualifiedPluginContributionKey(provisioner.contribution);
        const check = checks[id];
        const repairAction = check?.prerequisites?.find(prerequisite => prerequisite.status !== 'available' && prerequisite.repairAction)?.repairAction;
        const missingExecutable = check?.prerequisites?.some(prerequisite => prerequisite.status !== 'available');
        const noAccount = check?.code === 'credential_unavailable';
        const statusLabel = check?.status ? localized(provisioner.contribution.pluginId, check.status)
            : check ? t(check.available ? 'managedMachines.add.status.ready' : noAccount ? 'managedMachines.add.status.noAccount'
                : missingExecutable ? 'managedMachines.add.status.notInstalled' : 'managedMachines.add.status.needsSetup')
                : t('managedMachines.providers.loading');
        return [{ id, title: localized(provisioner.contribution.pluginId, provisioner.descriptor.title),
            kind: provisioner.descriptor.kindTitle ? localized(provisioner.contribution.pluginId, provisioner.descriptor.kindTitle) : undefined,
            description: provisioner.descriptor.description ? localized(provisioner.contribution.pluginId, provisioner.descriptor.description) : '',
            location: location === 'local' ? 'local' : 'cloud', mark: markFor(provisioner),
            status: { tone: check ? check.available && location !== 'unknown' ? 'ready' : 'attention' : 'none',
                label: [statusLabel, location === 'unknown' ? t('managedMachines.add.status.billingUnknown') : null].filter(Boolean).join(' · ') },
            action: repairAction ? { kind: 'repair', label: t(noAccount ? 'managedMachines.add.action.connect'
                : missingExecutable ? 'managedMachines.add.action.getApp' : 'managedMachines.add.action.setUp'), onPress: () => {
                const binding = catalog.binding;
                if (!binding?.isCurrent()) return;
                repairAbort.current?.abort();
                const abort = new AbortController(); repairAbort.current = abort;
                void presentation.repair(repairAction, binding, abort.signal).then(outcome => {
                    if (abort.signal.aborted || !binding.isCurrent()) return;
                    if (outcome.ok) catalog.refresh(); else setError(outcome.reason);
                }).catch(() => { if (!abort.signal.aborted && binding.isCurrent()) setError('unavailable'); });
            } } : { kind: 'choose', label: t('managedMachines.add.action.choose'), onPress: () => open(id) } }];
    });
    const controllerName = scope.machine ? getMachineDisplayName(scope.machine) ?? scope.machine.id : '';
    const controllerOnline = scope.machine ? resolveMachinePickerPresence(scope.machine).status === 'online' : false;
    const failure = catalog.error ?? error;
    // The controller's own state, said once under the chip that changes it.
    // A catalog that answered speaks for itself; presence only explains an empty or failed one.
    const scopeState = !controller ? null
        : (failure || cards.length === 0) && !controllerOnline ? <SurfaceStateCard testID="managed-picker.offline" kind="unavailable" size="line"
            title={t('managedMachines.add.controllerOffline', { controller: controllerName })} action={{ label: t('common.retry'), onPress: catalog.refresh }} />
        : failure ? <SurfaceStateCard testID="managed-picker.unavailable" kind="error" size="line" diagnosticCode={failure}
            title={t('managedMachines.add.controllerUnreadable', { controller: controllerName })} action={{ label: t('common.retry'), onPress: catalog.refresh }} />
        : catalog.loading && cards.length === 0 ? <SurfaceStateCard kind="loading" size="line" title={t('managedMachines.providers.loading')} />
        : !catalog.loading && cards.length === 0 ? <SurfaceStateCard kind="empty" size="line" title={t('managedMachines.providers.empty')} />
        : null;
    const localResources = Object.values(checks).find(check => check.localResources)?.localResources;
    const localDescription = !compact && localResources?.availableCpuCores !== undefined && localResources.availableMemoryBytes !== undefined
        && localResources.availableDiskBytes !== undefined
        ? t('managedMachines.add.localDescription', { computer: controllerName, cores: String(localResources.availableCpuCores),
            memory: formatByteCapacity(localResources.availableMemoryBytes), disk: formatByteCapacity(localResources.availableDiskBytes) })
        : t('managedMachines.add.localDescriptionShort', { computer: controllerName });
    const setUpThisComputer = props.onSetUpThisComputer ?? (() => router.push('/settings/machines/add?path=thisComputer' as never));
    return <View testID="managed-picker">
        {approval.approvalId ? <AttentionBanner title={t('approvals.title')} description={t('approvals.status.open')}
            action={{ label: t('approvals.details'), onPress: () => router.push(`/inbox/approvals/${encodeURIComponent(approval.approvalId!)}?serverId=${encodeURIComponent(props.serverId)}` as never) }} /> : null}
        {!scope.hasCandidates && catalog.error ? <SurfaceStateCard testID="managed-picker.unavailable" kind="error"
            title={t('managedMachines.providers.unavailable')} diagnosticCode={catalog.error} action={{ label: t('common.retry'), onPress: catalog.refresh }} />
            : !scope.hasCandidates ? <SurfaceStateCard testID="managed-picker.no-controller" kind="empty"
            title={t('managedMachines.add.noControllerTitle')} reason={t('managedMachines.add.noControllerReason')}
            action={{ label: t('managedMachines.add.setUpThisComputer'), onPress: setUpThisComputer }} />
            : cards.length > 0 ? <>
                {scopeState}
                <MachineProvisionerSections cards={cards} compact={compact} testID="managed-picker.provisioners" scope={scope.chip}
                    localTitle={t('managedMachines.add.onThisComputer')} localDescription={localDescription} />
            </> : <ItemGroup title={t('managedMachines.config.managedFrom')} action={scope.chip} surface="none">{scopeState}</ItemGroup>}
    </View>;
}
