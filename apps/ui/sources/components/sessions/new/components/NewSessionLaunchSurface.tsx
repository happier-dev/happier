import * as React from 'react';
import { Platform, ScrollView, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { useChromeSafeAreaInsets } from '@/components/ui/layout/useChromeSafeAreaInsets';
import { useReduceTransparency } from '@/hooks/ui/useReduceTransparency';
import {
    ModalPaneBoundaryView,
    useModalPaneBoundary,
} from '@/components/ui/panels/ModalPaneBoundary';
import type { FocusReturnTarget } from '@/keyboard/focusReturn';
import { t } from '@/text';
import type { SessionAuthoringExecutionTargetV2 } from '@happier-dev/protocol';
import type { RunnerActivationProjectionV1 } from '@happier-dev/protocol/ephemeralRunner/projection';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { readAcceptedRunnerCreatorActivationBinding, RunnerCreatorLaunchCustodyUnavailableError } from '@/sync/domains/ephemeralRunner/runnerCreatorLaunchCustody';
import { openRunnerActivationKeyCustody } from '@/sync/domains/ephemeralRunner/runnerActivationKeyCustody';
import { useTemporaryComputerLaunch, type TemporaryComputerLaunchController } from '../hooks/useTemporaryComputerLaunch';
import { resolveTemporaryComputerLaunchDismissal } from '../hooks/temporaryComputerLaunchDismissal';
import { resolveTemporaryComputerWaitingTarget } from '../hooks/temporaryComputerWaitingTarget';
import { TemporaryComputerLaunchSurface } from './TemporaryComputerLaunchSurface';

export type NewSessionTemporaryComputerLaunch = Readonly<{
    input: Parameters<typeof useTemporaryComputerLaunch>[0];
    controlRef: React.MutableRefObject<TemporaryComputerLaunchController | null>;
    scope: ServerAccountScope | null;
    committedTarget: Extract<SessionAuthoringExecutionTargetV2, { kind: 'temporary_computer' }> | null;
    homeLabel: string | null;
    accountLabel: string | null;
    exportPackage: (projection: RunnerActivationProjectionV1) => Promise<void>;
    onActiveChange: (active: boolean) => void;
    onLeave: () => void;
}>;

const inactiveLaunchInput: Parameters<typeof useTemporaryComputerLaunch>[0] = {
    client: null, serverId: null, draftId: '', existingPublicRef: null,
    prepareActivation: async () => { throw new Error('runner_creator_activation_dependency_unavailable'); },
    persistPublicRef: () => undefined,
    onMaterialized: () => undefined,
};

/** Progress and export state stay beside their presentation, outside the authoring tree. */
function useTemporaryComputerLaunchSurface(options: NewSessionTemporaryComputerLaunch | undefined) {
    const controller = useTemporaryComputerLaunch(options?.input ?? inactiveLaunchInput);
    React.useImperativeHandle(options?.controlRef, () => controller, [controller]);
    const active = controller.status !== 'idle';
    const onActiveChange = options?.onActiveChange;
    React.useEffect(() => { onActiveChange?.(active); }, [active, onActiveChange]);
    const projection = controller.projection;
    const scope = options?.scope;
    const [custody, setCustody] = React.useState<Readonly<{
        activationId: string; scope: ServerAccountScope; creator: boolean; exportable: boolean;
    }> | null>(null);
    React.useEffect(() => {
        if (!projection || !scope) return;
        let current = true;
        void (async () => {
            // Accepted launch custody survives retirement of the export secret.
            await readAcceptedRunnerCreatorActivationBinding(scope, projection.activationId, projection);
            const exportable = projection.state === 'pending'
                && await openRunnerActivationKeyCustody(scope, projection.activationId).then(() => true, () => false);
            if (current) setCustody({ activationId: projection.activationId, scope, creator: true, exportable });
        })().catch((error: unknown) => {
            if (!current) return;
            // A failed storage transport does not establish that this is another device.
            setCustody(error instanceof RunnerCreatorLaunchCustodyUnavailableError
                ? { activationId: projection.activationId, scope, creator: false, exportable: false }
                : null);
        });
        return () => { current = false; };
    }, [projection, scope]);
    const localCustody = custody?.activationId === projection?.activationId
        && custody?.scope.serverId === scope?.serverId
        && custody?.scope.accountId === scope?.accountId ? custody : null;
    const canExport = projection?.state === 'pending' && localCustody?.exportable === true;
    const [exportState, setExportState] = React.useState<{
        status: 'idle' | 'exporting' | 'failed'; activationId: string | null; error: unknown;
    }>({ status: 'idle', activationId: null, error: null });
    const exportInFlight = React.useRef<Promise<void> | null>(null);
    const exported = React.useRef(new Set<string>());
    const exportPackage = options?.exportPackage;
    const requestExport = React.useCallback(async () => {
        if (exportInFlight.current) return exportInFlight.current;
        if (!projection || !canExport || !exportPackage) return;
        const activationId = projection.activationId;
        setExportState({ status: 'exporting', activationId, error: null });
        const operation = exportPackage(projection);
        exportInFlight.current = operation;
        try {
            await operation;
            setExportState({ status: 'idle', activationId, error: null });
        } catch (error) {
            setExportState({ status: 'failed', activationId, error });
            throw error;
        } finally {
            if (exportInFlight.current === operation) exportInFlight.current = null;
        }
    }, [canExport, exportPackage, projection]);
    React.useEffect(() => {
        if (!projection || !canExport || exported.current.has(projection.activationId)) return;
        exported.current.add(projection.activationId);
        void requestExport().catch(() => { exported.current.delete(projection.activationId); });
    }, [canExport, projection, requestExport]);
    const dismiss = () => {
        const decision = resolveTemporaryComputerLaunchDismissal({
            status: controller.status, projectionState: projection?.state ?? null,
        });
        if (decision === 'acknowledge_terminal') controller.dismissTerminal();
        else if (decision !== 'none') options?.onLeave();
    };
    return {
        dismiss,
        overlay: active && options ? <TemporaryComputerLaunchSurface
            controller={controller}
            target={resolveTemporaryComputerWaitingTarget({ projection, ...options })}
            packageExportState={exportState}
            createdOnDeviceLabel={options.input.existingPublicRef?.createdOnDeviceLabel ?? null}
            pendingPackageExpiresAt={options.committedTarget?.packageExpiresAt ?? null}
            packageAvailableOnThisDevice={localCustody ? canExport : undefined}
            packageCustodyOnThisDevice={localCustody?.creator}
            onExportPackage={canExport ? requestExport : undefined}
            onContinueLater={options.onLeave}
        /> : null,
    };
}

const OVERLAY_EDGE_PADDING = 16;
/** Keeps the launch card readable rather than stretching it across a desktop pane. */
const OVERLAY_MAX_CONTENT_WIDTH = 520;

/**
 * Keeps the canonical authoring tree mounted while one launch attempt owns the
 * screen. The existing launch controller owns lifecycle; its progress subscription
 * lives here beside the overlay rather than in the authoring model.
 */
export function NewSessionLaunchSurface(props: Readonly<{
    children: React.ReactNode;
    overlay: React.ReactNode | null;
    onRequestClose: () => void;
    overlayPresentation?: 'card' | 'screen';
    /** Embedded cards replace the short composer footprint instead of overlaying it. */
    presentation?: 'screen' | 'embedded';
    focusReturnRef?: React.RefObject<FocusReturnTarget>;
    overlayAccessibilityLabel?: string;
    temporaryComputerLaunch?: NewSessionTemporaryComputerLaunch;
}>): React.ReactElement {
    const temporaryLaunch = useTemporaryComputerLaunchSurface(props.temporaryComputerLaunch);
    const overlay = props.overlay ?? temporaryLaunch.overlay;
    const { theme } = useUnistyles();
    const insets = useChromeSafeAreaInsets();
    // Reduce Transparency means the retained composer must not show through the
    // frozen launch surface at all: the overlay becomes an opaque canonical
    // surface rather than a veil over live-looking controls that no longer work.
    const reduceTransparency = useReduceTransparency();
    const frozen = overlay !== null;
    const embeddedCard = props.presentation === 'embedded' && props.overlayPresentation !== 'screen';
    const internalFocusReturnRef = React.useRef<FocusReturnTarget>(null);
    const focusReturnRef = props.focusReturnRef ?? internalFocusReturnRef;
    const boundary = useModalPaneBoundary({
        active: frozen,
        label: props.overlayAccessibilityLabel ?? t('newSession.temporaryComputer.title'),
        onRequestClose: props.overlay != null ? props.onRequestClose : temporaryLaunch.dismiss,
        focusReturnRef,
        escapeEnabled: true,
        allowEditableEscape: true,
    });

    return (
        <View style={{ flex: 1, minWidth: 0, minHeight: 0 }}>
            <ModalPaneBoundaryView
                ref={boundary.setUnderlayFocusRef}
                testID="new-session-launch-authoring"
                style={{ flex: 1, minWidth: 0, minHeight: 0, ...(embeddedCard && frozen ? { display: 'none' } : {}) }}
                onFocus={(event) => {
                    if (!frozen) focusReturnRef.current = event.target as unknown as FocusReturnTarget;
                }}
                {...boundary.underlayProps}
            >
                {props.children}
            </ModalPaneBoundaryView>
            {frozen ? (
                <ModalPaneBoundaryView
                    ref={boundary.setOverlayFocusRef}
                    testID="new-session-launch-overlay"
                    {...boundary.overlayProps}
                    style={{
                        position: embeddedCard ? 'relative' : 'absolute',
                        top: 0,
                        right: 0,
                        bottom: 0,
                        left: 0,
                        // Programmatic dialog focus is an entry anchor, not a control. Actual
                        // actions keep their canonical keyboard focus indicators.
                        ...(Platform.OS === 'web' ? { outlineWidth: 0 } : {}),
                        backgroundColor: embeddedCard || props.overlayPresentation === 'screen' || reduceTransparency
                            ? theme.colors.surface.base
                            : theme.colors.surface.pressedOverlay,
                    }}
                >
                    {/*
                      * Bounded, not clipped. At 200% text — or on a short
                      * landscape phone — the card grows past the viewport, and a
                      * centered fixed box would push Cancel and the package
                      * export off screen with no way to reach them.
                      */}
                    {embeddedCard ? overlay : props.overlayPresentation === 'screen' ? (
                        <View
                            testID="new-session-full-screen-overlay"
                            style={{
                                flex: 1,
                                minHeight: 0,
                                paddingTop: insets.top,
                                paddingBottom: insets.bottom,
                                paddingLeft: insets.left,
                                paddingRight: insets.right,
                            }}
                        >
                            {overlay}
                        </View>
                    ) : <ScrollView
                        testID="new-session-launch-overlay-scroll"
                        style={{ flex: 1 }}
                        contentContainerStyle={{
                            flexGrow: 1,
                            justifyContent: 'center',
                            alignItems: 'center',
                            paddingTop: OVERLAY_EDGE_PADDING + insets.top,
                            paddingBottom: OVERLAY_EDGE_PADDING + insets.bottom,
                            paddingLeft: OVERLAY_EDGE_PADDING + insets.left,
                            paddingRight: OVERLAY_EDGE_PADDING + insets.right,
                        }}
                        keyboardShouldPersistTaps="handled"
                    >
                        <View style={{ width: '100%', maxWidth: OVERLAY_MAX_CONTENT_WIDTH }}>
                            {overlay}
                        </View>
                    </ScrollView>}
                </ModalPaneBoundaryView>
            ) : null}
        </View>
    );
}
