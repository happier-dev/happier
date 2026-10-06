import * as React from 'react';
import { Platform, View, type StyleProp, type ViewStyle } from 'react-native';
import Animated, { useAnimatedStyle } from 'react-native-reanimated';
import { useUnistyles } from 'react-native-unistyles';
import type { HappierDropVerdict } from '@happier-dev/plugin-ui/presentation';
import type { EntityDragItemV1 } from '@happier-dev/protocol/plugins/ui';

import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { t } from '@/text';

import type { EntityDragDropRuntime } from '../entityDragDropTypes';
import { describeEntityDropSettled } from './entityDropOutcome';
import { useTreeDropFlashHighlight } from './useTreeDropFlashHighlight';

/**
 * The lasting line a late refusal leaves under its source (DnD lab ST4): after the carried card
 * springs home, the row flashes once and keeps one quiet line that names the verb, the target and the
 * owner's reason ("Couldn't put Review #2481 under Fix settings modal remount · This session was just
 * moved. Try again"). An unknown result says so in the same line; nothing blocks with an alert.
 *
 * The runtime's settled verdict ends with its feedback; this keeps only its words, in a per-realm
 * presentation store, until the person's next interaction: the next carry anywhere, or (web) the
 * next press or key in the window. Touch has no window-wide signal, so the line offers Dismiss there.
 */

type SettledNotice = Readonly<{
    sourceId: string;
    item: EntityDragItemV1;
    itemTitle: string | null;
    verdict: HappierDropVerdict;
}>;

type SettledNoticeStore = Readonly<{
    get: () => SettledNotice | null;
    subscribe: (listener: () => void) => () => void;
    dismiss: () => void;
}>;

const stores = new WeakMap<EntityDragDropRuntime, SettledNoticeStore>();
const DISMISS_EVENTS = ['pointerdown', 'keydown'] as const;

function createSettledNoticeStore(runtime: EntityDragDropRuntime): SettledNoticeStore {
    let notice: SettledNotice | null = null;
    const listeners = new Set<() => void>();
    // The carried item's name, read while its source is still registered.
    let carried: Readonly<{ sourceId: string; title: string | null }> | null = null;
    let windowTarget: EventTarget | null = null;
    const onInteraction = () => set(null);
    const listen = (next: boolean) => {
        const target = typeof window === 'undefined' ? null : window as unknown as EventTarget;
        if (next && target && !windowTarget) {
            windowTarget = target;
            for (const type of DISMISS_EVENTS) windowTarget.addEventListener(type, onInteraction, true);
        } else if (!next && windowTarget) {
            for (const type of DISMISS_EVENTS) windowTarget.removeEventListener(type, onInteraction, true);
            windowTarget = null;
        }
    };
    const set = (next: SettledNotice | null) => {
        if (notice === next) return;
        notice = next;
        listen(next !== null);
        for (const listener of [...listeners]) listener();
    };
    runtime.subscribe(() => {
        const snapshot = runtime.getSnapshot();
        if ((snapshot.phase === 'carrying' || snapshot.phase === 'pending') && snapshot.sourceId) {
            if (snapshot.phase === 'carrying' && notice) set(null);
            if (carried?.sourceId !== snapshot.sourceId) carried = { sourceId: snapshot.sourceId, title: runtime.describeSource(snapshot.sourceId)?.title ?? null };
            return;
        }
        if (snapshot.phase !== 'settled' || !snapshot.sourceId || !snapshot.item) return;
        const verdict: HappierDropVerdict = { phase: snapshot.phase, admission: snapshot.admission, outcome: snapshot.outcome };
        if (!describeEntityDropSettled(verdict)) return;
        const title = runtime.describeSource(snapshot.sourceId)?.title
            ?? (carried?.sourceId === snapshot.sourceId ? carried.title : null);
        set({ sourceId: snapshot.sourceId, item: snapshot.item, itemTitle: title, verdict });
    });
    return { get: () => notice, subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, dismiss: () => set(null) };
}

function settledNotices(runtime: EntityDragDropRuntime): SettledNoticeStore {
    let store = stores.get(runtime);
    if (!store) {
        store = createSettledNoticeStore(runtime);
        stores.set(runtime, store);
    }
    return store;
}

/** Starts keeping late outcomes for this realm; the realm's feedback host calls it once. */
export function useEntityDropSettledNotices(runtime: EntityDragDropRuntime): void {
    settledNotices(runtime);
}

/** Which source a row is: its registered id, or (for sources prepared per carry) its carried item. */
export type EntityDropSettledMatch = Readonly<{ sourceId?: string; item?: (item: EntityDragItemV1) => boolean }>;

function useSettledNotice(runtime: EntityDragDropRuntime, match: EntityDropSettledMatch): SettledNotice | null {
    const store = settledNotices(runtime);
    const matchRef = React.useRef(match);
    matchRef.current = match;
    // Leaf-only subscription: a row wakes only when its own notice appears or clears.
    return React.useSyncExternalStore(store.subscribe, () => {
        const notice = store.get();
        if (!notice) return null;
        const current = matchRef.current;
        return (current.sourceId !== undefined && current.sourceId === notice.sourceId) || current.item?.(notice.item) === true ? notice : null;
    }, () => null);
}

/** Mounted only while a notice shows, so idle rows carry no animation driver. */
function SettledFlash(props: Readonly<{ style?: StyleProp<ViewStyle> }>): React.ReactElement {
    const { theme } = useUnistyles();
    const flash = useTreeDropFlashHighlight();
    const trigger = flash.trigger;
    // Once, when the line appears: the row answers "it came back here" (and is the reduced-motion cue).
    React.useEffect(() => { trigger(); }, [trigger]);
    const animatedStyle = useAnimatedStyle(() => ({ opacity: flash.progress.value }));
    return (
        <Animated.View
            pointerEvents="none"
            style={[
                { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, backgroundColor: theme.colors.state.active.background },
                props.style,
                animatedStyle,
            ]}
        />
    );
}

export function EntityDropSettledFeedback(props: Readonly<{
    runtime: EntityDragDropRuntime;
    match: EntityDropSettledMatch;
    /** Insets and corner of the row the flash lies over, so its corners coincide with the row's. */
    flashStyle?: StyleProp<ViewStyle>;
    /** Where the line sits under the row (its inset matches the row's content). */
    lineStyle?: StyleProp<ViewStyle>;
    testID?: string;
    children?: React.ReactNode;
}>): React.ReactElement {
    const notice = useSettledNotice(props.runtime, props.match);
    const settled = notice ? describeEntityDropSettled(notice.verdict, notice.itemTitle) : null;
    const outcome = notice?.verdict.outcome;
    const dismiss = settledNotices(props.runtime).dismiss;
    return (
        <View>
            <View>
                {props.children}
                {settled ? <SettledFlash key={notice?.sourceId} style={props.flashStyle} /> : null}
            </View>
            {settled ? (
                <View style={props.lineStyle}>
                    <SurfaceStateCard
                        testID={props.testID ? `${props.testID}-settled` : undefined}
                        size="line"
                        kind={settled.kind === 'refused' ? 'error' : 'warning'}
                        title={settled.title}
                        reason={settled.detail}
                        diagnosticCode={outcome && outcome.status !== 'applied' ? outcome.reason.code : null}
                        accessibilitySemantics="status"
                        {...(Platform.OS === 'web' ? {} : { action: { label: t('entityDragDrop.settled.dismiss'), onPress: dismiss } })}
                    />
                </View>
            ) : null}
        </View>
    );
}
