import * as React from 'react';
import { Animated, Platform, View } from 'react-native';
import { useLocalSearchParams } from '@/components/appShell/workspace/destinationRoute';
import { useDestinationInstanceKey } from '@/components/appShell/workspace/DestinationInstanceHost';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { t } from '@/text';
import { Item, type ItemProps } from '@/components/ui/lists/Item';
import { usePopoverScrollSourceRef } from '@/components/ui/popover';
import { useLayoutMaxWidth } from '@/components/ui/layout/layout';
import { resolveItemGroupContentHorizontalInsetPx } from '@/components/ui/lists/itemGroupSpacing';
import { PAGE_LIST_METRICS } from '@/components/ui/lists/pageListMetrics';
import { ItemRevealContext } from '@/components/ui/lists/ItemRevealContext';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { SETTING_ANCHOR_QUERY_PARAM, type SettingRef, type SettingsSectionRef } from '@/components/settings/catalog/settingDeclarations';

/** How long the row stays marked after search opens it (two gentle pulses). */
const REVEAL_PULSE_MS = 650;
/** Lets the page lay out before the reveal scrolls to it. */
const REVEAL_DELAY_MS = 250;

/**
 * Requested anchors whose row is mounted right now. A `SettingSection` holding the requested setting
 * asks here whether the page rendered the row; only the requested row ever registers.
 */
const mountedRequestedAnchors = new Map<string, number>();
const requestedAnchorListeners = new Map<string, Set<() => void>>();

function notifyRequestedAnchorListeners(registrationKey: string) {
    for (const listener of requestedAnchorListeners.get(registrationKey) ?? []) listener();
}

function useRequestedAnchorMounted(registrationKey: string): boolean {
    const subscribe = React.useCallback((listener: () => void) => {
        const listeners = requestedAnchorListeners.get(registrationKey) ?? new Set<() => void>();
        listeners.add(listener);
        requestedAnchorListeners.set(registrationKey, listeners);
        return () => {
            listeners.delete(listener);
            if (listeners.size === 0) requestedAnchorListeners.delete(registrationKey);
        };
    }, [registrationKey]);
    const getSnapshot = React.useCallback(() => mountedRequestedAnchors.has(registrationKey), [registrationKey]);
    return React.useSyncExternalStore(subscribe, getSnapshot, () => false);
}

function useAnchorRegistrationKey(anchor: string | null): string {
    return JSON.stringify([useDestinationInstanceKey(), anchor]);
}

function useRegisterRequestedAnchor(anchor: string, isTarget: boolean) {
    const registrationKey = useAnchorRegistrationKey(anchor);
    React.useEffect(() => {
        if (!isTarget) return;
        const wasMounted = mountedRequestedAnchors.has(registrationKey);
        mountedRequestedAnchors.set(registrationKey, (mountedRequestedAnchors.get(registrationKey) ?? 0) + 1);
        if (!wasMounted) notifyRequestedAnchorListeners(registrationKey);
        return () => {
            const count = (mountedRequestedAnchors.get(registrationKey) ?? 1) - 1;
            if (count > 0) mountedRequestedAnchors.set(registrationKey, count);
            else {
                mountedRequestedAnchors.delete(registrationKey);
                notifyRequestedAnchorListeners(registrationKey);
            }
        };
    }, [registrationKey, isTarget]);
}

/**
 * Scrolls the host into view and pulses its overlay twice once `active` turns on (after `delayMs`);
 * under reduced motion it marks it briefly without animation.
 */
function useSettingReveal(active: boolean, delayMs: number) {
    const reducedMotion = useReducedMotionPreference();
    const scrollSourceRef = usePopoverScrollSourceRef();
    const hostRef = React.useRef<View>(null);
    const highlight = React.useRef(new Animated.Value(0)).current;

    React.useEffect(() => {
        if (!active) return;
        const timer = setTimeout(() => {
            const node = hostRef.current as unknown as {
                scrollIntoView?: (options: Readonly<{ block: 'center'; behavior: 'auto' | 'smooth' }>) => void;
                measureLayout?: (relativeTo: unknown, onSuccess: (x: number, y: number) => void, onFail: () => void) => void;
            } | null;
            if (Platform.OS === 'web') {
                node?.scrollIntoView?.({ block: 'center', behavior: reducedMotion ? 'auto' : 'smooth' });
            } else {
                const scroll = scrollSourceRef?.current as { scrollTo?: (options: Readonly<{ y: number; animated: boolean }>) => void; getInnerViewNode?: () => unknown } | null | undefined;
                node?.measureLayout?.(scroll?.getInnerViewNode?.() ?? scroll, (_x, y) => {
                    scroll?.scrollTo?.({ y: Math.max(0, y - 120), animated: !reducedMotion });
                }, () => {});
            }
            if (reducedMotion) {
                highlight.setValue(1);
                Animated.timing(highlight, { toValue: 0, duration: 0, delay: REVEAL_PULSE_MS * 2, useNativeDriver: false }).start();
                return;
            }
            Animated.sequence([
                Animated.timing(highlight, { toValue: 1, duration: REVEAL_PULSE_MS / 2, useNativeDriver: false }),
                Animated.timing(highlight, { toValue: 0.25, duration: REVEAL_PULSE_MS / 2, useNativeDriver: false }),
                Animated.timing(highlight, { toValue: 1, duration: REVEAL_PULSE_MS / 2, useNativeDriver: false }),
                Animated.timing(highlight, { toValue: 0, duration: REVEAL_PULSE_MS, useNativeDriver: false }),
            ]).start();
        }, delayMs);
        return () => clearTimeout(timer);
    }, [active, delayMs, highlight, reducedMotion, scrollSourceRef]);

    return { hostRef, highlight };
}

function RevealOverlay(props: Readonly<{ highlight: Animated.Value; testID: string; shape?: 'row' | 'section' }>) {
    const { theme } = useUnistyles();
    return (
        <Animated.View
            testID={props.testID}
            pointerEvents="none"
            style={[
                StyleSheet.absoluteFill,
                styles.highlight,
                props.shape === 'section' ? styles.sectionHighlight : null,
                { borderColor: theme.colors.state.info.border, backgroundColor: theme.colors.state.info.background, opacity: props.highlight },
            ]}
        />
    );
}

export type SettingRowProps = Omit<ItemProps, 'title' | 'subtitle'> & Readonly<{
    setting: SettingRef;
    /** Overrides the declared description, e.g. a live value summary. */
    subtitle?: ItemProps['subtitle'];
}>;

/**
 * A settings row whose label comes from its page declaration, so search finds exactly what the row
 * shows. Revealing it from search is `SettingAnchor`'s job.
 */
export const SettingRow = React.memo(function SettingRow(props: SettingRowProps) {
    const { setting, subtitle, showDivider, ...itemProps } = props;
    return (
        <SettingAnchor setting={setting} showDivider={showDivider}>
            <Item
                {...itemProps}
                showDivider={showDivider}
                title={setting.title ?? t(setting.titleKey)}
                subtitle={subtitle ?? setting.description ?? (setting.descriptionKey ? t(setting.descriptionKey) : undefined)}
            />
        </SettingAnchor>
    );
});

/**
 * The anchor search asked this page to reveal (`?setting=<anchor>`), if any. Private to this module:
 * rows and sections expose their reveal scope to disclosures. Route/virtualized owners may ask
 * through `useSettingRevealRequested` when they must first bring an anchor into the rendered tree.
 */
function useRequestedSettingAnchor(): string | null {
    const params: Readonly<Record<string, string | string[] | undefined>> = useLocalSearchParams();
    const requested = params[SETTING_ANCHOR_QUERY_PARAM];
    return (Array.isArray(requested) ? requested[0] : requested) ?? null;
}

/**
 * Whether search asked this page to reveal one of `settings`. For route selection or virtualized
 * scrolling; disclosures consume their enclosing anchor/section scope automatically.
 */
export function useSettingRevealRequested(settings: readonly Pick<SettingRef, 'anchor'>[]): boolean {
    const requested = useRequestedSettingAnchor();
    return requested !== null && settings.some((setting) => setting.anchor === requested);
}

/**
 * Marks the row that renders a declared setting. When search opens the page for it
 * (`?setting=<anchor>`), it scrolls into view and pulses twice; under reduced motion it is marked
 * briefly without animation. Wrap rows whose `Item` is built elsewhere (a `DropdownMenu` trigger) with
 * this, passing the declaration's `titleKey` as their title. `ItemGroup` injects `showDivider` into its
 * direct children, so it is forwarded to the wrapped row.
 * For a disclosure whose rows are not mounted yet, `settings` declares only its reveal scope: it
 * neither registers those rows as mounted nor adds a second scroll/highlight host.
 */
type SettingAnchorProps = Readonly<{
    children: React.ReactElement;
    showDivider?: boolean;
}> & (Readonly<{
    setting: SettingRef;
    settings?: never;
}> | Readonly<{
    /** A group that holds these settings, even while its disclosure has not mounted their rows. */
    settings: readonly Pick<SettingRef, 'anchor'>[];
    setting?: never;
}>);

export const SettingAnchor = React.memo(function SettingAnchor(props: SettingAnchorProps) {
    const requested = useRequestedSettingAnchor();
    // A fragment of rows has no divider of its own; only a single row takes the section's divider.
    const child = props.showDivider === undefined || props.children.type === React.Fragment
        ? props.children
        : React.cloneElement(props.children as React.ReactElement<{ showDivider?: boolean }>, { showDivider: props.showDivider });
    const isTarget = requested !== null && (props.setting
        ? props.setting.anchor === requested
        : props.settings.some((setting) => setting.anchor === requested));
    return <ItemRevealContext.Provider value={isTarget ? requested : null}>
        {props.setting ? <SettingAnchorHost setting={props.setting} isTarget={isTarget}>{child}</SettingAnchorHost> : child}
    </ItemRevealContext.Provider>;
});

function SettingAnchorHost(props: Readonly<{
    setting: SettingRef;
    isTarget: boolean;
    children: React.ReactElement;
}>) {
    const { setting, isTarget } = props;
    useRegisterRequestedAnchor(setting.anchor, isTarget);
    const { hostRef, highlight } = useSettingReveal(isTarget, REVEAL_DELAY_MS);

    return (
        <View ref={hostRef} nativeID={`setting-${setting.anchor}`} style={styles.host}>
            {props.children}
            {isTarget ? <RevealOverlay highlight={highlight} testID={`setting-reveal.${setting.anchor}`} /> : null}
        </View>
    );
}

/**
 * Wraps a declared section (its `ItemGroup`). When search asks for one of the section's settings and
 * the page does not render that row right now (it waits on another setting, a machine or a feature),
 * the section is revealed instead: its own state line says what the row needs, so the user never
 * lands on a page with nothing marked.
 */
export const SettingSection = React.memo(function SettingSection(props: Readonly<{
    section: SettingsSectionRef;
    /**
     * Sections that are not rendered in the page's current state and whose rows this section explains
     * (the overlay switch for the overlay's other sections, the machine chooser for machine rows).
     */
    answersFor?: readonly SettingsSectionRef[];
    children: React.ReactNode;
}>) {
    const requested = useRequestedSettingAnchor();
    const registrationKey = useAnchorRegistrationKey(requested);
    const rowMounted = useRequestedAnchorMounted(registrationKey);
    const holdsRequested = requested !== null && (
        props.section.settingAnchors.includes(requested)
        || (props.answersFor ?? []).some((other) => other.settingAnchors.includes(requested))
    );
    const [rowMissing, setRowMissing] = React.useState(false);

    React.useEffect(() => {
        if (!holdsRequested || requested === null || rowMounted) {
            setRowMissing(false);
            return;
        }
        // Checked when the row itself would reveal, after the page's first layout.
        const timer = setTimeout(() => setRowMissing(!mountedRequestedAnchors.has(registrationKey)), REVEAL_DELAY_MS);
        return () => clearTimeout(timer);
    }, [holdsRequested, requested, registrationKey, rowMounted]);

    const { hostRef, highlight } = useSettingReveal(rowMissing, 0);
    // The section's column (as `ItemGroup` lays it out), so the mark follows its sheet edges.
    const maxWidth = useLayoutMaxWidth();
    return (
        <View style={styles.sectionWrapper}>
            <View ref={hostRef} nativeID={`setting-section-${props.section.id}`} style={[styles.sectionColumn, { maxWidth }]}>
                <ItemRevealContext.Provider value={holdsRequested ? requested : null}>
                    {props.children}
                </ItemRevealContext.Provider>
                {rowMissing ? <RevealOverlay highlight={highlight} testID={`setting-reveal.${props.section.id}`} shape="section" /> : null}
            </View>
        </View>
    );
});

const styles = StyleSheet.create(() => ({
    host: {
        position: 'relative',
    },
    highlight: {
        borderWidth: 1.5,
    },
    sectionWrapper: {
        alignItems: 'center',
    },
    sectionColumn: {
        position: 'relative',
        width: '100%',
    },
    sectionHighlight: {
        left: resolveItemGroupContentHorizontalInsetPx(),
        right: resolveItemGroupContentHorizontalInsetPx(),
        borderRadius: PAGE_LIST_METRICS.sheetRadiusPx,
    },
}));
