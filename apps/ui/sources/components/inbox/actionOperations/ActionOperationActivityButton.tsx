import * as React from 'react';
import { Platform, Pressable, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { TabBadge } from '@/components/ui/navigation/tabBadge/TabBadge';
import { FloatingOverlay } from '@/components/ui/overlays/FloatingOverlay';
import { Popover } from '@/components/ui/popover';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';
import type { ActionOperationProjection } from '@/sync/domains/actionOperations/actionOperationSelectors';
import { actionOperationStore } from '@/sync/domains/actionOperations/actionOperationStore';
import {
    useActionOperationsHaveAttention,
    useAllActionOperations,
} from '@/sync/domains/actionOperations/useActionOperations';

import { ActionOperationLedgerView } from './ActionOperationLedger';
import { openActionOperation } from './actionOperationPresentationRuntime';
import { requestAcceptedActionOperationStop } from './requestActionOperationStop';

export type ActionOperationActivityButtonViewProps = Readonly<{
    operations: readonly ActionOperationProjection[];
    hasAttention: boolean;
    preferredSessionId?: string | null;
    onOpenOperation: (operationId: string) => void;
    onCancelOperation?: (operationId: string) => Promise<void> | void;
    onDismissOperation?: (operationId: string) => void;
    onMarkVisibleTerminalSeen: () => void;
    onClearRecent?: () => void;
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
    const activeCount = props.operations.reduce(
        (count, operation) => count + (
            (operation.snapshot.state === 'accepted' || operation.snapshot.state === 'running')
            && operation.observation === 'available'
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
                            <ActionOperationLedgerView
                                operations={props.operations}
                                preferredSessionId={props.preferredSessionId}
                                onOpenOperation={handleOpenOperation}
                                onCancelOperation={props.onCancelOperation}
                                onDismissOperation={props.onDismissOperation}
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
    const operations = useAllActionOperations();
    const hasAttention = useActionOperationsHaveAttention();
    const markVisibleTerminalSeen = React.useCallback(() => {
        actionOperationStore.markAllTerminalSeen();
    }, []);
    const stopOperation = React.useCallback(async (operationId: string) => {
        const operation = operations.find((candidate) => candidate.snapshot.operationId === operationId);
        if (operation) await requestAcceptedActionOperationStop(operation.snapshot);
    }, [operations]);
    return (
        <ActionOperationActivityButtonView
            operations={operations}
            hasAttention={hasAttention}
            preferredSessionId={props.preferredSessionId}
            tintColor={props.tintColor}
            buttonSize={props.buttonSize}
            iconSize={props.iconSize}
            testID={props.testID}
            onOpenOperation={(operationId) => {
                const operation = operations.find((candidate) => candidate.snapshot.operationId === operationId);
                if (operation) openActionOperation(operation.snapshot);
            }}
            onCancelOperation={stopOperation}
            onDismissOperation={actionOperationStore.dismissUnavailable}
            onMarkVisibleTerminalSeen={markVisibleTerminalSeen}
            onClearRecent={actionOperationStore.dismissRecentSucceeded}
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
