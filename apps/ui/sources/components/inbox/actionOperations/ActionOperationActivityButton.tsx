import * as React from 'react';
import { Platform, Pressable, View } from 'react-native';
import Animated from 'react-native-reanimated';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { usePressFeedback } from '@/components/ui/interactions/usePressFeedback';
import { TabBadge } from '@/components/ui/navigation/tabBadge/TabBadge';
import { FloatingOverlay } from '@/components/ui/overlays/FloatingOverlay';
import { Popover } from '@/components/ui/popover';
import { t } from '@/text';
import type { ActionOperationProjection } from '@/sync/domains/actionOperations/actionOperationSelectors';
import { actionOperationStore } from '@/sync/domains/actionOperations/actionOperationStore';
import { actionOperationAddress } from '@/sync/domains/actionOperations/qualifiedActionOperation';
import type { SessionAddress } from '@/sync/domains/session/sessionAddress';
import {
    useActionOperationActivitySummary,
    useAllActionOperations,
} from '@/sync/domains/actionOperations/useActionOperations';

import { ActionOperationLedgerView } from './ActionOperationLedger';
import { openActionOperation } from './actionOperationPresentationRuntime';
import { requestAcceptedActionOperationStop, type ActionOperationStopResponse, type ActionOperationStopContext } from './requestActionOperationStop';

export type ActionOperationActivityButtonViewProps = Readonly<{
    operations: readonly ActionOperationProjection[];
    hasAttention: boolean;
    preferredSessionAddress?: SessionAddress | null;
    onOpenOperation: (operation: ActionOperationProjection) => void;
    onCancelOperation?: (operation: ActionOperationProjection, context?: ActionOperationStopContext) => Promise<ActionOperationStopResponse | void> | void;
    onDismissOperation?: (operation: ActionOperationProjection) => void;
    onMarkVisibleTerminalSeen: () => void;
    onClearRecent?: () => void;
    tintColor?: string;
    buttonSize?: number;
    iconSize?: number;
    testID?: string;
}>;

type ActionOperationActivityPopoverPlacement = Readonly<{
    anchorRef: React.RefObject<View | null>;
    anchor: Readonly<{
        kind: 'rect';
        rect: Readonly<{ left: number; top: number; width: number; height: number }>;
        coordinateSpace: 'window';
    }> | undefined;
    onRequestClose: () => void;
}>;

type ActionOperationActivityButtonChromeProps = Readonly<{
    activeCount: number;
    hasAttention: boolean;
    renderDetails: (placement: ActionOperationActivityPopoverPlacement) => React.ReactNode;
    tintColor?: string;
    buttonSize?: number;
    iconSize?: number;
    testID?: string;
}>;

const ActionOperationActivityButtonChrome = React.memo(function ActionOperationActivityButtonChrome(
    props: ActionOperationActivityButtonChromeProps,
) {
    const { theme } = useUnistyles();
    const anchorRef = React.useRef<View>(null);
    const [open, setOpen] = React.useState(false);
    const [webAnchorRect, setWebAnchorRect] = React.useState<Readonly<{
        left: number;
        top: number;
        width: number;
        height: number;
    }> | null>(null);
    const visible = props.hasAttention || open;
    const handleRequestClose = React.useCallback(() => setOpen(false), []);
    // Icon-sized mark: the glyph mode pairs the scale with the opacity dip.
    const feedback = usePressFeedback({ glyph: true });

    if (!visible) return null;

    const tintColor = props.tintColor ?? theme.colors.chrome.header.foreground;
    return (
        <View ref={anchorRef} collapsable={false} style={styles.anchor}>
            <Pressable
                testID={props.testID ?? 'action-operation-activity-button'}
                accessibilityRole="button"
                accessibilityLabel={t('inbox.updates')}
                accessibilityState={{ expanded: open }}
                hitSlop={8}
                onPress={(event) => {
                    if (!open && Platform.OS === 'web') {
                        const target = event?.currentTarget as unknown as {
                            getBoundingClientRect?: () => Readonly<{
                                left: number;
                                top: number;
                                width: number;
                                height: number;
                            }>;
                        };
                        const rect = target?.getBoundingClientRect?.();
                        if (rect) {
                            setWebAnchorRect({
                                left: rect.left,
                                top: rect.top,
                                width: rect.width,
                                height: rect.height,
                            });
                        }
                    }
                    setOpen((current) => !current);
                }}
                onPressIn={feedback.onPressIn}
                onPressOut={feedback.onPressOut}
                style={[
                    styles.button,
                    props.buttonSize != null ? {
                        width: props.buttonSize,
                        height: props.buttonSize,
                        borderRadius: props.buttonSize / 2,
                    } : null,
                ]}
            >
                <Animated.View style={[styles.glyph, feedback.animatedStyle]}>
                    <Icon name="pulse" size={props.iconSize ?? ICON_SIZE.md} color={tintColor} />
                    {props.activeCount > 0 ? (
                        <TabBadge testID="action-operation-activity-count" variant="count" value={props.activeCount} tone="neutral" />
                    ) : (
                        <TabBadge testID="action-operation-activity-attention-dot" variant="dot" />
                    )}
                </Animated.View>
            </Pressable>
            {open ? props.renderDetails({
                anchorRef,
                anchor: webAnchorRect ? {
                    kind: 'rect',
                    rect: webAnchorRect,
                    coordinateSpace: 'window',
                } : undefined,
                onRequestClose: handleRequestClose,
            }) : null}
        </View>
    );
});

type ActionOperationActivityDetailsViewProps = Pick<
    ActionOperationActivityButtonViewProps,
    | 'operations'
    | 'preferredSessionAddress'
    | 'onOpenOperation'
    | 'onCancelOperation'
    | 'onDismissOperation'
    | 'onMarkVisibleTerminalSeen'
    | 'onClearRecent'
> & ActionOperationActivityPopoverPlacement;

const ActionOperationActivityDetailsView = React.memo(function ActionOperationActivityDetailsView(
    props: ActionOperationActivityDetailsViewProps,
) {
    React.useEffect(() => {
        props.onMarkVisibleTerminalSeen();
    }, [props.onMarkVisibleTerminalSeen, props.operations]);
    const handleOpenOperation = React.useCallback((operation: ActionOperationProjection) => {
        props.onRequestClose();
        props.onOpenOperation(operation);
    }, [props.onOpenOperation, props.onRequestClose]);
    const handleClearRecent = React.useCallback(() => {
        props.onClearRecent?.();
        props.onRequestClose();
    }, [props.onClearRecent, props.onRequestClose]);

    return (
        <Popover
            open={true}
            anchorRef={props.anchorRef}
            anchor={props.anchor}
            boundaryRef={null}
            placement="bottom"
            edgePadding={{ horizontal: 12, vertical: 12 }}
            portal={{ web: { target: 'body' }, native: true, matchAnchorWidth: false, anchorAlign: 'end' }}
            maxWidthCap={420}
            maxHeightCap={560}
            onRequestClose={props.onRequestClose}
        >
            {({ maxHeight, maxWidth }) => (
                <FloatingOverlay
                    maxHeight={Math.min(maxHeight, 560)}
                    edgeFades={{ top: true, bottom: true, size: 18 }}
                    edgeIndicators={true}
                    surfaceChrome="theme"
                    containerStyle={{ width: Math.min(maxWidth, 400) }}
                >
                    <ActionOperationLedgerView
                        operations={props.operations}
                        preferredSessionAddress={props.preferredSessionAddress}
                        onOpenOperation={handleOpenOperation}
                        onCancelOperation={props.onCancelOperation}
                        onDismissOperation={props.onDismissOperation}
                        onClearRecent={props.onClearRecent ? handleClearRecent : undefined}
                    />
                    <View style={styles.popoverBottomInset} />
                </FloatingOverlay>
            )}
        </Popover>
    );
});

export const ActionOperationActivityButtonView = React.memo(function ActionOperationActivityButtonView(
    props: ActionOperationActivityButtonViewProps,
) {
    const activeCount = props.operations.reduce(
        (count, operation) => count + (
            (operation.snapshot.state === 'accepted' || operation.snapshot.state === 'running')
            && operation.observation === 'available'
                ? 1
                : 0
        ),
        0,
    );
    const renderDetails = React.useCallback((placement: ActionOperationActivityPopoverPlacement) => (
        <ActionOperationActivityDetailsView {...placement} {...props} />
    ), [props]);
    return (
        <ActionOperationActivityButtonChrome
            activeCount={activeCount}
            hasAttention={props.hasAttention}
            renderDetails={renderDetails}
            tintColor={props.tintColor}
            buttonSize={props.buttonSize}
            iconSize={props.iconSize}
            testID={props.testID}
        />
    );
});

const ActionOperationActivityDetails = React.memo(function ActionOperationActivityDetails(
    props: ActionOperationActivityPopoverPlacement & Readonly<{ preferredSessionAddress?: SessionAddress | null }>,
) {
    const operations = useAllActionOperations();
    const markVisibleTerminalSeen = React.useCallback(() => {
        actionOperationStore.markAllTerminalSeen();
    }, []);
    const stopOperation = React.useCallback(async (operation: ActionOperationProjection, context?: ActionOperationStopContext) => {
        return await requestAcceptedActionOperationStop(operation, context);
    }, []);
    return (
        <ActionOperationActivityDetailsView
            {...props}
            operations={operations}
            preferredSessionAddress={props.preferredSessionAddress}
            onOpenOperation={openActionOperation}
            onCancelOperation={stopOperation}
            onDismissOperation={(operation) => actionOperationStore.dismissUnavailable(
                actionOperationAddress(operation.serverId, operation.snapshot.operationId),
            )}
            onMarkVisibleTerminalSeen={markVisibleTerminalSeen}
            onClearRecent={actionOperationStore.dismissRecentSucceeded}
        />
    );
});

export const ActionOperationActivityButton = React.memo(function ActionOperationActivityButton(props: Readonly<{
    preferredSessionAddress?: SessionAddress | null;
    tintColor?: string;
    buttonSize?: number;
    iconSize?: number;
    testID?: string;
}>) {
    const summary = useActionOperationActivitySummary();
    const renderDetails = React.useCallback((placement: ActionOperationActivityPopoverPlacement) => (
        <ActionOperationActivityDetails
            {...placement}
            preferredSessionAddress={props.preferredSessionAddress}
        />
    ), [props.preferredSessionAddress]);
    return (
        <ActionOperationActivityButtonChrome
            {...summary}
            renderDetails={renderDetails}
            tintColor={props.tintColor}
            buttonSize={props.buttonSize}
            iconSize={props.iconSize}
            testID={props.testID}
        />
    );
});

const styles = StyleSheet.create((theme) => ({
    anchor: {
        alignItems: 'center',
        justifyContent: 'center',
    },
    button: {
        width: 44,
        height: 44,
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: 22,
    },
    glyph: {
        position: 'relative',
        alignItems: 'center',
        justifyContent: 'center',
    },
    popoverBottomInset: {
        height: 14,
    },
}));
