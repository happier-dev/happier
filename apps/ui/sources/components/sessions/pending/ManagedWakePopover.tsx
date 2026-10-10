import * as React from 'react';
import { View } from 'react-native';

import { AgentInputContentPopover } from '@/components/sessions/agentInput/components/AgentInputContentPopover';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SectionButtonRow } from '@/components/ui/lists/SectionButtonRow';
import { Icon } from '@/components/ui/icons/Icon';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import type { ManagedWakeProjection } from '@/sync/domains/pending/managedWakeProjection';
import { formatAsOfTime } from '@/utils/time/formatAsOfTime';
import { t } from '@/text';

type WakeNames = Readonly<{ controllerName: string; machineName: string; homeName: string; agentName: string }>;

/** Copy only: native stages and pending custody remain the projection owner's facts. */
export function describeManagedWakeLabel(projection: ManagedWakeProjection, names: WakeNames): string {
    switch (projection.kind) {
        case 'waiting': return t('managedWake.waiting', { controller: names.controllerName });
        case 'starting': return t('managedWake.starting', { machine: names.machineName });
        case 'connecting': return t('managedWake.connecting', { machine: names.machineName, home: names.homeName });
        case 'resuming': return t('managedWake.resuming');
        case 'resourceAbsent': return t('managedPower.resourceAbsent');
        case 'storageLost': return t('managedPower.volumeLost');
        case 'unknown': return t('status.unknown');
        case 'deliveryUnknown': return t('managedWake.deliveryUnknown');
        case 'agentStartFailed': return projection.canRetryAgentStart
            ? t('managedWake.agentStartFailed', { machine: names.machineName, agent: names.agentName })
            : t('managedWake.unavailable');
        case 'unavailable': return t(projection.inputCustody === 'queued' ? 'managedWake.unavailable' : 'managedWake.deliveryUnknown');
    }
}

/** The incumbent AgentInput overlay owns phone recomposition, anchoring and focus return. */
export function ManagedWakePopover(props: WakeNames & Readonly<{
    open: boolean;
    anchorRef: React.RefObject<React.ComponentRef<typeof View> | null>;
    projection: ManagedWakeProjection;
    controllerPresence: string;
    busy: boolean;
    onRequestClose: () => void;
    onOpenMachine: () => void;
    onOpenController: () => void;
    onCheckNow?: () => void;
    onRetry?: () => void;
    onResume?: () => void;
    onWithdraw?: () => void;
}>) {
    const progressing = ['starting', 'connecting', 'resuming'].includes(props.projection.kind);
    return <AgentInputContentPopover open={props.open} anchorRef={props.anchorRef} onRequestClose={props.onRequestClose}
        testID="session.managedWake.popover" content={props.open ? <>
            <ItemGroup>
                <Item title={props.machineName} subtitle={props.homeName} icon={<Icon name="desktop" />}
                    testID="session.managedWake.machine" onPress={() => { props.onRequestClose(); props.onOpenMachine(); }} />
                <Item title={props.controllerName} subtitle={props.controllerPresence} icon={<Icon name="desktop" />}
                    testID="session.managedWake.controller" onPress={() => { props.onRequestClose(); props.onOpenController(); }} />
                <Item title={describeManagedWakeLabel(props.projection, props)} titleLines={0} mode="info" showChevron={false}
                    testID={`session.managedWake.${props.projection.kind}.stage`}
                    subtitle={props.projection.observedAt === undefined ? undefined
                        : t('surfaceState.asOf', { time: formatAsOfTime(props.projection.observedAt) })}
                    subtitleLeading={progressing ? <ActivitySpinner size="small" /> : undefined} />
            </ItemGroup>
            <ItemGroup surface="none"><SectionButtonRow>
                {props.onRetry ? <RoundButton title={t('session.pendingActivation.actions.retry')} size="small" disabled={props.busy}
                    testID="session.managedWake.retry" onPress={props.onRetry} /> : null}
                {props.onResume ? <RoundButton title={t('session.pendingActivation.actions.resume')} size="small" disabled={props.busy}
                    testID="session.managedWake.resume" onPress={props.onResume} /> : null}
                {props.onWithdraw ? <RoundButton title={t('managedWake.withdraw')} size="small" display="inverted" disabled={props.busy}
                    testID="session.managedWake.withdraw" onPress={props.onWithdraw} /> : null}
                {props.onCheckNow ? <RoundButton title={t('managedMachines.inspect.checkNow')} size="small" display="inverted" disabled={props.busy}
                    testID="session.managedWake.checkNow" onPress={props.onCheckNow} /> : null}
            </SectionButtonRow>
            </ItemGroup>
        </> : null} />;
}
