import * as React from 'react';
import { Platform, Pressable, useWindowDimensions, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Icon } from '@/components/ui/icons/Icon';
import { resolveTouchTargetFloorPx } from '@/components/ui/interactiveTargetSize';
import { MODAL_AWARE_FLOATING_POPOVER_PORTAL_OPTIONS, Popover } from '@/components/ui/popover';
import { FloatingOverlay } from '@/components/ui/overlays/FloatingOverlay';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { pageTitleTypography } from '@/components/ui/layout/pageTitleTypography';
import { useIsTablet } from '@/utils/platform/responsive';
import { shouldUseReadablePhoneMinimalSessionRow } from '../resolveSessionListDensityViewState';
import { Modal } from '@/modal';
import type { CustomModalInjectedProps } from '@/modal/types';

import { SESSION_LIST_COLUMN_METRICS } from '../sessionListStyles';
import {
    SessionListFilterEditor,
    type SessionListFilterEditorProps,
} from './SessionListFilterEditor';

type EditorProps = Omit<SessionListFilterEditorProps, 'onDone' | 'maxHeight'>;

export type SessionListFilterEditorControlProps = Readonly<{
    label: string;
    active: boolean;
    editor: EditorProps;
}>;

/**
 * The title fills the column's title row (lab S1); where the primary pointer is a finger it takes the
 * platform's touch floor instead.
 */
const MINIMUM_TRIGGER_TARGET_SIZE = resolveTouchTargetFloorPx() ?? SESSION_LIST_COLUMN_METRICS.titleRowHeightPx;
/**
 * The scope popover's width: the approved panel (design lab C2) — two scope columns side by side in a
 * compact surface that never takes the sidebar's full width; longer tile labels wrap in their tiles.
 */
const SCOPE_POPOVER_WIDTH_PX = 312;
/** Tall enough for every facet on a laptop screen; beyond it the panel scrolls inside. */
const SCOPE_POPOVER_MAX_HEIGHT_PX = 520;
/** Keeps the popover off the window's edges when it is clamped there (phones). */
const SCOPE_POPOVER_EDGE_PADDING = { horizontal: 8, vertical: 8 } as const;

const stylesheet = StyleSheet.create((theme) => ({
    // The list's title is its scope: "My work ⌄" opens the scope menu. It reads as a title (primary
    // text, semibold), not as a filter pill; the funnel appears only when the view is narrowed beyond
    // the default, so the list never looks inexplicably short.
    trigger: {
        minHeight: MINIMUM_TRIGGER_TARGET_SIZE,
        minWidth: MINIMUM_TRIGGER_TARGET_SIZE,
        flexShrink: 1,
        paddingHorizontal: 6,
        // Optical alignment: the label, not the press fill, sits on the group labels' edge.
        marginLeft: -6,
        borderRadius: 8,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'flex-start',
        gap: 6,
    },
    triggerPressed: {
        backgroundColor: theme.colors.surface.pressed,
    },
    triggerLabel: {
        ...Typography.default('semiBold'),
        minWidth: 0,
        flexShrink: 1,
        fontSize: 15,
        lineHeight: 20,
        color: theme.colors.text.primary,
    },
    phoneTriggerLabel: {
        ...pageTitleTypography(),
    },
    modalBody: {
        minHeight: 320,
        alignItems: 'stretch',
    },
}));

function SessionListFilterEditorModal(
    props: EditorProps & CustomModalInjectedProps,
) {
    const styles = stylesheet;
    return (
        <View style={styles.modalBody}>
            <SessionListFilterEditor
                {...props}
                onDone={props.onClose}
                maxHeight={520}
            />
        </View>
    );
}

export const SessionListFilterEditorControl = React.memo(function SessionListFilterEditorControl(
    props: SessionListFilterEditorControlProps,
) {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const isTablet = useIsTablet();
    const { width: windowWidth } = useWindowDimensions();
    const phone = shouldUseReadablePhoneMinimalSessionRow({ isTablet, platform: Platform.OS, windowWidth });
    const usePopoverHost = Platform.OS === 'web' || isTablet;
    const [popoverOpen, setPopoverOpen] = React.useState(false);
    const anchorRef = React.useRef<View>(null);
    const modalIdRef = React.useRef<string | null>(null);

    const openArchivedFromEditor = props.editor.onOpenArchived;
    // Leaving for the archived list closes the menu first, whichever host it is in.
    const handleOpenArchived = React.useMemo(() => (openArchivedFromEditor ? () => {
        setPopoverOpen(false);
        const modalId = modalIdRef.current;
        if (modalId) {
            modalIdRef.current = null;
            Modal.hide(modalId);
        }
        openArchivedFromEditor();
    } : undefined), [openArchivedFromEditor]);
    const editorProps = React.useMemo<EditorProps>(() => (
        handleOpenArchived ? { ...props.editor, onOpenArchived: handleOpenArchived } : props.editor
    ), [handleOpenArchived, props.editor]);

    React.useEffect(() => {
        const modalId = modalIdRef.current;
        if (!modalId) return;
        Modal.update(modalId, editorProps);
    }, [editorProps]);

    const open = React.useCallback(() => {
        if (usePopoverHost) {
            setPopoverOpen(true);
            return;
        }
        if (modalIdRef.current) return;
        let modalId = '';
        modalId = Modal.show({
            component: SessionListFilterEditorModal,
            props: editorProps,
            chrome: {
                kind: 'card',
                title: props.editor.labels.title,
                bodyScroll: 'none',
                scrollHost: 'body',
                testID: 'session-list-filter-modal',
                dimensions: { size: 'md', width: 440, maxHeightRatio: 0.9 },
            },
            onRequestClose: () => {
                if (modalIdRef.current === modalId) modalIdRef.current = null;
            },
        });
        modalIdRef.current = modalId;
    }, [editorProps, props.editor.labels.title, usePopoverHost]);

    const trigger = (
        <Pressable
            ref={anchorRef}
            testID="session-list-filter-trigger"
            accessibilityRole="button"
            accessibilityLabel={props.label}
            accessibilityState={{ expanded: usePopoverHost ? popoverOpen : undefined, selected: props.active }}
            aria-expanded={usePopoverHost ? popoverOpen : undefined}
            aria-haspopup={usePopoverHost ? 'dialog' : undefined}
            aria-pressed={props.active}
            onPress={open}
            style={({ pressed }) => [
                styles.trigger,
                pressed ? styles.triggerPressed : null,
            ]}
        >
            <Text numberOfLines={1} style={[styles.triggerLabel, phone ? styles.phoneTriggerLabel : null]}>{props.label}</Text>
            <Icon name="caret-down" size={12} color={theme.colors.text.secondary} />
            {props.active ? (
                <Icon
                    testID="session-list-filter-trigger-narrowed"
                    name="funnel-simple"
                    size={14}
                    color={theme.colors.accent.blue}
                />
            ) : null}
        </Pressable>
    );

    if (!usePopoverHost) return trigger;
    return (
        <>
            {trigger}
            <Popover
                open={popoverOpen}
                anchorRef={anchorRef}
                placement="bottom"
                gap={6}
                // Surface geometry (lane craft-p2): a compact panel hanging from the title, measured
                // against the window rather than the sidebar, so it is never squeezed against or
                // clipped by the sidebar's edge; the content scrolls inside the height cap.
                boundaryRef={null}
                edgePadding={SCOPE_POPOVER_EDGE_PADDING}
                maxWidthCap={SCOPE_POPOVER_WIDTH_PX}
                maxHeightCap={SCOPE_POPOVER_MAX_HEIGHT_PX}
                autoFocusOnOpen
                portal={MODAL_AWARE_FLOATING_POPOVER_PORTAL_OPTIONS}
                onRequestClose={() => setPopoverOpen(false)}
                closeOnAnchorPress
                backdrop={false}
                containerStyle={{ paddingHorizontal: 0 }}
            >
                {({ maxHeight }) => (
                    // The canonical popover surface paints the sheet; the editor lays out inside it
                    // and owns its own scroll so the result count and Reset stay in view.
                    <FloatingOverlay maxHeight={maxHeight} surfaceChrome="theme" scrollEnabled={false}>
                        <SessionListFilterEditor
                            {...editorProps}
                            maxHeight={maxHeight}
                        />
                    </FloatingOverlay>
                )}
            </Popover>
        </>
    );
});
