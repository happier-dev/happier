import * as React from 'react';
import { Platform, Pressable, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { ActionOperationSnapshotV1 } from '@happier-dev/protocol';

import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { TabBadge } from '@/components/ui/navigation/tabBadge/TabBadge';
import { FloatingOverlay } from '@/components/ui/overlays/FloatingOverlay';
import { Popover } from '@/components/ui/popover';
import { useActionOperationActivitySummary } from '@/sync/domains/actionOperations/useActionOperations';
import { actionOperationStore } from '@/sync/domains/actionOperations/actionOperationStore';
import { useActiveServerAccountScope } from '@/sync/domains/state/storage';
import { t } from '@/text';

import { ActionOperationLedger } from './ActionOperationLedger';
import type { ActionOperationObservationPresentation } from './actionOperationPresentation';
import { openActionOperationDetail } from './openActionOperationDetail';
import { useActionOperationActivityModel } from './useActionOperationActivityModel';
import { requestActionOperationStop } from './requestActionOperationStop';

export type ActionOperationActivityButtonViewProps = Readonly<{
    operations: readonly ActionOperationSnapshotV1[];
    activeCount?: number;
    hasAttention: boolean;
    preferredSessionId?: string | null;
    observationForOperation: (operation: ActionOperationSnapshotV1) => ActionOperationObservationPresentation;
    contextForOperation: (operation: ActionOperationSnapshotV1) => string | null;
    onOpenOperation: (operationId: string) => void;
    onMarkVisibleTerminalSeen: () => void;
    onClearRecent?: () => void;
    canDismissOperation?: (operation: ActionOperationSnapshotV1) => boolean;
    onDismissOperation?: (operationId: string) => void;
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
    onOpen: () => void;
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

    if (!visible) return null;

    const tintColor = props.tintColor ?? theme.colors.chrome.header.foreground;
    return (
        <View ref={anchorRef} collapsable={false} style={styles.anchor}>
            <Pressable
                testID={props.testID ?? 'action-operation-activity-button'}
                accessibilityRole="button"
                accessibilityLabel={t('inbox.updates')}
                accessibilityState={{ expanded: open }}
                onPress={(event) => {
                    if (!open) props.onOpen();
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
                style={({ pressed }) => [
                    styles.button,
                    props.buttonSize != null ? {
                        width: props.buttonSize,
                        height: props.buttonSize,
                        borderRadius: props.buttonSize / 2,
                    } : null,
                    pressed ? styles.buttonPressed : null,
                ]}
            >
                <View style={styles.glyph}>
                    <Icon name="pulse" size={props.iconSize ?? ICON_SIZE.md} color={tintColor} />
                    {props.activeCount > 0 ? (
                        <TabBadge testID="action-operation-activity-count" variant="count" value={props.activeCount} tone="neutral" />
                    ) : (
                        <TabBadge testID="action-operation-activity-attention-dot" variant="dot" />
                    )}
                </View>
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
    | 'preferredSessionId'
    | 'observationForOperation'
    | 'contextForOperation'
    | 'onOpenOperation'
    | 'onClearRecent'
    | 'canDismissOperation'
    | 'onDismissOperation'
> & ActionOperationActivityPopoverPlacement;

const ActionOperationActivityDetailsView = React.memo(function ActionOperationActivityDetailsView(
    props: ActionOperationActivityDetailsViewProps,
) {
    const handleOpenOperation = React.useCallback((operationId: string) => {
        props.onRequestClose();
        props.onOpenOperation(operationId);
    }, [props.onOpenOperation, props.onRequestClose]);
    const handleCancelOperation = React.useCallback(async (operationId: string) => {
        const operation = props.operations.find((candidate) => candidate.operationId === operationId);
        if (!operation) return;
        await requestActionOperationStop(operation);
    }, [props.operations]);
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
                    <ActionOperationLedger
                        operations={props.operations}
                        observationForOperation={props.observationForOperation}
                        contextForOperation={props.contextForOperation}
                        onOpenOperation={handleOpenOperation}
                        onCancelOperation={handleCancelOperation}
                        canDismissOperation={props.canDismissOperation}
                        onDismissOperation={props.onDismissOperation}
                        preferredSessionId={props.preferredSessionId}
                        showEmptyState={false}
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
    const activeCount = props.activeCount ?? props.operations.reduce(
        (count, operation) => count + (
            (operation.state === 'accepted' || operation.state === 'running')
            && props.observationForOperation(operation) !== 'status_unavailable'
                ? 1
                : 0
        ),
        0,
    );
    const renderDetails = React.useCallback((placement: ActionOperationActivityPopoverPlacement) => (
        <ActionOperationActivityDetailsView
            {...placement}
            operations={props.operations}
            preferredSessionId={props.preferredSessionId}
            observationForOperation={props.observationForOperation}
            contextForOperation={props.contextForOperation}
            onOpenOperation={props.onOpenOperation}
            onClearRecent={props.onClearRecent}
            canDismissOperation={props.canDismissOperation}
            onDismissOperation={props.onDismissOperation}
        />
    ), [
        props.canDismissOperation,
        props.contextForOperation,
        props.observationForOperation,
        props.onClearRecent,
        props.onDismissOperation,
        props.onOpenOperation,
        props.operations,
        props.preferredSessionId,
    ]);
    return (
        <ActionOperationActivityButtonChrome
            activeCount={activeCount}
            hasAttention={props.hasAttention}
            onOpen={props.onMarkVisibleTerminalSeen}
            renderDetails={renderDetails}
            tintColor={props.tintColor}
            buttonSize={props.buttonSize}
            iconSize={props.iconSize}
            testID={props.testID}
        />
    );
});

const ActionOperationActivityDetails = React.memo(function ActionOperationActivityDetails(
    props: ActionOperationActivityPopoverPlacement & Readonly<{ preferredSessionId?: string | null }>,
) {
    const model = useActionOperationActivityModel();
    return (
        <ActionOperationActivityDetailsView
            {...props}
            operations={model.operations}
            preferredSessionId={props.preferredSessionId}
            observationForOperation={model.observationForOperation}
            contextForOperation={model.contextForOperation}
            onOpenOperation={openActionOperationDetail}
            onClearRecent={model.clearRecent}
            canDismissOperation={model.canDismissOperation}
            onDismissOperation={model.dismissOperation}
        />
    );
});

export const ActionOperationActivityButton = React.memo(function ActionOperationActivityButton(props: Readonly<{
    preferredSessionId?: string | null;
    tintColor?: string;
    buttonSize?: number;
    iconSize?: number;
    testID?: string;
}>) {
    const accountId = useActiveServerAccountScope()?.accountId ?? '';
    const summary = useActionOperationActivitySummary(accountId);
    const handleOpen = React.useCallback(() => {
        actionOperationStore.markAccountTerminalSeen(accountId);
    }, [accountId]);
    const renderDetails = React.useCallback((placement: ActionOperationActivityPopoverPlacement) => (
        <ActionOperationActivityDetails {...placement} preferredSessionId={props.preferredSessionId} />
    ), [props.preferredSessionId]);
    return (
        <ActionOperationActivityButtonChrome
            {...summary}
            onOpen={handleOpen}
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
    buttonPressed: {
        opacity: 0.68,
        transform: [{ scale: 0.96 }],
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
