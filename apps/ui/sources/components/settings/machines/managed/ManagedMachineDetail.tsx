import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';
import { useHappierCollectionLayout } from '@happier-dev/plugin-ui/presentation';
import { Redirect, useLocalSearchParams, useRouter } from '@/components/appShell/workspace/destinationRoute';
import { Icon } from '@/components/ui/icons/Icon';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { resolveHomeDisplayLabel } from '@/components/settings/server/homeDisplayName';
import { getServerProfileById, resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';
import type { FrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { t } from '@/text';
import { ManagedReceiptPageLayout } from './ManagedReceiptPageLayout';
import { ManagedMachineSections, useManagedMachineHeaderIdentity } from './ManagedMachineSections';
import { useAdmittedManagedMachineRow, useManagedMachineInventory } from './useManagedMachineInventory';
import { ManagedMachineReadApprovalNotice } from './ManagedMachineReadApprovalNotice';
import { useMachinesDoor } from '@/components/machines/page/machinesDoor';
import { machinePageHref, machinesIndexHref } from '@/components/machines/page/machinePageHref';
import { projectManagedMachineDetailRead } from './managedMachineDetailPresentation';
import { managedMachineEnrolledDetailId } from './managedCreationPresentation';
import { useManagedMachineRouteScope } from './useManagedMachineRouteScope';
import { KnownHomeGate } from '@/components/sessions/access/KnownHomeGate';
import { useServerScopedMachine } from '@/sync/store/hooks';

type ManagedMachineDetailProps = Readonly<{ managedId: string; serverId: string;
    executeAction?: FrontDoorActionExecute }>;
function parameter(value: string | string[] | undefined): string {
    return (Array.isArray(value) ? value[0] : value)?.trim() ?? '';
}

export function ManagedMachineDetailScreen() {
    const params = useLocalSearchParams<{ id?: string | string[]; serverId?: string | string[] }>();
    const serverId = useManagedMachineRouteScope(params.serverId);
    return <KnownHomeGate serverId={serverId} testIDPrefix="managed-route"><ManagedMachineDetail managedId={parameter(params.id)} serverId={serverId} /></KnownHomeGate>;
}

/** The saved managed destination resolves the server row, then opens the enrolled Machine page in the same door. */
export function ManagedMachineDetail(props: ManagedMachineDetailProps) {
    return <ManagedMachineDetailBody key={JSON.stringify([props.serverId, props.managedId])} {...props} />;
}

function ManagedMachineDetailBody(props: ManagedMachineDetailProps) {
    const { theme } = useUnistyles();
    const layout = useHappierCollectionLayout();
    const door = useMachinesDoor();
    const router = useRouter();
    const serverId = resolveServerProfileScopeIdForIdentifier(props.serverId) || props.serverId;
    const serverIds = React.useMemo(() => serverId && props.managedId ? [serverId] : [], [serverId, props.managedId]);
    const inventory = useManagedMachineInventory(serverIds, props.managedId || undefined, props.executeAction);
    const executeAction = inventory.executeAction;
    const entry = inventory.entries[serverId];
    const admittedMachine = useAdmittedManagedMachineRow(serverId, props.managedId, inventory.bindings.get(serverId), executeAction);
    const accountState = inventory.accountScopes.get(serverId);
    const [actionError, setActionError] = React.useState<string | null>(null);
    const machine = entry?.machines[0];
    const enrolledMachinePresent = useServerScopedMachine(serverId, machine?.enrolledMachineId, Boolean);
    const detailRead = projectManagedMachineDetailRead({ managedId: props.managedId, detailMachine: machine,
        detailStatus: entry?.status, admittedMachine });
    const headerMachine = detailRead.headerMachine;
    const identity = useManagedMachineHeaderIdentity(headerMachine, serverId);
    const profile = getServerProfileById(serverId);
    const homeName = resolveHomeDisplayLabel(profile, serverId);
    const forbidden = entry?.status === 'denied' || actionError === 'permission_denied'
        || actionError === 'not_authenticated' || actionError === 'action_account_scope_changed';
    const enrolledMachineId = forbidden || !machine ? undefined : managedMachineEnrolledDetailId(machine, enrolledMachinePresent);
    if (enrolledMachineId) return <Redirect href={machinePageHref({ door,
        target: { machineId: enrolledMachineId, serverId: props.serverId } }) as never} />;

    const mark = (headerMachine && !forbidden ? identity?.mark : undefined) ?? <Icon name="desktop" color={theme.colors.text.secondary} />;

    const showMachine = Boolean(machine && !forbidden);
    const showHeaderIdentity = Boolean(headerMachine && !forbidden);
    const loading = inventory.loading && !machine;
    // A confirmed-absent machine says it is gone and leads back to Machines; a Retry can't bring it back (MB-3).
    const gone = detailRead.missing && !forbidden && !loading;
    const reason = forbidden || accountState?.resolution.kind === 'signed_out'
        ? t('managedMachines.detail.readRefused') : detailRead.missing
            ? t('managedMachines.detail.missing') : t('managedMachines.detail.loadFailed');
    return <ManagedReceiptPageLayout testID="managed-machine.detail" compact={layout?.mode !== 'split'}
        // Retry belongs to the state that needs it (the read card, or the freshness of a stale read on the state), never the header.
        // A pending read claims nothing: the neutral machine header (as a machine page while it loads) until
        // the record or its list row names it; the "Created machine" copy belongs only to a settled failed read.
        header={{ title: showHeaderIdentity ? identity!.name
                : loading ? t('machineDetailPage.placeholderTitle') : gone ? t('managedMachines.detail.goneTitle') : t('managedMachines.detail.unreadTitle'), leading: mark,
            description: showHeaderIdentity ? identity?.description ?? undefined
                : loading || gone ? undefined : t('managedMachines.detail.creationDescription'),
            meta: [{ key: 'home', text: homeName }, ...(showHeaderIdentity ? identity?.meta ?? [] : [])] }}
        /* The sections own the receipt beside them, with Stop and Delete at its foot. */
        receipt={null}>
        <ManagedMachineReadApprovalNotice serverId={serverId} entry={entry} />
        {!showMachine ? <SurfaceStateCard testID="managed-machine.read-state" kind={loading ? 'loading' : forbidden ? 'denied' : 'unavailable'}
            title={loading ? t('common.loading') : reason} diagnosticCode={entry?.errorCode}
            action={loading ? undefined : gone ? { label: t('managedMachines.detail.backToMachines'), onPress: () => router.push(machinesIndexHref(door) as never) }
                : { label: t('common.retry'), onPress: () => { setActionError(null); inventory.refresh(); } }} /> : <>
            <ManagedMachineSections machine={machine!} serverId={serverId} executeAction={executeAction}
                binding={inventory.bindings.get(serverId)} current={entry?.status === 'ready'}
                onChanged={inventory.refresh} onDenied={setActionError}
                {...(entry?.status === 'error' || entry?.status === 'unsupported' ? { staleRead: { retry: inventory.refresh } } : {})} />
            {actionError ? <SurfaceStateCard kind="error" size="line" title={t('managedMachines.detail.loadFailed')}
                diagnosticCode={actionError} testID="managed-machine.action-error" /> : null}
        </>}
    </ManagedReceiptPageLayout>;
}
