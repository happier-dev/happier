import * as React from 'react';
import { View } from 'react-native';

import {
    PluginUiEphemeralInputSettlementV1Schema,
    type PluginUiEphemeralInputSettlementV1,
} from '@happier-dev/protocol/plugins/ui';
import type { DaemonContributionRegistryProjectionAutomationEligibleEventV1 } from '@happier-dev/protocol';

import type { DaemonMergedProjectionInputs } from '@/agents/backendCatalog/loadDaemonMergedProjectionInputs';
import {
    PluginSurfaceHost,
    type PluginSurfaceEphemeralMountProps,
} from '@/components/plugins/surfaces/PluginSurfaceHost';
import {
    createPluginSurfaceHostApiError,
    type PluginSurfaceHostApiHandlers,
} from '@/components/plugins/surfaces/createPluginSurfaceHostApi';
import { readPluginSurfaceEphemeralMountBinding } from '@/components/plugins/surfaces/pluginSurfaceMountBinding';
import type { BoundPluginSurfaceBinding } from '@/components/plugins/surfaces/boundPluginSurfaceController';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Modal } from '@/modal';
import type { CustomModalInjectedProps } from '@/modal';
import { useModalCardChrome } from '@/modal/components/card/useModalCardChrome';
import type { ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { t } from '@/text';

export type PluginEventAutomationSetupSurfaceSettlement = PluginUiEphemeralInputSettlementV1;

export function createPluginEventAutomationSetupSurfaceBinding(params: Readonly<{
    isSettled: () => boolean;
    settle: (settlement: PluginEventAutomationSetupSurfaceSettlement) => void;
}>): BoundPluginSurfaceBinding {
    return Object.freeze({
        createMountedHostApiHandlers: ({ isCurrent }) => {
            const handlers: PluginSurfaceHostApiHandlers = Object.freeze({
                settleEphemeralInput: (request) => {
                    if (!isCurrent() || params.isSettled()) {
                        return createPluginSurfaceHostApiError('stale_surface', [
                            'ephemeral_input_mount_retired',
                        ]);
                    }
                    const parsed = PluginUiEphemeralInputSettlementV1Schema.safeParse(request.payload);
                    if (!parsed.success) {
                        return createPluginSurfaceHostApiError('invalid_payload', [
                            'ephemeral_input_settlement_invalid',
                        ]);
                    }
                    params.settle(parsed.data);
                    return null;
                },
            });
            return Object.freeze({ handlers });
        },
    });
}

type SetupSurfaceModalProps = Readonly<{
    eligibleEvent: DaemonContributionRegistryProjectionAutomationEligibleEventV1;
    projection: DaemonMergedProjectionInputs;
    machineId: string;
    serverId: string | null;
    accountLifetime: ActiveServerAccountScopeLifetime;
    onSettle: (settlement: PluginEventAutomationSetupSurfaceSettlement) => void;
}> & CustomModalInjectedProps;

function PluginEventAutomationSetupSurfaceModal(
    props: SetupSurfaceModalProps,
): React.ReactElement | null {
    const setupSurface = props.eligibleEvent.setupSurface;
    const mount = React.useMemo(
        () => setupSurface ? readPluginSurfaceEphemeralMountBinding(setupSurface) : null,
        [setupSurface],
    );
    const settledRef = React.useRef(false);
    const onSettleRef = React.useRef(props.onSettle);
    onSettleRef.current = props.onSettle;
    const onCloseRef = React.useRef(props.onClose);
    onCloseRef.current = props.onClose;
    const settle = React.useCallback((settlement: PluginEventAutomationSetupSurfaceSettlement) => {
        if (settledRef.current) return;
        settledRef.current = true;
        onSettleRef.current(settlement);
        onCloseRef.current();
    }, []);
    const binding = React.useMemo<BoundPluginSurfaceBinding>(() => (
        createPluginEventAutomationSetupSurfaceBinding({
            isSettled: () => settledRef.current,
            settle,
        })
    ), [settle]);
    const footer = React.useMemo(() => (
        <View style={{ alignItems: 'center', flexDirection: 'row', justifyContent: 'flex-end' }}>
            <RoundButton
                testID="plugin-event-automation-setup-surface-cancel"
                accessibilityLabel={t('common.cancel')}
                title={t('common.cancel')}
                size="normal"
                display="inverted"
                onPress={() => settle({ kind: 'cancelled' })}
            />
        </View>
    ), [settle]);
    const chrome = React.useMemo(() => ({
        kind: 'card' as const,
        title: props.eligibleEvent.event.title,
        ...(props.eligibleEvent.event.description
            ? { subtitle: props.eligibleEvent.event.description }
            : {}),
        footer,
        dimensions: { size: 'lg' as const, maxHeightRatio: 0.9 },
        scrollHost: 'body' as const,
        bodyScroll: 'auto' as const,
    }), [footer, props.eligibleEvent.event.description, props.eligibleEvent.event.title]);
    useModalCardChrome(props.setChrome, chrome);

    React.useEffect(() => () => {
        if (!settledRef.current) onSettleRef.current({ kind: 'cancelled' });
    }, []);

    if (!mount || !setupSurface) return null;
    const ephemeralMount: PluginSurfaceEphemeralMountProps = Object.freeze({
        mount,
        boundaryResetKey: [
            setupSurface.contribution.pluginId,
            setupSurface.contribution.localId,
            setupSurface.immutableGenerationId,
            setupSurface.projectionGeneration,
        ].join(':'),
        physicalTarget: Object.freeze({ kind: 'app' as const }),
        parentLifetime: props.accountLifetime,
        pluginProjectionById: props.projection.pluginProjectionById,
        pluginProjectionV2: props.projection.pluginProjectionV2,
        daemonProjectionReady: true,
        fallback: null,
        binding,
    });
    return (
        <PluginSurfaceHost
            ephemeralMount={ephemeralMount}
            machineId={props.machineId}
            serverId={props.serverId}
        />
    );
}

/**
 * Mount one exact cold-projected setup surface and return its first terminal
 * input settlement. This function owns no durable state and performs no Action
 * invocation; its caller revalidates and submits the value through the generic
 * Action input owner.
 */
export async function presentPluginEventAutomationSetupSurface(params: Readonly<{
    eligibleEvent: DaemonContributionRegistryProjectionAutomationEligibleEventV1;
    projection: DaemonMergedProjectionInputs;
    machineId: string;
    serverId: string | null;
    accountLifetime: ActiveServerAccountScopeLifetime;
    signal?: AbortSignal;
}>): Promise<PluginEventAutomationSetupSurfaceSettlement> {
    const setupSurface = params.eligibleEvent.setupSurface;
    const plugin = params.projection.pluginProjectionById[
        params.eligibleEvent.event.identity.pluginId
    ];
    if (
        !setupSurface
        || !readPluginSurfaceEphemeralMountBinding(setupSurface)
        || setupSurface.selectedRenderer.availability.state !== 'available'
        || plugin?.enabled !== true
        || plugin.immutableGenerationId !== setupSurface.immutableGenerationId
        || params.projection.pluginProjectionV2?.generation !== setupSurface.projectionGeneration
        || params.signal?.aborted
        || !params.accountLifetime.isCurrent()
    ) return { kind: 'cancelled' };

    return await new Promise<PluginEventAutomationSetupSurfaceSettlement>((resolve) => {
        let modalId = '';
        let settled = false;
        const finish = (settlement: PluginEventAutomationSetupSurfaceSettlement) => {
            if (settled) return;
            settled = true;
            params.signal?.removeEventListener('abort', onAbort);
            if (modalId) Modal.hide(modalId);
            resolve(settlement);
        };
        const onAbort = () => finish({ kind: 'cancelled' });
        params.signal?.addEventListener('abort', onAbort, { once: true });
        modalId = Modal.show({
            component: PluginEventAutomationSetupSurfaceModal,
            props: {
                eligibleEvent: params.eligibleEvent,
                projection: params.projection,
                machineId: params.machineId,
                serverId: params.serverId,
                accountLifetime: params.accountLifetime,
                onSettle: finish,
            },
            onRequestClose: onAbort,
            onHostUnmount: onAbort,
            closeOnBackdrop: false,
        });
        if (!modalId || params.signal?.aborted || !params.accountLifetime.isCurrent()) onAbort();
    });
}
