import * as React from 'react';
import { Platform, Pressable, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { ActionOperationSnapshotV1 } from '@happier-dev/protocol';

import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { TabBadge } from '@/components/ui/navigation/tabBadge/TabBadge';
import { FloatingOverlay } from '@/components/ui/overlays/FloatingOverlay';
import { Popover } from '@/components/ui/popover';
import { Text } from '@/components/ui/text/Text';
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

export const ActionOperationActivityButtonView = React.memo(function ActionOperationActivityButtonView(
    props: ActionOperationActivityButtonViewProps,
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
    const activeCount = props.activeCount ?? props.operations.reduce(
        (count, operation) => count + (
            (operation.state === 'accepted' || operation.state === 'running')
            && props.observationForOperation(operation) !== 'status_unavailable'
                ? 1
                : 0
        ),
        0,
    );

    React.useEffect(() => {
        if (open) props.onMarkVisibleTerminalSeen();
    }, [open, props.onMarkVisibleTerminalSeen, props.operations]);

    const handleOpenOperation = React.useCallback((operationId: string) => {
        setOpen(false);
        props.onOpenOperation(operationId);
    }, [props.onOpenOperation]);
    const handleCancelOperation = React.useCallback(async (operationId: string) => {
        const operation = props.operations.find((candidate) => candidate.operationId === operationId);
        if (!operation) return;
        await requestActionOperationStop(operation);
    }, [props.operations]);
    const handleClearRecent = React.useCallback(() => {
        props.onClearRecent?.();
        setOpen(false);
    }, [props.onClearRecent]);

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
                    {activeCount > 0 ? (
                        <TabBadge testID="action-operation-activity-count" variant="count" value={activeCount} tone="neutral" />
                    ) : (
                        <TabBadge testID="action-operation-activity-attention-dot" variant="dot" />
                    )}
                </View>
            </Pressable>
            {open ? (
                <Popover
                    open={true}
                    anchorRef={anchorRef}
                    anchor={webAnchorRect ? {
                        kind: 'rect',
                        rect: webAnchorRect,
                        coordinateSpace: 'window',
                    } : undefined}
                    boundaryRef={null}
                    placement="bottom"
                    edgePadding={{ horizontal: 12, vertical: 12 }}
                    portal={{ web: { target: 'body' }, native: true, matchAnchorWidth: false, anchorAlign: 'end' }}
                    maxWidthCap={420}
                    maxHeightCap={560}
                    onRequestClose={() => setOpen(false)}
                >
                    {({ maxHeight, maxWidth }) => (
                        <FloatingOverlay
                            maxHeight={Math.min(maxHeight, 560)}
                            edgeFades={{ top: true, bottom: true, size: 18 }}
                            edgeIndicators={true}
                            surfaceChrome="theme"
                            containerStyle={{ width: Math.min(maxWidth, 400) }}
                        >
                            <View style={styles.popoverHeader}>
                                <Text style={styles.popoverTitle}>{t('inbox.updates')}</Text>
                            </View>
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
            ) : null}
        </View>
    );
});

export const ActionOperationActivityButton = React.memo(function ActionOperationActivityButton(props: Readonly<{
    preferredSessionId?: string | null;
    tintColor?: string;
    buttonSize?: number;
    iconSize?: number;
    testID?: string;
}>) {
    const { markVisibleTerminalSeen, clearRecent, canDismissOperation, dismissOperation, ...model } = useActionOperationActivityModel();
    return (
        <ActionOperationActivityButtonView
            {...model}
            preferredSessionId={props.preferredSessionId}
            tintColor={props.tintColor}
            buttonSize={props.buttonSize}
            iconSize={props.iconSize}
            testID={props.testID}
            onOpenOperation={openActionOperationDetail}
            onMarkVisibleTerminalSeen={markVisibleTerminalSeen}
            onClearRecent={clearRecent}
            canDismissOperation={canDismissOperation}
            onDismissOperation={dismissOperation}
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
    popoverHeader: {
        minHeight: 44,
        justifyContent: 'center',
        paddingHorizontal: 16,
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: theme.colors.border.default,
    },
    popoverTitle: {
        color: theme.colors.text.primary,
    },
    popoverBottomInset: {
        height: 14,
    },
}));
