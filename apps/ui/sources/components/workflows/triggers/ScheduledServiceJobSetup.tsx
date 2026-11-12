import * as React from 'react';
import { useWindowDimensions, type View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import type { WorkflowProjectTargetV1 } from '@happier-dev/protocol/workflows';
import type { TriggerTargetV1 } from '@happier-dev/protocol/workflows/triggers/triggerTargetV1';

import { useMachineServicesList } from '@/components/machines/services/useMachineServicesList';
import { machineServiceDisplayName, machineServiceIcon } from '@/components/machines/services/machineServicesPresentation';
import { Icon } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { FloatingOverlay } from '@/components/ui/overlays/FloatingOverlay';
import { Popover } from '@/components/ui/popover';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { t } from '@/text';

import { NewAccountTriggerPopover } from './AccountTriggersSection';
import { buildTriggerTarget } from './sessionTriggerForm';
import { TRIGGER_POPOVER_WIDTH } from './TriggerPopover';

export type ScheduledServiceJobSetupProps = Readonly<{
    anchorRef: React.RefObject<View | null>;
    onRequestClose(): void;
    serverId: string;
    environmentId: string;
    machineId: string;
    project: WorkflowProjectTargetV1;
}>;

/** Service selection supplies identity only. The existing trigger editor owns the
 * command, schedule, approval and eventual Save; opening this picker writes nothing. */
export function ScheduledServiceJobSetup(props: ScheduledServiceJobSetupProps): React.ReactElement {
    const { binding } = useServerCredentialAccountScopeBinding(props.serverId);
    const [actionTargets, setActionTargets] = React.useState<readonly TriggerTargetV1[] | null>(null);
    if (actionTargets) return <NewAccountTriggerPopover anchorRef={props.anchorRef} onRequestClose={props.onRequestClose}
        accountLifetime={binding} initialProject={props.project} initialActionTargets={actionTargets} />;
    return <ServicePicker {...props} onSelect={target => setActionTargets([target])} />;
}

/** The Resource follows only the visible picker, then retires when the command editor opens. */
function ServicePicker(props: ScheduledServiceJobSetupProps & Readonly<{ onSelect(target: TriggerTargetV1): void }>) {
    const list = useMachineServicesList({ serverId: props.serverId, machineId: props.machineId,
        environmentId: props.environmentId, active: true });
    const { theme } = useUnistyles();
    const { height } = useWindowDimensions();
    const services = list.rows?.filter(row => row.capabilities.exec === true && row.generation !== null) ?? [];
    const retry = { label: t('common.retry'), onPress: () => { void list.refresh(); } };
    return <Popover open anchorRef={props.anchorRef} onRequestClose={props.onRequestClose}
        placement="bottom" phonePresentation="sheet" autoFocusOnOpen
        accessibilityLabel={t('workflows.examples.runJobOnSchedule.title')}
        maxWidthCap={TRIGGER_POPOVER_WIDTH} maxHeightCap={height}
        portal={{ web: { target: 'body' }, native: true, matchAnchorWidth: false, anchorAlign: 'end' }}>
        {({ maxHeight }) => <FloatingOverlay maxHeight={maxHeight} scrollEnabled>
            <ItemGroup title={t('workflows.examples.runJobOnSchedule.title')}>
                {list.error ? <SurfaceStateCard testID="scheduled-service-job-error" size="line" kind="error"
                    title={t('machineServices.error.title')} reason={t('common.requestFailed')}
                    diagnosticCode={list.error.code} action={retry} /> : list.unavailable ?
                    <SurfaceStateCard testID="scheduled-service-job-unavailable" size="line" kind="unavailable"
                        title={t('machineServices.unavailable.body')} diagnosticCode={list.unavailable} action={retry} /> : null}
                {list.rows === null && !list.error && !list.unavailable ?
                    <SurfaceStateCard testID="scheduled-service-job-loading" size="line" kind="loading" title={t('common.loading')} /> : null}
                {list.rows !== null && services.length === 0 && !list.error && !list.unavailable ?
                    <SurfaceStateCard testID="scheduled-service-job-empty" size="line" kind={list.rows.length === 0 ? 'empty' : 'unavailable'}
                        title={t(list.rows.length === 0 ? 'machineServices.empty.body' : 'machineServices.control.unavailable')} /> : null}
                {services.map(service => <Item key={service.serviceId} testID={`scheduled-service-job-service-${service.serviceId}`}
                    title={machineServiceDisplayName(service)} subtitle={t(`machineServices.state.${service.state}`)}
                    icon={<Icon name={machineServiceIcon(service)} color={theme.colors.text.secondary} />}
                    onPress={() => {
                        const target = buildTriggerTarget({ kind: 'doAction', actionId: 'machines.services.exec', input: {
                            serverId: props.serverId, machineId: props.machineId,
                            target: { kind: 'current', serviceId: service.serviceId, expectedGeneration: service.generation },
                            mode: 'exec', argv: [],
                        } }, 'account');
                        if (target) props.onSelect(target);
                    }} />)}
            </ItemGroup>
        </FloatingOverlay>}
    </Popover>;
}
