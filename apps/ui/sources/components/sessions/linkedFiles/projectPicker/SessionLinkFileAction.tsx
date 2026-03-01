import * as React from 'react';
import { Platform, Pressable, View, useWindowDimensions } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { t } from '@/text';
import { Text } from '@/components/ui/text/Text';
import { Popover } from '@/components/ui/popover';
import { AgentInputPopoverSurface } from '@/components/sessions/agentInput/components/AgentInputPopoverSurface';
import { SessionRepositoryTreeBrowserView } from '@/components/sessions/files/views/SessionRepositoryTreeBrowserView';
import { Modal } from '@/modal';
import { layout } from '@/components/ui/layout/layout';
import { ProjectFileLinkPickerModal } from './ProjectFileLinkPickerModal';

export type SessionLinkFileActionProps = Readonly<{
    sessionId: string;
    disabled?: boolean;
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
    const [open, setOpen] = React.useState(false);
    const anchorRef = React.useRef<View | null>(null);
    const popoverAnchorRef = props.popoverAnchorRef ?? anchorRef;
    const { width: windowWidth } = useWindowDimensions();
    // When the agent input provides a full-width anchor (the composer container),
    // match it so the popover behaves like the @ suggestions surface. Otherwise,
    // fall back to content sizing so a narrow chip anchor doesn't force a tiny popover.
    const shouldMatchAnchorWidthOnPortal = Boolean(props.popoverAnchorRef);
    const maxWidthCap = React.useMemo(() => {
        if (!shouldMatchAnchorWidthOnPortal) return layout.maxWidth;
        return Number.isFinite(windowWidth) && windowWidth > 0 ? windowWidth : layout.maxWidth;
    }, [shouldMatchAnchorWidthOnPortal, windowWidth]);
    const recentlyClosedRef = React.useRef(false);

    const handleOpen = React.useCallback(() => {
        if (props.disabled) return;
        // Keep native/phone behavior as a modal until the popover UX is tuned for small screens.
        if (Platform.OS !== 'web') {
            Modal.show({
                component: ProjectFileLinkPickerModal,
                props: {
                    sessionId: props.sessionId,
                    onPickPath: props.onPickPath,
                },
                closeOnBackdrop: true,
            });
            return;
        }
        if (!open && recentlyClosedRef.current) {
            // On web, Popover can close itself via pointerdown-capture handlers (outside click) before this chip's
            // press handler runs. Avoid re-opening immediately when this onPress fires after a close in the same tick.
            return;
        }
        // On web, Popover can close itself via document-level pointerdown capture handlers. If the
        // chip's press handler runs after that close, a functional toggle update can re-open the
        // popover immediately. Use explicit open-state transitions to guarantee toggle behavior.
        if (open) {
            setOpen(false);
        } else {
            setOpen(true);
        }
    }, [open, props.disabled, props.onPickPath, props.sessionId]);

    const handleClose = React.useCallback(() => {
        setOpen(false);
        recentlyClosedRef.current = true;
        setTimeout(() => {
            recentlyClosedRef.current = false;
        }, 0);
    }, []);

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
                        <Ionicons name="link-outline" size={16} color={props.iconColor} />
                        {props.showLabel ? (
                            <Text style={props.textStyle}>{t('common.linkFile')}</Text>
                        ) : null}
                    </View>
                </Pressable>
            </View>

            {Platform.OS === 'web' ? (
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
                    closeOnAnchorPress={true}
                    portal={{
                        // Portal to `body` so the popover isn't constrained by any modal/root container width.
                        // This matches the @ suggestions behavior (full composer width) while still escaping
                        // overflow/stacking contexts in the session view.
                        web: { target: 'body' },
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
            ) : null}
        </>
    );
});
