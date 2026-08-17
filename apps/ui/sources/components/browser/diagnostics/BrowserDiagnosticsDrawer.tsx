import * as React from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import Animated, {
    cancelAnimation,
    useAnimatedStyle,
    useSharedValue,
    withTiming,
    type WithTimingConfig,
} from 'react-native-reanimated';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { IconButton } from '@/components/ui/buttons/IconButton';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import type {
    BrowserDiagnosticFamilyProjection,
    BrowserDiagnosticsPanelProjection,
    BrowserViewDiagnosticsProjection,
} from '@/sync/domains/browser/diagnostics';
import { t } from '@/text';

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

const SECTION_FAMILY_SET: ReadonlySet<BrowserDiagnosticFamilyProjection['family']> = new Set(SECTION_FAMILY_ORDER);

function isSectionFamily(family: BrowserDiagnosticFamilyProjection['family']): family is SectionFamily {
    return SECTION_FAMILY_SET.has(family);
}

// Interactive controls stay family-scoped: Console owns eval/object inspection;
// Elements owns the trusted injected-diagnostics picker. Other sections are
// read-only projections.
const CONSOLE_SECTION: SectionFamily = 'console';
const ELEMENTS_SECTION: SectionFamily = 'elements';

// Expanded drawer height; collapsed peeks at ~58% of it (E1 lunel pattern 2).
// Heights are layout constraints only — the per-family fidelity/trust model and
// the fail-closed gates are untouched.
const EXPANDED_HEIGHT = 320;
const COLLAPSED_RATIO = 0.58;
const COLLAPSED_HEIGHT = Math.round(EXPANDED_HEIGHT * COLLAPSED_RATIO);

const HEIGHT_ANIMATION_DURATION_MS = 200;
const TIMING_CONFIG: WithTimingConfig = { duration: HEIGHT_ANIMATION_DURATION_MS };

const drawerStateByDiagnosticsViewKey = new Map<string, Readonly<{
    drawerState: DrawerState;
    activeFamily: SectionFamily | null;
}>>();

export function resetBrowserDiagnosticsDrawerStateForTests(): void {
    drawerStateByDiagnosticsViewKey.clear();
}

function bodyHeightForState(state: DrawerState): number {
    switch (state) {
        case 'expanded':
            return EXPANDED_HEIGHT;
        case 'collapsed':
            return COLLAPSED_HEIGHT;
        case 'closed':
            return 0;
    }
}

const stylesheet = StyleSheet.create((theme) => ({
    root: {
        borderTopWidth: 1,
        borderTopColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.base,
    },
    handleRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        paddingHorizontal: 12,
        paddingVertical: 8,
    },
    titleColumn: {
        flex: 1,
        minWidth: 0,
        gap: 2,
    },
    title: {
        color: theme.colors.text.primary,
        fontSize: 13,
        ...Typography.default('semiBold'),
    },
    sectionBar: {
        borderTopWidth: 1,
        borderTopColor: theme.colors.border.default,
    },
    sectionBarContent: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        paddingHorizontal: 12,
        paddingVertical: 6,
    },
    sectionTab: {
        borderRadius: 999,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.base,
        paddingHorizontal: 12,
        paddingVertical: 5,
    },
    sectionTabActive: {
        borderColor: theme.colors.text.primary,
        backgroundColor: theme.colors.surface.inset,
    },
    sectionTabText: {
        color: theme.colors.text.secondary,
        fontSize: 12,
        ...Typography.default('semiBold'),
    },
    sectionTabTextActive: {
        color: theme.colors.text.primary,
    },
    bodyClip: {
        overflow: 'hidden',
    },
    bodyScroll: {
        flexGrow: 0,
    },
}));

function sectionLabel(family: SectionFamily): string {
    switch (family) {
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

function SectionTabBar(props: Readonly<{
    families: readonly SectionFamily[];
    activeFamily: SectionFamily;
    onSelect: (family: SectionFamily) => void;
    testID: string;
}>): React.ReactElement {
    return (
        <View style={stylesheet.sectionBar}>
            <ScrollView
                testID={`${props.testID}-sections`}
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={stylesheet.sectionBarContent}
            >
                {props.families.map((family) => {
                    const active = family === props.activeFamily;
                    return (
                        <Pressable
                            key={family}
                            testID={`${props.testID}-tab-${family}`}
                            accessibilityRole="tab"
                            accessibilityState={{ selected: active }}
                            onPress={() => props.onSelect(family)}
                            style={[stylesheet.sectionTab, active ? stylesheet.sectionTabActive : null]}
                        >
                            <Text style={[stylesheet.sectionTabText, active ? stylesheet.sectionTabTextActive : null]}>
                                {sectionLabel(family)}
                            </Text>
                        </Pressable>
                    );
                })}
            </ScrollView>
        </View>
    );
}

export function BrowserDiagnosticsDrawer(props: Readonly<{
    diagnostics: BrowserDiagnosticsPanelProjection;
    interaction?: BrowserDiagnosticsInteractionControls;
    testID?: string;
}>): React.ReactElement {
    const testID = props.testID ?? 'browser-diagnostics-drawer';
    const bodyTestID = `${testID}-body`;
    const { theme } = useUnistyles();
    const reducedMotion = useReducedMotionPreference();

    const isHost = props.diagnostics.sourceKind === 'browserDiagnostics';
    const sectionFamilies = React.useMemo<readonly SectionFamily[]>(() => {
        if (!isHost) return [];
        const present = new Set(
            (props.diagnostics as BrowserViewDiagnosticsProjection).families
                .map((family) => family.family)
                .filter(isSectionFamily),
        );
        return SECTION_FAMILY_ORDER.filter((family) => present.has(family));
    }, [isHost, props.diagnostics]);

    const persistenceKey = React.useMemo(() => diagnosticsViewKey(props.diagnostics), [props.diagnostics]);
    const persistedState = drawerStateByDiagnosticsViewKey.get(persistenceKey);
    const [drawerState, setDrawerState] = React.useState<DrawerState>(
        persistedState?.drawerState ?? 'expanded',
    );
    const [activeFamily, setActiveFamily] = React.useState<SectionFamily | null>(
        persistedState?.activeFamily && sectionFamilies.includes(persistedState.activeFamily)
            ? persistedState.activeFamily
            : (sectionFamilies[0] ?? null),
    );

    // Keep the active section valid as the projection's families change (a new
    // navigation generation may drop the previously-selected family). Never
    // remount the body — only repoint the selection.
    React.useEffect(() => {
        if (sectionFamilies.length === 0) {
            if (activeFamily !== null) setActiveFamily(null);
            return;
        }
        if (activeFamily === null || !sectionFamilies.includes(activeFamily)) {
            setActiveFamily(sectionFamilies[0] ?? null);
        }
    }, [activeFamily, sectionFamilies]);

    React.useEffect(() => {
        drawerStateByDiagnosticsViewKey.set(persistenceKey, { drawerState, activeFamily });
    }, [activeFamily, drawerState, persistenceKey]);

    const animatedHeight = useSharedValue(bodyHeightForState('expanded'));

    React.useEffect(() => {
        const target = bodyHeightForState(drawerState);
        if (reducedMotion) {
            animatedHeight.value = target;
            return;
        }
        animatedHeight.value = withTiming(target, TIMING_CONFIG);
    }, [animatedHeight, drawerState, reducedMotion]);

    React.useEffect(() => () => {
        cancelAnimation(animatedHeight);
    }, [animatedHeight]);

    const bodyAnimatedStyle = useAnimatedStyle(() => ({
        height: animatedHeight.value,
    }), []);

    const bodyDiagnostics = React.useMemo<BrowserDiagnosticsPanelProjection>(() => {
        if (!isHost || activeFamily === null) {
            return props.diagnostics;
        }
        return projectionForSection(props.diagnostics as BrowserViewDiagnosticsProjection, activeFamily);
    }, [activeFamily, isHost, props.diagnostics]);

    const bodyInteractionSurface: BrowserDiagnosticsInteractionSurface | undefined = (
        activeFamily === CONSOLE_SECTION
            ? 'console'
            : activeFamily === ELEMENTS_SECTION
                ? 'elements'
                : undefined
    );
    const bodyInteraction = isHost && bodyInteractionSurface
        ? props.interaction
        : undefined;

    const bodyVisible = drawerState !== 'closed';

    return (
        <View testID={`${testID}-container-${drawerState}`} style={stylesheet.root}>
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
                            iconSize={16}
                            onPress={() => setDrawerState('closed')}
                        />
                    </>
                )}
            </View>

            {bodyVisible && isHost && activeFamily !== null ? (
                <SectionTabBar
                    testID={testID}
                    families={sectionFamilies}
                    activeFamily={activeFamily}
                    onSelect={setActiveFamily}
                />
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
