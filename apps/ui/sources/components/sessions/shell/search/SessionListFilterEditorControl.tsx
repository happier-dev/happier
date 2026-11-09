import * as React from 'react';
import { Platform, Pressable, useWindowDimensions, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { Icon } from '@/components/ui/icons/Icon';
import { MODAL_AWARE_FLOATING_POPOVER_PORTAL_OPTIONS, Popover } from '@/components/ui/popover';
import { FloatingOverlay } from '@/components/ui/overlays/FloatingOverlay';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';
import { useIsTablet } from '@/utils/platform/responsive';
import { shouldUseReadablePhoneMinimalSessionRow } from '../resolveSessionListDensityViewState';

import { sessionListStyles } from '../sessionListStyles';
import {
    SessionListFilterEditor,
    type SessionListFilterEditorProps,
} from './SessionListFilterEditor';
import { useSessionListSpaceKeyboardCommands } from '@/keyboard/sessionListSpaces';
import { collectionTitleStyles as titleStyles, useCollectionTitleTriggerHitArea } from '@/components/ui/lists/collection/CollectionTitleButton';
import type { CollectionSpaceTitleFilter } from '@/components/ui/lists/collection/CollectionSpaceTitle';

type EditorProps = Omit<SessionListFilterEditorProps, 'maxHeight'>;

export type SessionListFilterEditorControlProps = Readonly<{
    label: string;
    active: boolean;
    presentation?: 'title' | 'summary';
    keyboardEnabled?: boolean;
    openRequested?: boolean;
    onOpenRequestHandled?: () => void;
    /**
     * A host that draws its own entry points (the Sessions column's title menu, Find's filter button,
     * ⌥F) controls the editor and hangs it from its own anchor; no trigger is drawn here.
     */
    controlled?: Readonly<{
        open: boolean;
        onOpenChange: (open: boolean) => void;
        anchorRef: React.RefObject<View | null>;
    }>;
    editor: EditorProps;
}>;

/** The filter popover's width (lab `clfilter:filter`): wide enough for Field · operator · values · remove. */
const SCOPE_POPOVER_WIDTH_PX = 356;
/** Tall enough for every facet on a laptop screen; beyond it the panel scrolls inside. */
const SCOPE_POPOVER_MAX_HEIGHT_PX = 520;
/** Keeps the popover off the window's edges when it is clamped there (phones). */
const SCOPE_POPOVER_EDGE_PADDING = { horizontal: 8, vertical: 8 } as const;

/** On a phone the editor ends with Show N results, which closes it (lab `clfilter:filterP`). */
function phoneDoneProps(editor: EditorProps, done: () => void): Partial<SessionListFilterEditorProps> {
    if (editor.onDone) return {};
    return {
        onDone: done,
        ...(editor.result?.coverage === 'complete'
            ? { doneLabel: t('sessionsList.filterShowCount', { count: editor.result.matchedCount }) }
            : {}),
    };
}

/**
 * The editor as the title menu's Filter submenu: the same size and phone Done as its own popover. Leaving the
 * filters for the archived list or the Save-as form closes the whole menu.
 */
export function buildSessionListFilterSubmenu(editor: EditorProps, count: number): CollectionSpaceTitleFilter {
    return {
        count,
        maxWidth: SCOPE_POPOVER_WIDTH_PX,
        maxHeight: SCOPE_POPOVER_MAX_HEIGHT_PX,
        render: ({ maxHeight, endsWithDone, done }) => {
            const { onOpenArchived, onSaveAsSpace } = editor;
            return <SessionListFilterEditor
                {...editor}
                {...(onOpenArchived ? { onOpenArchived: () => { done(); onOpenArchived(); } } : {})}
                {...(onSaveAsSpace ? { onSaveAsSpace: () => { done(); onSaveAsSpace(); } } : {})}
                {...(endsWithDone ? phoneDoneProps(editor, done) : {})}
                maxHeight={maxHeight}
            />;
        },
    };
}

export const SessionListFilterEditorControl = React.memo(function SessionListFilterEditorControl(
    props: SessionListFilterEditorControlProps,
) {
    const { theme } = useUnistyles();
    const isTablet = useIsTablet();
    const { width: windowWidth } = useWindowDimensions();
    const phone = shouldUseReadablePhoneMinimalSessionRow({ isTablet, platform: Platform.OS, windowWidth });
    const [uncontrolledOpen, setUncontrolledOpen] = React.useState(false);
    const controlled = props.controlled;
    const popoverOpen = controlled ? controlled.open : uncontrolledOpen;
    const setPopoverOpen = controlled ? controlled.onOpenChange : setUncontrolledOpen;
    const ownAnchorRef = React.useRef<View>(null);
    const anchorRef = controlled?.anchorRef ?? ownAnchorRef;

    const openArchivedFromEditor = props.editor.onOpenArchived;
    // Leaving for the archived list closes the editor first.
    const handleOpenArchived = React.useMemo(() => (openArchivedFromEditor ? () => {
        setPopoverOpen(false);
        openArchivedFromEditor();
    } : undefined), [openArchivedFromEditor, setPopoverOpen]);
    const editorProps = React.useMemo<EditorProps>(() => (
        handleOpenArchived ? { ...props.editor, onOpenArchived: handleOpenArchived } : props.editor
    ), [handleOpenArchived, props.editor]);

    // Every width opens the same popover anchored to its trigger (owner R2, 2026-11-09).
    const open = React.useCallback(() => setPopoverOpen(true), [setPopoverOpen]);

    useSessionListSpaceKeyboardCommands({ enabled: props.keyboardEnabled !== false && !controlled, openFilter: open });
    React.useEffect(() => {
        if (!props.openRequested) return;
        open();
        props.onOpenRequestHandled?.();
    }, [open, props.onOpenRequestHandled, props.openRequested]);

    const triggerHitArea = useCollectionTitleTriggerHitArea();
    const trigger = (
        <Pressable
            ref={anchorRef}
            testID="session-list-filter-trigger"
            accessibilityRole="button"
            accessibilityLabel={props.label}
            accessibilityState={{ expanded: popoverOpen, selected: props.active }}
            aria-expanded={popoverOpen}
            aria-haspopup="dialog"
            aria-pressed={props.active}
            onPress={open}
            hitSlop={triggerHitArea.hitSlop}
            onLayout={triggerHitArea.onLayout}
            style={({ pressed }) => [
                titleStyles.trigger,
                pressed ? titleStyles.triggerPressed : null,
            ]}
        >
            {triggerHitArea.frame}
            <Text numberOfLines={1} style={props.presentation === 'summary'
                ? sessionListStyles.searchChromeStatusText
                : [titleStyles.triggerLabel, phone ? titleStyles.phoneTriggerLabel : null]}>{props.label}</Text>
            {props.presentation !== 'summary' ? <Icon name="caret-down" size={12} color={theme.colors.text.secondary} /> : null}
            {props.active && props.presentation !== 'summary' ? (
                <Icon
                    testID="session-list-filter-trigger-narrowed"
                    name="funnel-simple"
                    size={14}
                    color={theme.colors.accent.blue}
                />
            ) : null}
        </Pressable>
    );

    return (
        <>
            {controlled ? null : trigger}
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
                // The editor's own header (Filter · Clear) titles it; a phone ends it with Show N (lab `clfilter:filterP`).
                phonePresentation="panel"
                accessibilityLabel={props.editor.labels.conditions.title}
                containerStyle={{ paddingHorizontal: 0 }}
            >
                {({ maxHeight }) => (
                    // The canonical popover surface paints the material; the editor lays out inside it
                    // and owns its own scroll so the result count and Reset stay in view.
                    <FloatingOverlay maxHeight={maxHeight} surfaceChrome="theme" scrollEnabled={false}>
                        <SessionListFilterEditor
                            {...editorProps}
                            {...(phone ? phoneDoneProps(editorProps, () => setPopoverOpen(false)) : {})}
                            maxHeight={maxHeight}
                        />
                    </FloatingOverlay>
                )}
            </Popover>
        </>
    );
});
