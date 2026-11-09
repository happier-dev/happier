import * as React from 'react';
import { I18nManager, Platform, ScrollView, View, type LayoutChangeEvent } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

// The app's ONE RTL-aware tab-key owner. A Board-local Arrow algorithm would move
// the wrong way in a right-to-left locale; importing this is the contract.
import {
    HAPPIER_PAGE_METRICS,
    HappierPressable,
    resolveHappierFocusRingVisible,
    resolveHappierTabKeySelection,
} from '@happier-dev/plugin-ui/presentation';

import { focusRingStyle } from '@/components/ui/interactions/interactionFeedback';
import { Text, TextInput } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { restoreFocusToBestTarget, type FocusReturnRef } from '@/keyboard/focusReturn';
import type { SessionBoardViewProjection } from '@/sync/domains/session/board';
import { motionTokens } from '@/components/ui/motion/motionTokens';

/**
 * The inner Board organization selector.
 *
 * The outer Details destination strip and this one must never read or announce as
 * the same hierarchy. Details tabs carry icons and a close affordance; Board views
 * are a quiet row of text chips (lab B: the selected one sits on the selection
 * fill, the rest are plain text), labelled "Board views" to assistive technology,
 * and the strip is omitted entirely while Overview is the only view.
 */

const stylesheet = StyleSheet.create((theme) => ({
    strip: {
        flexGrow: 0,
    },
    content: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s4,
        paddingHorizontal: theme.space.s12,
        paddingTop: theme.space.s4,
        paddingBottom: theme.space.s6,
    },
    view: {
        minHeight: HAPPIER_PAGE_METRICS.controlHeightPx,
        paddingHorizontal: theme.space.s10,
        justifyContent: 'center',
        borderRadius: 999,
    },
    viewActive: {
        backgroundColor: theme.colors.surface.selected,
    },
    label: {
        ...Typography.variant('body'),
        color: theme.colors.text.secondary,
    },
    labelActive: {
        ...Typography.default('semiBold'),
        color: theme.colors.text.primary,
    },
    renameInput: {
        ...Typography.variant('body', 'semiBold'),
        color: theme.colors.text.primary,
        minWidth: 96,
        paddingVertical: 0,
    },
}));

export function sessionBoardViewTabNativeId(tabIdPrefix: string, viewId: string): string {
    return `${tabIdPrefix}-${encodeURIComponent(viewId)}`;
}

export function resolveSessionBoardViewTitle(view: SessionBoardViewProjection): string {
    if (view.title === null) return t('sessionBoard.views.overview');
    const trimmed = view.title.trim();
    return trimmed.length > 0 ? trimmed : t('sessionBoard.views.overview');
}

export function SessionBoardViewStrip(props: Readonly<{
    views: readonly SessionBoardViewProjection[];
    activeViewId: string;
    onSelectView: (viewId: string) => void;
    /** Applied selected-view removal awaiting authoritative projection convergence. */
    removalFocusRequest?: Readonly<{ removedViewId: string; requestId: number }> | null;
    onRemovalFocusHandled?: (requestId: number) => void;
    /** Stable per-Board prefix for each tab's native/DOM identity. */
    tabIdPrefix: string;
    /** Identity of the one panel whose contents follow the active tab. */
    panelId: string;
    /** Viewer-local geometry used only while a direct manipulation crosses views. */
    onViewLayout?: (viewId: string, event: LayoutChangeEvent) => void;
    onHorizontalOffset?: (offset: number) => void;
    /** Exposes the existing tab host for modal focus return; it owns no selection state. */
    onViewFocusTargetChange?: (viewId: string, target: { focus?: () => void } | null) => void;
    /** Surviving Board-view action control when removing a view hides this strip. */
    focusFallbackRef?: FocusReturnRef;
    renamingViewId?: string | null;
    onRenameCommit?: (viewId: string, title: string) => void;
    onRenameCancel?: () => void;
    testID?: string;
}>): React.ReactElement | null {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const views = props.views;
    const onSelectView = props.onSelectView;
    // A roving tablist owns its focus as well as its selection: the tab the
    // person just chose becomes the strip's only tab stop, so leaving the caret
    // on the previous one strands it outside the tab order.
    const viewRefs = React.useRef(new Map<string, { focus?: () => void }>());
    const focusedViewIdRef = React.useRef<string | null>(null);
    const [renameDraft, setRenameDraft] = React.useState('');
    const renameSettledRef = React.useRef(false);
    const previousRenamingViewIdRef = React.useRef<string | null>(null);
    React.useEffect(() => {
        const next = props.renamingViewId ?? null;
        const previous = previousRenamingViewIdRef.current;
        if (next !== null && next !== previous) {
            const view = views.find((candidate) => candidate.id === next);
            setRenameDraft(view ? resolveSessionBoardViewTitle(view) : '');
            renameSettledRef.current = false;
        } else if (next === null && previous !== null) {
            restoreFocusToBestTarget(
                { current: viewRefs.current.get(previous) },
                props.focusFallbackRef,
            );
        }
        previousRenamingViewIdRef.current = next;
    }, [props.renamingViewId, props.focusFallbackRef, views]);
    // Removal reconciliation and the surviving tab refs belong to one commit.
    // Restore focus before a following controller effect can schedule another
    // render and obscure which focused tab was removed.
    React.useLayoutEffect(() => {
        const focusedViewId = focusedViewIdRef.current;
        const focusedViewWasRemoved = focusedViewId !== null
            && !views.some((view) => view.id === focusedViewId);
        const removalFocusRequest = props.removalFocusRequest ?? null;
        const requestedViewWasRemoved = removalFocusRequest !== null
            && !views.some((view) => view.id === removalFocusRequest.removedViewId);
        if (!focusedViewWasRemoved && !requestedViewWasRemoved) return;
        // The controller can render the new projection once with the removed id
        // while its owner-level reconciliation selects the nearest survivor. Do
        // not spend the pending focus return on that transient, absent target.
        if (!views.some((view) => view.id === props.activeViewId)) return;
        const activeTarget = viewRefs.current.get(props.activeViewId);
        if (!restoreFocusToBestTarget({ current: activeTarget }, props.focusFallbackRef)) return;
        focusedViewIdRef.current = props.activeViewId;
        if (requestedViewWasRemoved && removalFocusRequest) {
            props.onRemovalFocusHandled?.(removalFocusRequest.requestId);
        }
    }, [
        props.activeViewId,
        props.focusFallbackRef,
        props.onRemovalFocusHandled,
        props.removalFocusRequest,
        views,
    ]);
    // Returns whether the key was a tab-selection key: the shared pressable then consumes the event.
    const handleKeyDown = React.useCallback((index: number, key: string): boolean => {
        const nextIndex = resolveHappierTabKeySelection({
            tabs: views,
            currentIndex: index,
            key,
            rtl: I18nManager.isRTL,
        });
        if (nextIndex === null) return false;
        const next = views[nextIndex];
        if (!next) return false;
        onSelectView(next.id);
        if (nextIndex !== index) viewRefs.current.get(next.id)?.focus?.();
        return true;
    }, [onSelectView, views]);

    // A lone view needs no selector — but hiding the strip also hid the inline rename
    // editor, so the enabled Rename action produced no input and no feedback. The
    // renaming row is the exception the quiet single-view case keeps.
    const renamingLoneView = props.renamingViewId !== null
        && props.renamingViewId !== undefined
        && props.views.some((view) => view.id === props.renamingViewId);
    if (props.views.length <= 1 && !renamingLoneView) return null;

    return (
        <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            scrollEventThrottle={16}
            onScroll={(event) => props.onHorizontalOffset?.(event.nativeEvent.contentOffset.x)}
            style={styles.strip}
            contentContainerStyle={styles.content}
            accessibilityRole="tablist"
            accessibilityLabel={t('sessionBoard.views.label')}
            testID={props.testID ?? 'session-board-views'}
        >
            {props.views.map((view, index) => {
                const selected = view.id === props.activeViewId;
                const label = resolveSessionBoardViewTitle(view);
                const renaming = props.renamingViewId === view.id;
                if (renaming) {
                    const commit = () => {
                        if (renameSettledRef.current) return;
                        renameSettledRef.current = true;
                        const next = renameDraft.trim();
                        if (next.length === 0 || next === label) props.onRenameCancel?.();
                        else props.onRenameCommit?.(view.id, next);
                    };
                    return (
                        <View
                            key={view.id}
                            nativeID={sessionBoardViewTabNativeId(props.tabIdPrefix, view.id)}
                            testID={`${props.testID ?? 'session-board-views'}-view-${view.id}`}
                            accessibilityRole="tab"
                            accessibilityState={{ selected }}
                            {...(Platform.OS === 'web' ? { 'aria-controls': props.panelId } : {})}
                            style={[styles.view, selected ? styles.viewActive : null]}
                        >
                            <TextInput
                                testID={`${props.testID ?? 'session-board-views'}-rename-${view.id}`}
                                style={styles.renameInput}
                                value={renameDraft}
                                autoFocus
                                selectTextOnFocus
                                accessibilityLabel={t('sessionBoard.views.renameTitle')}
                                onFocus={() => { focusedViewIdRef.current = view.id; }}
                                onBlur={() => {
                                    if (focusedViewIdRef.current === view.id) focusedViewIdRef.current = null;
                                    commit();
                                }}
                                onChangeText={setRenameDraft}
                                onSubmitEditing={commit}
                                onKeyPress={(event) => {
                                    if (event.nativeEvent.key !== 'Escape') return;
                                    if (renameSettledRef.current) return;
                                    renameSettledRef.current = true;
                                    props.onRenameCancel?.();
                                }}
                            />
                        </View>
                    );
                }
                return (
                    // The Board measures each view's frame; the pressable owns its own layout callback for its hit area.
                    <View key={view.id} onLayout={(event) => props.onViewLayout?.(view.id, event)}>
                        <HappierPressable
                            nativeID={sessionBoardViewTabNativeId(props.tabIdPrefix, view.id)}
                            controlRef={(node) => {
                                const target = node as { focus?: () => void } | null;
                                if (target) viewRefs.current.set(view.id, target);
                                else viewRefs.current.delete(view.id);
                                props.onViewFocusTargetChange?.(view.id, target);
                            }}
                            testID={`${props.testID ?? 'session-board-views'}-view-${view.id}`}
                            accessibilityRole="tab"
                            selected={selected}
                            accessibilityLabel={label}
                            controls={props.panelId}
                            // Roving focus is a web-DOM contract.
                            tabIndex={Platform.OS === 'web' ? (selected ? 0 : -1) : undefined}
                            onKeyDown={(key) => handleKeyDown(index, key)}
                            onPress={() => props.onSelectView(view.id)}
                            onFocusChange={(focused) => {
                                if (focused) focusedViewIdRef.current = view.id;
                                else if (focusedViewIdRef.current === view.id) focusedViewIdRef.current = null;
                            }}
                            // The chips stand one strip gap apart in a clipping scroller: the hit area takes half the
                            // gap sideways and the scroller's own padding above and below.
                            hitReach={{
                                left: theme.space.s4 / 2,
                                right: theme.space.s4 / 2,
                                top: theme.space.s4,
                                bottom: theme.space.s6,
                            }}
                            style={(interactionState) => [
                                styles.view,
                                selected ? styles.viewActive : null,
                                { opacity: interactionState.pressed ? motionTokens.press.opacity : 1 },
                                focusRingStyle({ focused: resolveHappierFocusRingVisible(interactionState.focused), color: theme.colors.border.focus }),
                            ]}
                        >
                            <View>
                                <Text style={[styles.label, selected ? styles.labelActive : null]} numberOfLines={1}>
                                    {label}
                                </Text>
                            </View>
                        </HappierPressable>
                    </View>
                );
            })}
            <View style={{ width: 4, backgroundColor: theme.colors.surface.base }} />
        </ScrollView>
    );
}
