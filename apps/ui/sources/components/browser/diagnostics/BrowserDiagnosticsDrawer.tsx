import * as React from 'react';
import { Platform, PanResponder, ScrollView, View } from 'react-native';
import Animated, {
    cancelAnimation,
    useAnimatedStyle,
    useSharedValue,
    withTiming,
    type WithTimingConfig,
} from 'react-native-reanimated';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { IconButton } from '@/components/ui/buttons/IconButton';
import { resolveMinimumInteractiveTargetSize } from '@/components/ui/interactiveTargetSize';
import { SegmentedTabBar, type SegmentedTab } from '@/components/ui/navigation/SegmentedTabBar';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import type {
    BrowserDiagnosticFamilyProjection,
    BrowserDiagnosticsPanelProjection,
    BrowserViewDiagnosticsProjection,
} from '@/sync/domains/browser/diagnostics';
import { t } from '@/text';

import { BROWSER_DRAWER_MAX_HEIGHT_FRACTION } from '../browserChromeDensity';
import { BrowserDiagnosticsPanel } from './BrowserDiagnosticsPanel';
import { Icon } from '@/components/ui/icons/Icon';
import type {
    BrowserDiagnosticsInteractionControls,
    BrowserDiagnosticsInteractionSurface,
} from './BrowserDiagnosticsInteractionPanel';

type DrawerState = 'expanded' | 'collapsed' | 'closed';

const SECTION_FAMILY_ORDER = [
    'console',
    'pageError',
    'network',
    'elements',
    'resources',
    'storage',
    'pageInfo',
    'performance',
] as const;

type SectionFamily = (typeof SECTION_FAMILY_ORDER)[number];

/**
 * The supplemental preview-proxy projection is a whole second diagnostics source, not a family of
 * the host one. It used to be rendered by a SECOND drawer stacked under the first, with the same
 * title — two identical "Diagnostics" headers, one above the other. It is a section now.
 */
const PREVIEW_PROXY_SECTION = 'previewProxy' as const;
type SectionKey = SectionFamily | typeof PREVIEW_PROXY_SECTION;

const SECTION_FAMILY_SET: ReadonlySet<BrowserDiagnosticFamilyProjection['family']> = new Set(SECTION_FAMILY_ORDER);

function isSectionFamily(family: BrowserDiagnosticFamilyProjection['family']): family is SectionFamily {
    return SECTION_FAMILY_SET.has(family);
}

// Interactive controls stay family-scoped: Console owns eval/object inspection;
// Elements owns the trusted injected-diagnostics picker. Other sections are
// read-only projections.
const CONSOLE_SECTION: SectionFamily = 'console';
const ELEMENTS_SECTION: SectionFamily = 'elements';

/**
 * Height, as a FRACTION of the surface rather than a fixed 320px.
 *
 * 320px is a third of a 960pt desktop pane and three quarters of a 430pt phone: one number cannot
 * be right on both, and on the phone the drawer was eating the page it was reporting on. The
 * fraction comes from the chrome-density owner so the drawer and the collapsed-chrome rules move
 * together. `COLLAPSED_RATIO` keeps the original E1-lunel peek proportion.
 */
const COLLAPSED_RATIO = 0.58;
/** Used only until the surface reports its height, and as the floor for a very short surface. */
const FALLBACK_EXPANDED_HEIGHT_PX = 320;
/** Below this the body cannot show a row, so a drag that goes under it closes the drawer instead. */
const MIN_DRAGGABLE_HEIGHT_PX = 96;

const HEIGHT_ANIMATION_DURATION_MS = 200;
const TIMING_CONFIG: WithTimingConfig = { duration: HEIGHT_ANIMATION_DURATION_MS };

/**
 * Remembered drawer state per view.
 *
 * Bounded: a long session opens many views, and an unbounded module-level `Map` retained one entry
 * for every view the user had ever opened for the lifetime of the tab. Insertion order is eviction
 * order, and re-setting a key moves it to the end, so this is a plain LRU.
 */
const DRAWER_STATE_CACHE_LIMIT = 32;
const drawerStateByDiagnosticsViewKey = new Map<string, Readonly<{
    drawerState: DrawerState;
    activeSection: SectionKey | null;
}>>();

function rememberDrawerState(key: string, value: Readonly<{ drawerState: DrawerState; activeSection: SectionKey | null }>): void {
    if (drawerStateByDiagnosticsViewKey.has(key)) {
        drawerStateByDiagnosticsViewKey.delete(key);
    }
    drawerStateByDiagnosticsViewKey.set(key, value);
    while (drawerStateByDiagnosticsViewKey.size > DRAWER_STATE_CACHE_LIMIT) {
        const oldest = drawerStateByDiagnosticsViewKey.keys().next();
        if (oldest.done) break;
        drawerStateByDiagnosticsViewKey.delete(oldest.value);
    }
}

export function resetBrowserDiagnosticsDrawerStateForTests(): void {
    drawerStateByDiagnosticsViewKey.clear();
}

const stylesheet = StyleSheet.create((theme) => ({
    root: {
        borderTopWidth: 1,
        borderTopColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.base,
    },
    // The grab strip. It is the whole header row, not a decorative pill: a 6pt grabber is a target
    // nobody can hit, and the row is already there.
    handleRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        paddingHorizontal: 12,
        paddingTop: 4,
        paddingBottom: 8,
    },
    grabberSlot: {
        alignItems: 'center',
        paddingTop: 6,
        paddingBottom: 2,
    },
    grabber: {
        width: 36,
        height: 4,
        borderRadius: 2,
        backgroundColor: theme.colors.border.strong,
    },
    grabberActive: {
        backgroundColor: theme.colors.text.secondary,
    },
    titleColumn: {
        flex: 1,
        minWidth: 0,
        gap: 2,
    },
    title: {
        ...Typography.rowTitle(),
        color: theme.colors.text.primary,
    },
    sectionBar: {
        borderTopWidth: 1,
        borderTopColor: theme.colors.border.default,
    },
    sectionBarContent: {
        paddingHorizontal: 12,
        paddingVertical: 6,
    },
    bodyClip: {
        overflow: 'hidden',
    },
    bodyScroll: {
        flexGrow: 0,
    },
}));

function sectionLabel(section: SectionKey): string {
    switch (section) {
        case 'console':
            return t('browserShell.devtools.section.console');
        case 'pageError':
            return t('browserShell.devtools.section.pageErrors');
        case 'network':
            return t('browserShell.devtools.section.network');
        case 'elements':
            return t('browserShell.devtools.section.elements');
        case 'resources':
            return t('browserShell.devtools.section.resources');
        case 'storage':
            return t('browserShell.devtools.section.storage');
        case 'pageInfo':
            return t('browserShell.devtools.section.info');
        case 'performance':
            return t('browserShell.devtools.section.performance');
        case PREVIEW_PROXY_SECTION:
            return t('browserShell.origin.localPreview');
    }
}

function diagnosticsViewKey(diagnostics: BrowserDiagnosticsPanelProjection): string {
    if (diagnostics.sourceKind === 'browserDiagnostics') {
        return `browserDiagnostics:${diagnostics.browserSessionId}:${diagnostics.viewId}`;
    }
    return 'previewProxy';
}

function projectionForSection(
    diagnostics: BrowserViewDiagnosticsProjection,
    family: SectionFamily,
): BrowserViewDiagnosticsProjection {
    return {
        ...diagnostics,
        families: diagnostics.families.filter((candidate) => candidate.family === family),
        events: diagnostics.events.filter((event) => event.family === family),
    };
}

export function BrowserDiagnosticsDrawer(props: Readonly<{
    diagnostics: BrowserDiagnosticsPanelProjection;
    /**
     * A second diagnostics source (the preview proxy). Rendered as an extra SECTION of this drawer,
     * never as a second drawer: two stacked panels with the same title is what the surface used to
     * do, and there was no way to tell them apart.
     */
    supplemental?: BrowserDiagnosticsPanelProjection | null;
    interaction?: BrowserDiagnosticsInteractionControls;
    /**
     * Height of the surface the drawer sits in. The drawer takes a fraction of it rather than a
     * fixed 320px. Omitted (or zero) falls back to the historical fixed height.
     */
    surfaceHeightPx?: number;
    testID?: string;
}>): React.ReactElement {
    const testID = props.testID ?? 'browser-diagnostics-drawer';
    const bodyTestID = `${testID}-body`;
    const { theme } = useUnistyles();
    const reducedMotion = useReducedMotionPreference();

    const expandedHeight = React.useMemo(() => {
        const fromSurface = Number.isFinite(props.surfaceHeightPx) && (props.surfaceHeightPx ?? 0) > 0
            ? Math.round((props.surfaceHeightPx ?? 0) * BROWSER_DRAWER_MAX_HEIGHT_FRACTION)
            : FALLBACK_EXPANDED_HEIGHT_PX;
        return Math.max(MIN_DRAGGABLE_HEIGHT_PX, fromSurface);
    }, [props.surfaceHeightPx]);
    const collapsedHeight = Math.round(expandedHeight * COLLAPSED_RATIO);

    const bodyHeightForState = React.useCallback((state: DrawerState): number => {
        switch (state) {
            case 'expanded':
                return expandedHeight;
            case 'collapsed':
                return collapsedHeight;
            case 'closed':
                return 0;
        }
    }, [collapsedHeight, expandedHeight]);

    const isHost = props.diagnostics.sourceKind === 'browserDiagnostics';
    const sections = React.useMemo<readonly SectionKey[]>(() => {
        const hostSections: SectionKey[] = [];
        if (isHost) {
            const present = new Set(
                (props.diagnostics as BrowserViewDiagnosticsProjection).families
                    .map((family) => family.family)
                    .filter(isSectionFamily),
            );
            hostSections.push(...SECTION_FAMILY_ORDER.filter((family) => present.has(family)));
        }
        if (props.supplemental) {
            hostSections.push(PREVIEW_PROXY_SECTION);
        }
        return hostSections;
    }, [isHost, props.diagnostics, props.supplemental]);

    const persistenceKey = React.useMemo(() => diagnosticsViewKey(props.diagnostics), [props.diagnostics]);
    const persistedState = drawerStateByDiagnosticsViewKey.get(persistenceKey);
    // Opens COLLAPSED. A devtools drawer that takes 45% of the surface the instant a page loads is
    // a drawer the user closes before reading anything; the peek says "there is something here"
    // without deciding for them.
    const [drawerState, setDrawerState] = React.useState<DrawerState>(
        persistedState?.drawerState ?? 'collapsed',
    );
    const [activeSection, setActiveSection] = React.useState<SectionKey | null>(
        persistedState?.activeSection && sections.includes(persistedState.activeSection)
            ? persistedState.activeSection
            : (sections[0] ?? null),
    );

    // Keep the active section valid as the projection's families change (a new
    // navigation generation may drop the previously-selected family). Never
    // remount the body — only repoint the selection.
    React.useEffect(() => {
        if (sections.length === 0) {
            if (activeSection !== null) setActiveSection(null);
            return;
        }
        if (activeSection === null || !sections.includes(activeSection)) {
            setActiveSection(sections[0] ?? null);
        }
    }, [activeSection, sections]);

    React.useEffect(() => {
        rememberDrawerState(persistenceKey, { drawerState, activeSection });
    }, [activeSection, drawerState, persistenceKey]);

    const animatedHeight = useSharedValue(bodyHeightForState('collapsed'));
    const draggingRef = React.useRef(false);
    const [dragging, setDragging] = React.useState(false);

    React.useEffect(() => {
        if (draggingRef.current) return;
        const target = bodyHeightForState(drawerState);
        if (reducedMotion) {
            animatedHeight.value = target;
            return;
        }
        animatedHeight.value = withTiming(target, TIMING_CONFIG);
    }, [animatedHeight, bodyHeightForState, drawerState, reducedMotion]);

    React.useEffect(() => () => {
        cancelAnimation(animatedHeight);
    }, [animatedHeight]);

    // Drag to resize. The gesture writes the height directly so the drawer tracks the finger, then
    // snaps to the nearest committed state on release — the state, not the raw pixel height, is
    // what persists, so the drawer never reopens at an arbitrary size.
    const dragStartHeightRef = React.useRef(0);
    const dragResponder = React.useMemo(() => PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: (_event, gesture) => Math.abs(gesture.dy) > 2,
        onPanResponderGrant: () => {
            draggingRef.current = true;
            setDragging(true);
            dragStartHeightRef.current = animatedHeight.value;
        },
        onPanResponderMove: (_event, gesture) => {
            const next = dragStartHeightRef.current - gesture.dy;
            animatedHeight.value = Math.max(0, Math.min(expandedHeight, next));
        },
        onPanResponderRelease: () => {
            draggingRef.current = false;
            setDragging(false);
            const height = animatedHeight.value;
            const next: DrawerState = height < MIN_DRAGGABLE_HEIGHT_PX / 2
                ? 'closed'
                : height < (collapsedHeight + expandedHeight) / 2
                    ? 'collapsed'
                    : 'expanded';
            const target = bodyHeightForState(next);
            animatedHeight.value = reducedMotion ? target : withTiming(target, TIMING_CONFIG);
            setDrawerState(next);
        },
        onPanResponderTerminate: () => {
            draggingRef.current = false;
            setDragging(false);
        },
    }), [animatedHeight, bodyHeightForState, collapsedHeight, expandedHeight, reducedMotion]);

    const bodyAnimatedStyle = useAnimatedStyle(() => ({
        height: animatedHeight.value,
    }), []);

    const showingSupplemental = activeSection === PREVIEW_PROXY_SECTION && props.supplemental != null;
    const bodyDiagnostics = React.useMemo<BrowserDiagnosticsPanelProjection>(() => {
        if (showingSupplemental && props.supplemental) {
            return props.supplemental;
        }
        if (!isHost || activeSection === null || activeSection === PREVIEW_PROXY_SECTION) {
            return props.diagnostics;
        }
        return projectionForSection(props.diagnostics as BrowserViewDiagnosticsProjection, activeSection);
    }, [activeSection, isHost, props.diagnostics, props.supplemental, showingSupplemental]);

    const bodyInteractionSurface: BrowserDiagnosticsInteractionSurface | undefined = (
        activeSection === CONSOLE_SECTION
            ? 'console'
            : activeSection === ELEMENTS_SECTION
                ? 'elements'
                : undefined
    );
    const bodyInteraction = isHost && !showingSupplemental && bodyInteractionSurface
        ? props.interaction
        : undefined;

    const bodyVisible = drawerState !== 'closed';
    const tabs = React.useMemo<readonly SegmentedTab<SectionKey>[]>(
        () => sections.map((section) => ({ id: section, label: sectionLabel(section) })),
        [sections],
    );

    return (
        <View testID={`${testID}-container-${drawerState}`} style={stylesheet.root}>
            <View {...dragResponder.panHandlers}>
                <View
                    style={stylesheet.grabberSlot}
                    accessibilityElementsHidden
                    importantForAccessibility="no-hide-descendants"
                >
                    <View
                        testID={`${testID}-grabber`}
                        style={[stylesheet.grabber, dragging ? stylesheet.grabberActive : null]}
                    />
                </View>
                <View style={stylesheet.handleRow}>
                    <Icon name="bug" size={16} color={theme.colors.text.secondary} />
                    <View style={stylesheet.titleColumn}>
                        <Text style={stylesheet.title}>{t('browserShell.devtools.title')}</Text>
                    </View>
                    {drawerState === 'closed' ? (
                        <IconButton
                            testID={`${testID}-open`}
                            iconName="caret-up"
                            accessibilityLabel={t('browserShell.devtools.open')}
                            tooltip={t('browserShell.devtools.open')}
                            size={30}
                            minimumInteractiveTargetSize={resolveMinimumInteractiveTargetSize(Platform.OS)}
                            interactiveTargetGapPx={8}
                            iconSize={16}
                            onPress={() => setDrawerState('expanded')}
                        />
                    ) : (
                        <>
                            {drawerState === 'expanded' ? (
                                <IconButton
                                    testID={`${testID}-collapse`}
                                    iconName="caret-down"
                                    accessibilityLabel={t('browserShell.devtools.collapse')}
                                    tooltip={t('browserShell.devtools.collapse')}
                                    size={30}
                                    minimumInteractiveTargetSize={resolveMinimumInteractiveTargetSize(Platform.OS)}
                                    interactiveTargetGapPx={8}
                                    iconSize={16}
                                    onPress={() => setDrawerState('collapsed')}
                                />
                            ) : (
                                <IconButton
                                    testID={`${testID}-expand`}
                                    iconName="caret-up"
                                    accessibilityLabel={t('browserShell.devtools.expand')}
                                    tooltip={t('browserShell.devtools.expand')}
                                    size={30}
                                    minimumInteractiveTargetSize={resolveMinimumInteractiveTargetSize(Platform.OS)}
                                    interactiveTargetGapPx={8}
                                    iconSize={16}
                                    onPress={() => setDrawerState('expanded')}
                                />
                            )}
                            <IconButton
                                testID={`${testID}-close`}
                                iconName="x"
                                accessibilityLabel={t('browserShell.devtools.close')}
                                tooltip={t('browserShell.devtools.close')}
                                size={30}
                                minimumInteractiveTargetSize={resolveMinimumInteractiveTargetSize(Platform.OS)}
                                interactiveTargetGapPx={8}
                                iconSize={16}
                                onPress={() => setDrawerState('closed')}
                            />
                        </>
                    )}
                </View>
            </View>

            {bodyVisible && activeSection !== null && tabs.length > 0 ? (
                <View style={stylesheet.sectionBar}>
                    {/*
                      * The canonical tab bar, not eight hand-rolled `role="tab"` Pressables in a
                      * plain View. It brings the `tablist` container the old markup never had,
                      * arrow-key roving focus, the sliding thumb and WCAG 2.5.8 sizing — all of
                      * which already existed one import away.
                      */}
                    <ScrollView
                        testID={`${testID}-sections`}
                        horizontal
                        showsHorizontalScrollIndicator={false}
                        contentContainerStyle={stylesheet.sectionBarContent}
                    >
                        <SegmentedTabBar<SectionKey>
                            testIDPrefix={`${testID}-tab`}
                            tabs={tabs}
                            activeTabId={activeSection}
                            onSelectTab={setActiveSection}
                            compact
                            slidingThumb
                            segmentSizing="content"
                            accessibilityLabel={t('browserShell.devtools.title')}
                        />
                    </ScrollView>
                </View>
            ) : null}

            {bodyVisible ? (
                <Animated.View style={[stylesheet.bodyClip, bodyAnimatedStyle]}>
                    <ScrollView style={stylesheet.bodyScroll} showsVerticalScrollIndicator={false}>
                        <BrowserDiagnosticsPanel
                            diagnostics={bodyDiagnostics}
                            interaction={bodyInteraction}
                            interactionSurface={bodyInteractionSurface}
                            testID={bodyTestID}
                        />
                    </ScrollView>
                </Animated.View>
            ) : null}
        </View>
    );
}
