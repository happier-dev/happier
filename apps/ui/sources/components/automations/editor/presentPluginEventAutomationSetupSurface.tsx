import * as React from 'react';
import { View } from 'react-native';

import {
    PluginUiEphemeralInputSettlementV1Schema,
    type PluginUiEphemeralInputSettlementV1,
} from '@happier-dev/protocol/plugins/ui';
import type { DaemonContributionRegistryProjectionAutomationEligibleEventV1, DaemonContributionRegistryProjectionAutomationEligibleEventSetupSurfaceV1 } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import type { PluginUiLaunchInputV1 } from '@happier-dev/protocol/plugins/ui';

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
import { PluginMachineExecutionOriginPickerProvider } from '@/components/settings/machines/PluginMachineExecutionOriginSelector';
import { Modal } from '@/modal';
import type { CustomModalInjectedProps } from '@/modal';
import type { BaseModalConfig } from '@/modal/types';
import { HAPPIER_PAGE_METRICS } from '@happier-dev/plugin-ui/presentation/pageMetrics';
import { createAnchoredSheetChrome } from '@/modal/components/card/anchoredSheetChrome';
import { useModalCardChrome } from '@/modal/components/card/useModalCardChrome';
import type { ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { subscribeMachineContributionRegistryProjectionInvalidation } from '@/sync/ops/machineContributionRegistryProjection';
import { t } from '@/text';
import { useDeviceType } from '@/utils/platform/responsive';

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

/**
 * `setup`: an Automation's event setup page, which draws no title of its own: the card's band carries the
 * event title and its description at every width. `picker`: an Action form's input picker, which continues
 * the form it opens from; its page draws its own title on a wide screen, so the card draws no second band
 * there (the title stays the dialog's accessible name; Cancel and Esc close it). A phone sheet keeps its band.
 */
export type PluginEphemeralInputSurfacePresentation = 'setup' | 'picker';

export function resolvePluginEphemeralInputSurfaceChrome(input: Readonly<{
    title: string;
    description?: string;
    presentation: PluginEphemeralInputSurfacePresentation;
    phone: boolean;
    footer: React.ReactNode;
}>) {
    return {
        ...createAnchoredSheetChrome({
            title: input.title,
            ...(input.presentation === 'setup' && input.description ? { subtitle: input.description } : {}),
        }),
        header: input.presentation === 'picker' && !input.phone ? 'none' as const : 'band' as const,
        footer: input.footer,
    };
}

// Keeps the body's height contract (it fills and may shrink) while adding the card's content edge.
const SETUP_SURFACE_INSET = { flexGrow: 1, flexShrink: 1, minHeight: 0, paddingHorizontal: HAPPIER_PAGE_METRICS.sheetInsetPx } as const;

type SetupSurfaceModalProps = Readonly<{
    surface: DaemonContributionRegistryProjectionAutomationEligibleEventSetupSurfaceV1;
    title: string;
    description?: string;
    presentation: PluginEphemeralInputSurfacePresentation;
    launchInput?: PluginUiLaunchInputV1;
    projection: DaemonMergedProjectionInputs;
    machineId: string;
    serverId: string | null;
    accountLifetime: ActiveServerAccountScopeLifetime;
    onSettle: (settlement: PluginEventAutomationSetupSurfaceSettlement) => void;
}> & CustomModalInjectedProps;

function PluginEventAutomationSetupSurfaceModal(
    props: SetupSurfaceModalProps,
): React.ReactElement | null {
    const setupSurface = props.surface;
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
    const phone = useDeviceType() === 'phone';
    const chrome = React.useMemo(() => resolvePluginEphemeralInputSurfaceChrome({
        title: props.title, description: props.description, presentation: props.presentation, phone, footer,
    }), [footer, phone, props.description, props.presentation, props.title]);
    useModalCardChrome(props.setChrome, chrome);

    React.useEffect(() => () => {
        if (!settledRef.current) onSettleRef.current({ kind: 'cancelled' });
    }, []);

    if (!mount || !setupSurface) return null;
    const actionInputSelectionFactsKey = props.projection.ephemeralInputSurfaceActionInputSelectionFacts.get(setupSurface);
    if (!actionInputSelectionFactsKey) throw new Error('ephemeral_input_surface_action_input_selection_facts_missing');
    const ephemeralMount: PluginSurfaceEphemeralMountProps = Object.freeze({
        mount,
        boundaryResetKey: [
            setupSurface.contribution.pluginId,
            setupSurface.contribution.localId,
            setupSurface.occurrenceId,
            setupSurface.projectionGeneration,
        ].join(':'),
        physicalTarget: Object.freeze({ kind: 'app' as const }),
        parentLifetime: props.accountLifetime,
        pluginProjectionById: props.projection.pluginProjectionById,
        pluginProjectionV2: props.projection.pluginProjectionV2,
        pluginUiProjection: props.projection.pluginUiProjection,
        actionInputSelectionFactsKey,
        binding,
    });
    const host = <PluginSurfaceHost ephemeralMount={ephemeralMount} machineId={props.machineId} serverId={props.serverId}
        launchInput={props.launchInput} />;
    // The picker owns its plugin's Run-on picker, so an offline Machine's "Choose another" opens it here.
    return (
        <PluginMachineExecutionOriginPickerProvider pluginId={setupSurface.contribution.pluginId}>
            {/* A setup form stands on the card's content edge, in line with its title and footer; a picker's rows run to
                the card edge themselves (ROWS-FLEET-OPS-177 F4: the health setup form sat flush against the card). */}
            {props.presentation === 'setup' ? <View style={SETUP_SURFACE_INSET}>{host}</View> : host}
        </PluginMachineExecutionOriginPickerProvider>
    );
}

/**
 * Mount one exact cold-projected setup surface and return its first terminal
 * input settlement. This function owns no durable state and performs no Action
 * invocation; its caller revalidates and submits the value through the generic
 * Action input owner.
 */
export async function presentPluginEphemeralInputSurface(params: Readonly<{
    surface: DaemonContributionRegistryProjectionAutomationEligibleEventSetupSurfaceV1;
    title: string;
    description?: string;
    presentation: PluginEphemeralInputSurfacePresentation;
    launchInput?: PluginUiLaunchInputV1;
    projection: DaemonMergedProjectionInputs;
    machineId: string;
    serverId: string | null;
    accountLifetime: ActiveServerAccountScopeLifetime;
    signal?: AbortSignal;
    commandBridge?: BaseModalConfig['commandBridge'];
}>): Promise<PluginEventAutomationSetupSurfaceSettlement> {
    const setupSurface = params.surface;
    const plugin = params.projection.pluginProjectionById[
        setupSurface.contribution.pluginId
    ];
    if (
        !setupSurface
        || !readPluginSurfaceEphemeralMountBinding(setupSurface)
        || setupSurface.selectedRenderer.availability.state !== 'available'
        || plugin?.enabled !== true
        || params.projection.pluginProjectionV2?.generation !== setupSurface.projectionGeneration
        || params.signal?.aborted
        || !params.accountLifetime.isCurrent()
    ) return { kind: 'cancelled' };

    return await new Promise<PluginEventAutomationSetupSurfaceSettlement>((resolve) => {
        let modalId = '';
        let settled = false;
        let releaseRetirement: (() => void) | undefined;
        let releaseProjection: (() => void) | undefined;
        const finish = (settlement: PluginEventAutomationSetupSurfaceSettlement) => {
            if (settled) return;
            settled = true;
            params.signal?.removeEventListener('abort', onAbort);
            releaseRetirement?.();
            releaseProjection?.();
            if (modalId) Modal.hide(modalId);
            resolve(settlement);
        };
        const onAbort = () => finish({ kind: 'cancelled' });
        params.signal?.addEventListener('abort', onAbort, { once: true });
        const retirement = params.accountLifetime.onRetire(onAbort);
        releaseRetirement = () => retirement.dispose();
        releaseProjection = subscribeMachineContributionRegistryProjectionInvalidation({
            machineId: params.machineId, serverId: params.serverId,
        }, onAbort);
        if (settled) {
            releaseRetirement();
            releaseProjection();
            return;
        }
        modalId = Modal.show({
            component: PluginEventAutomationSetupSurfaceModal,
            commandBridge: params.commandBridge,
            props: {
                surface: params.surface,
                title: params.title,
                description: params.description,
                presentation: params.presentation,
                launchInput: params.launchInput,
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

export function presentPluginEventAutomationSetupSurface(params: Readonly<{
    eligibleEvent: DaemonContributionRegistryProjectionAutomationEligibleEventV1;
    projection: DaemonMergedProjectionInputs;
    machineId: string;
    serverId: string | null;
    accountLifetime: ActiveServerAccountScopeLifetime;
    signal?: AbortSignal;
    commandBridge?: BaseModalConfig['commandBridge'];
    launchInput?: PluginUiLaunchInputV1;
    /** The host's own name for this setup (Add check), in place of the Event's trigger wording. */
    heading?: Readonly<{ title: string; description?: string }>;
}>): Promise<PluginEventAutomationSetupSurfaceSettlement> {
    const surface = params.eligibleEvent.setupSurface;
    if (!surface) return Promise.resolve({ kind: 'cancelled' });
    const { heading, ...rest } = params;
    return presentPluginEphemeralInputSurface({
        ...rest, surface, title: heading?.title ?? params.eligibleEvent.event.title,
        description: heading ? heading.description : params.eligibleEvent.event.description ?? undefined,
        presentation: 'setup',
    });
}
