import * as React from 'react';
import { Pressable, View, useWindowDimensions } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { t } from '@/text';
import { Text } from '@/components/ui/text/Text';
import { Popover } from '@/components/ui/popover';
import { AgentInputPopoverSurface } from '@/components/sessions/agentInput/components/AgentInputPopoverSurface';
import { SessionRepositoryTreeBrowserView } from '@/components/sessions/files/views/SessionRepositoryTreeBrowserView';
import { layout } from '@/components/ui/layout/layout';

export type SessionLinkFileActionProps = Readonly<{
    sessionId: string;
    disabled?: boolean;
    open?: boolean;
    onOpenChange?: (next: boolean) => void;
    showLabel: boolean;
    chipStyle: (pressed: boolean) => any;
    iconColor: string;
    textStyle: any;
    /**
     * Optional anchor ref that spans the full agent-input width. When provided on web,
     * the popover will size/align like the @ suggestions popover (full input width),
     * rather than the chip width.
     */
    popoverAnchorRef?: React.RefObject<any>;
    onPickPath: (path: string) => void;
}>;

export const SessionLinkFileAction = React.memo((props: SessionLinkFileActionProps) => {
    const [uncontrolledOpen, setUncontrolledOpen] = React.useState(false);
    const anchorRef = React.useRef<View | null>(null);
    const popoverAnchorRef = props.popoverAnchorRef ?? anchorRef;
    const isControlled = typeof props.open === 'boolean';
    const open = isControlled ? props.open === true : uncontrolledOpen;
    const { width: windowWidth } = useWindowDimensions();
    // When the agent input provides a full-width anchor (the composer container),
    // match it so the popover behaves like the @ suggestions surface. Otherwise,
    // fall back to content sizing so a narrow chip anchor doesn't force a tiny popover.
    const shouldMatchAnchorWidthOnPortal = Boolean(props.popoverAnchorRef);
    const maxWidthCap = React.useMemo(() => {
        if (!shouldMatchAnchorWidthOnPortal) return layout.maxWidth;
        return Number.isFinite(windowWidth) && windowWidth > 0 ? windowWidth : layout.maxWidth;
    }, [shouldMatchAnchorWidthOnPortal, windowWidth]);

    const handleOpen = React.useCallback(() => {
        if (props.disabled) return;
        const next = !open;
        props.onOpenChange?.(next);
        if (!isControlled) {
            setUncontrolledOpen(next);
        }
    }, [isControlled, open, props.disabled, props.onOpenChange]);

    const handleClose = React.useCallback(() => {
        props.onOpenChange?.(false);
        if (!isControlled) {
            setUncontrolledOpen(false);
        }
    }, [isControlled, props.onOpenChange]);

    return (
        <>
            <View ref={anchorRef as any} collapsable={false} style={{ alignSelf: 'flex-start' }}>
                <Pressable
                    testID="agent-input-link-file"
                    onPress={handleOpen}
                    disabled={props.disabled}
                    style={({ pressed }) => props.chipStyle(Boolean(pressed))}
                    accessibilityRole="button"
                    accessibilityLabel={t('common.linkFile')}
                >
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                        <Ionicons name="document-outline" size={18} color={props.iconColor} />
                        {props.showLabel ? (
                            <Text style={props.textStyle}>{t('common.linkFile')}</Text>
                        ) : null}
                    </View>
                </Pressable>
            </View>

            <Popover
                open={open}
                anchorRef={popoverAnchorRef as any}
                boundaryRef={null}
                placement="top"
                gap={8}
                maxHeightCap={520}
                // Match the @ suggestions popover sizing: cap to the composer max width (while
                // still being bounded by the viewport). In portal mode we disable anchor-width
                // matching so the popover can be full-width even when the trigger chip is narrow.
                maxWidthCap={maxWidthCap}
                // IMPORTANT: keep this off for a true toggle UX.
                // Popover's web outside-click handler runs on `pointerdown` capture. If we also close on
                // anchor press there, the chip's `onPress` (fires on pointerup) can re-open immediately.
                closeOnAnchorPress={false}
                portal={{
                    // Portal to `body` so the popover isn't constrained by any modal/root container width.
                    // This matches the @ suggestions behavior (full composer width) while still escaping
                    // overflow/stacking contexts in the session view.
                    web: { target: 'body' },
                    native: true,
                    matchAnchorWidth: shouldMatchAnchorWidthOnPortal,
                }}
                onRequestClose={handleClose}
                backdrop={{ style: { backgroundColor: 'transparent' } }}
                containerStyle={{ paddingHorizontal: 0 }}
            >
                {({ maxHeight }) => (
                    <AgentInputPopoverSurface testID="agent-input-link-file-popover" maxHeight={maxHeight} scrollEnabled={false}>
                        <SessionRepositoryTreeBrowserView
                            sessionId={props.sessionId}
                            density="panel"
                            onRequestClose={handleClose}
                            onOpenFile={(fullPath) => {
                                props.onPickPath(fullPath);
                                handleClose();
                            }}
                            onOpenFilePinned={(fullPath) => {
                                props.onPickPath(fullPath);
                                handleClose();
                            }}
                        />
                    </AgentInputPopoverSurface>
                )}
            </Popover>
        </>
    );
});
