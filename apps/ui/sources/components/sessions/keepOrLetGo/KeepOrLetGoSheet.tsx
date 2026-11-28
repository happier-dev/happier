import * as React from 'react';
import { View } from 'react-native';
import { useRouter } from 'expo-router';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useShallow } from 'zustand/react/shallow';

import { Icon } from '@/components/ui/icons/Icon';
import { CenteredInfoTile } from '@/components/ui/lists/CenteredInfoTile';
import { reanimatedMotionTokens as motionTokens } from '@/components/ui/motion/reanimatedMotionTokens';
import { StoryDeckFooterActions } from '@/components/ui/storyDeck/StoryDeckFooterActions';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { Modal } from '@/modal';
import { ModalCardFrame } from '@/modal/components/card/ModalCardFrame';
import type { CustomModalInjectedProps } from '@/modal/types';
import { writeLeavingFootDismissal } from '@/sync/domains/session/retention/leavingFootDismissal';
import {
    getLeavingSessionsEntry,
    refreshLeavingSessions,
} from '@/sync/domains/session/retention/leavingSessionsResource';
import { storage } from '@/sync/domains/state/storage';
import type { StorageState } from '@/sync/store/types';
import { t } from '@/text';
import { getSessionName } from '@/utils/sessions/sessionUtils';
import { fireAndForget } from '@/utils/system/fireAndForget';

import { KeepStack, type KeepStackItem, type KeepStackOutcome } from './KeepStack';
import { formatAllSetSummary, formatLeavingDate, movedSessionsTabLabel } from './keepOrLetGoCopy';
import { keepLeavingSession } from './keepOrLetGoActions';
import { decideLocalHistoryKeep, readLocalHistoryPreview, type LocalHistoryKeepItem } from './localHistoryKeepSource';
import {
    projectLeavingSessionsView,
    selectPinnedLeavingKey,
    type LeavingSessionsView,
} from './leavingSessionsView';

/**
 * Keep or let go, for the sessions leaving Happier Cloud (plan 04 F9).
 *
 * Opening reads the leaving list once and freezes that batch for the walk: Keep pins (one pin
 * write), Let go writes nothing because the server moves the session on its date, and the summary
 * says what happens next. Finishing records the batch on this device so the foot stops asking.
 */

const PLAN_ROUTE = '/settings/plan';

type SheetState =
    | Readonly<{ kind: 'loading' }>
    | Readonly<{ kind: 'error' }>
    | Readonly<{ kind: 'ready'; view: LeavingSessionsView | null }>;

const stylesheet = StyleSheet.create((theme) => ({
    // The card frame's body has no inset of its own; the sheet keeps the card and its buttons off
    // the frame edge, the same 16 as the other plans sheets.
    body: {
        gap: 16,
        paddingHorizontal: 16,
        paddingTop: 12,
        paddingBottom: 16,
    },
    skeleton: {
        height: 196,
        borderRadius: 16,
        backgroundColor: theme.colors.surface.inset,
    },
    message: {
        ...Typography.rowMeta(),
        color: theme.colors.text.secondary,
    },
    preview: {
        ...Typography.body(),
        color: theme.colors.text.secondary,
        borderLeftWidth: 2,
        borderLeftColor: theme.colors.border.default,
        paddingLeft: 12,
    },
    check: {
        width: 48,
        height: 48,
        borderRadius: 24,
        alignItems: 'center',
        justifyContent: 'center',
        borderWidth: 1.5,
        borderColor: theme.colors.border.default,
        marginBottom: 12,
    },
}));

/** The last thing the agent said, so a card is recognisable without opening it. Top two cards only. */
const LeavingSessionPreview = React.memo(function LeavingSessionPreview(props: Readonly<{ sessionId: string }>) {
    const styles = stylesheet;
    const known = storage((state: StorageState) => Boolean(state.sessions[props.sessionId] ?? state.sessionListRenderables[props.sessionId]));
    const summary = storage((state: StorageState) => (
        state.sessions[props.sessionId]?.metadata?.summary?.text
        ?? state.sessionListRenderables[props.sessionId]?.metadata?.summaryText
        ?? null
    ));
    React.useEffect(() => {
        if (known) return;
        // The list is paged, so an old leaving session may not be held yet: hydrate (fetch and
        // decrypt) this one card through the canonical by-id path.
        fireAndForget((async () => {
            const { sync } = await import('@/sync/sync');
            await sync.ensureSessionVisibleForMessageRoute(props.sessionId);
        })(), { tag: 'KeepOrLetGoSheet.hydratePreview' });
    }, [known, props.sessionId]);
    if (!summary) return <View testID={`keep-or-let-go-preview-${props.sessionId}`} />;
    return (
        <Text testID={`keep-or-let-go-preview-${props.sessionId}`} style={styles.preview} numberOfLines={4}>
            {summary}
        </Text>
    );
});

function renderLeavingPreview(item: KeepStackItem): React.ReactNode {
    return <LeavingSessionPreview sessionId={item.id} />;
}

function AllSet(props: Readonly<{ summary: string; onDone: () => void }>) {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const reducedMotion = useReducedMotionPreference();
    const progress = useSharedValue(reducedMotion ? 1 : 0);
    React.useEffect(() => {
        if (reducedMotion) return;
        progress.value = withTiming(1, { duration: motionTokens.durationMs.slow, easing: motionTokens.easing.standard });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    const checkStyle = useAnimatedStyle(() => ({
        opacity: progress.value,
        transform: [{ scale: 0.6 + progress.value * 0.4 }],
    }));
    return (
        <View testID="keep-or-let-go-all-set">
            <CenteredInfoTile
                paddingHorizontal={0}
                icon={(
                    <Animated.View style={[styles.check, checkStyle]}>
                        <Icon name="check" size={24} color={theme.colors.text.primary} />
                    </Animated.View>
                )}
                title={t('keepOrLetGo.allSetTitle')}
                description={props.summary}
                descriptionTestID="keep-or-let-go-summary"
            />
            <StoryDeckFooterActions
                isLastSlide
                primaryLabel={t('common.done')}
                onPrimary={props.onDone}
                testID="keep-or-let-go-done"
            />
        </View>
    );
}

function readLeavingSheetState(): SheetState {
    const entry = getLeavingSessionsEntry();
    if (entry.status === 'error' || entry.status === 'idle' || entry.status === 'loading') return { kind: 'error' };
    const data = entry.status === 'off' ? null : entry.data;
    const pinnedKey = selectPinnedLeavingKey(storage.getState(), entry.serverId, data?.sessions ?? []);
    return { kind: 'ready', view: projectLeavingSessionsView(entry.serverId, data, pinnedKey) };
}

function useLeavingItems(view: LeavingSessionsView | null): readonly KeepStackItem[] {
    const sessions = view?.sessions;
    // One string per card: its title and machine line. `useShallow` keeps the array while they are
    // unchanged, so unrelated session arrivals rebuild nothing.
    // Leaving sessions are old, so the list usually holds them as rows, not full sessions.
    const lines = storage(useShallow((state: StorageState) => (sessions ?? []).map((leaving) => {
        const session = state.sessions[leaving.id] ?? state.sessionListRenderables[leaving.id];
        if (!session) return '';
        const lastActive = formatLeavingDate(Math.max(session.updatedAt, session.activeAt), Date.now());
        const host = session.metadata?.host ?? '';
        const lastActiveLine = t('keepOrLetGo.cardLastActive', { date: lastActive });
        return `${getSessionName(session)}\n${host ? `${host} · ${lastActiveLine}` : lastActiveLine}`;
    })));
    return React.useMemo(() => {
        if (!sessions) return [];
        const nowMs = Date.now();
        const tab = movedSessionsTabLabel();
        return sessions.map((leaving, index) => {
            const [title, subtitle] = (lines[index] ?? '').split('\n');
            return {
                id: leaving.id,
                title: title || t('status.unknown'),
                subtitle: subtitle ?? null,
                meta: t('keepOrLetGo.cardLeaves', { date: formatLeavingDate(leaving.leavesAt, nowMs), tab }),
            };
        });
    }, [lines, sessions]);
}

/**
 * A Developer-Mode preview batch: the sheet walks these cards exactly as it would a real batch, but
 * reads nothing, pins nothing and records no dismissal.
 */
export type KeepOrLetGoPreview = Readonly<{
    retentionDays: number;
    sessions: ReadonlyArray<Readonly<{ id: string; title: string; subtitle: string | null; leavesAt: number }>>;
}>;

export type KeepOrLetGoSheetProps = CustomModalInjectedProps & Readonly<{ preview?: KeepOrLetGoPreview }>;

const PREVIEW_SERVER_ID = 'preview';

function previewView(preview: KeepOrLetGoPreview): LeavingSessionsView {
    const sessions = preview.sessions.map((session) => ({ id: session.id, leavesAt: session.leavesAt }));
    return {
        serverId: PREVIEW_SERVER_ID,
        rule: { retentionDays: preview.retentionDays, noticeDays: 7, floorAt: 0 },
        sessions,
        leavesAtById: new Map(sessions.map((session) => [session.id, session.leavesAt])),
        count: sessions.length,
        soonestLeavesAt: sessions[0]?.leavesAt ?? 0,
        newestLeavesAt: sessions[sessions.length - 1]?.leavesAt ?? 0,
    };
}

function previewItems(preview: KeepOrLetGoPreview): readonly KeepStackItem[] {
    const nowMs = Date.now();
    const tab = movedSessionsTabLabel();
    return preview.sessions.map((session) => ({
        id: session.id,
        title: session.title,
        subtitle: session.subtitle,
        meta: t('keepOrLetGo.cardLeaves', { date: formatLeavingDate(session.leavesAt, nowMs), tab }),
    }));
}

const keepInPreview = () => Promise.resolve({ ok: true as const });

export function KeepOrLetGoSheet(props: KeepOrLetGoSheetProps) {
    const styles = stylesheet;
    const router = useRouter();
    const plansEnabled = useFeatureEnabled('plans');
    const { preview } = props;
    const [state, setState] = React.useState<SheetState>(() => (
        preview ? { kind: 'ready', view: previewView(preview) } : { kind: 'loading' }
    ));
    const [outcome, setOutcome] = React.useState<KeepStackOutcome | null>(null);
    const { onClose } = props;

    const load = React.useCallback(() => {
        if (preview) return;
        setState({ kind: 'loading' });
        fireAndForget(refreshLeavingSessions().then(() => setState(readLeavingSheetState())), {
            tag: 'KeepOrLetGoSheet.load',
        });
    }, [preview]);
    React.useEffect(load, [load]);

    const view = state.kind === 'ready' ? state.view : null;
    const leavingItems = useLeavingItems(preview ? null : view);
    const items = React.useMemo(() => (preview ? previewItems(preview) : leavingItems), [leavingItems, preview]);

    const plansAction = React.useMemo(() => (plansEnabled ? {
        label: t('keepOrLetGo.getPlus'),
        onPress: () => {
            onClose();
            router.push(PLAN_ROUTE);
        },
    } : null), [onClose, plansEnabled, router]);

    const handleKeep = React.useCallback((item: KeepStackItem) => {
        if (!view) return Promise.resolve({ ok: false as const, message: t('errors.unknownError') });
        return keepLeavingSession({ serverId: view.serverId, sessionId: item.id, plansAction });
    }, [plansAction, view]);

    const handleDone = React.useCallback(() => {
        if (view && !preview) writeLeavingFootDismissal(view.serverId, { leavingThrough: view.newestLeavesAt });
        onClose();
    }, [onClose, preview, view]);

    let body: React.ReactNode;
    if (state.kind === 'loading') {
        body = <View style={styles.skeleton} testID="keep-or-let-go-loading" />;
    } else if (state.kind === 'error') {
        body = (
            <View style={{ gap: 12 }}>
                <Text style={styles.message}>{t('keepOrLetGo.loadFailed')}</Text>
                <RoundButton size="small" display="inverted" title={t('common.retry')} onPress={load} testID="keep-or-let-go-retry" />
            </View>
        );
    } else if (outcome || !view) {
        const leavesAtById = view?.leavesAtById;
        body = (
            <AllSet
                summary={formatAllSetSummary({
                    kept: outcome?.kept.length ?? 0,
                    letGoLeavesAt: (outcome?.letGo ?? []).map((item) => leavesAtById?.get(item.id) ?? Date.now()),
                    nowMs: Date.now(),
                })}
                onDone={handleDone}
            />
        );
    } else {
        body = (
            <KeepStack
                items={items}
                onKeep={preview ? keepInPreview : handleKeep}
                onComplete={setOutcome}
                // A preview's sessions are not real, so there is no last message to hydrate.
                renderPreview={preview ? undefined : renderLeavingPreview}
                keepHint={t('keepOrLetGo.keepHint')}
                letGoHint={t('keepOrLetGo.letGoHint', { tab: movedSessionsTabLabel() })}
                testID="keep-or-let-go-stack"
            />
        );
    }

    // The walk has a header that names the batch; loading, failure and All set speak for themselves.
    const walking = view !== null && outcome === null;
    return (
        <ModalCardFrame
            testID="keep-or-let-go-sheet"
            size="md"
            onClose={onClose}
            title={walking ? t('keepOrLetGo.sheetTitle', { count: view.count }) : undefined}
            subtitle={walking ? t('keepOrLetGo.sheetSubtitle', { days: view.rule.retentionDays }) : undefined}
        >
            <View style={styles.body}>{body}</View>
        </ModalCardFrame>
    );
}

export function showKeepOrLetGoSheet(): void {
    Modal.show({ component: KeepOrLetGoSheet });
}

type LocalHistorySheetProps = CustomModalInjectedProps & Readonly<{
    items: readonly LocalHistoryKeepItem[];
    onSaved?: (id: string) => void;
}>;

function LocalHistoryKeepPreview(props: Readonly<{ load: () => Promise<string | null> }>) {
    const [text, setText] = React.useState<string | null>(null);
    const { load } = props;
    React.useEffect(() => {
        let active = true;
        fireAndForget(load().then((value) => { if (active) setText(value); }), { tag: 'KeepOrLetGoSheet.localPreview' });
        return () => { active = false; };
    }, [load]);
    return text ? <Text style={stylesheet.preview} numberOfLines={4}>{text}</Text> : null;
}

function LocalHistoryKeepOrLetGoSheet({ items, onClose, onSaved }: LocalHistorySheetProps) {
    const [outcome, setOutcome] = React.useState<KeepStackOutcome | null>(null);
    const itemsById = React.useMemo(() => new Map(items.map((item) => [item.id, item])), [items]);
    const stackItems = React.useMemo(() => items.map((item): KeepStackItem => {
        const now = Date.now();
        const expiry = t('keepOrLetGo.rowLeaves', { date: formatLeavingDate(item.leavesAt, now) });
        const lastActive = item.activityMs === undefined ? null : t('keepOrLetGo.cardLastActive', { date: formatLeavingDate(item.activityMs, now) });
        return {
            id: item.id,
            title: t('keepOrLetGo.localSessionLabel', { id: item.remoteSessionId.slice(0, 8) }),
            subtitle: [item.target.machineName, lastActive].filter(Boolean).join(' · '),
            meta: `${expiry} · ${t('keepOrLetGo.localKeepFor', { days: item.retentionDays })}`,
        };
    }), [items]);

    const decide = React.useCallback(async (card: KeepStackItem, operation: 'keep' | 'letGo') => {
        const item = itemsById.get(card.id);
        if (!item) return { ok: false as const, message: t('errors.unknownError') };
        const result = await decideLocalHistoryKeep(item, operation);
        if (!result.ok) return { ok: false as const, message: t('errors.unknownError') };
        if (!result.due?.some((next) => next.remoteSessionId === item.remoteSessionId && next.projectId === item.projectId)) {
            onSaved?.(item.id);
        }
        return { ok: true as const };
    }, [itemsById, onSaved]);
    const onKeep = React.useCallback((item: KeepStackItem) => decide(item, 'keep'), [decide]);
    const onLetGo = React.useCallback((item: KeepStackItem) => decide(item, 'letGo'), [decide]);

    const previews = React.useRef(new Map<string, Promise<string | null>>());
    const renderPreview = React.useCallback((card: KeepStackItem) => {
        const item = itemsById.get(card.id);
        if (!item) return null;
        return <LocalHistoryKeepPreview load={() => {
            const existing = previews.current.get(item.id);
            if (existing) return existing;
            const pending = readLocalHistoryPreview(item);
            previews.current.set(item.id, pending);
            return pending;
        }} />;
    }, [itemsById]);

    return <ModalCardFrame
        testID="keep-or-let-go-sheet"
        size="md"
        onClose={onClose}
        title={outcome ? undefined : t('keepOrLetGo.localLeaving', { count: items.length })}
    >
        <View style={stylesheet.body}>
            {outcome ? <AllSet summary={t('keepOrLetGo.localDecisionsSaved')} onDone={onClose} /> : <KeepStack
                items={stackItems}
                onKeep={onKeep}
                onLetGo={onLetGo}
                onComplete={setOutcome}
                renderPreview={renderPreview}
                letGoHint={t('keepOrLetGo.localLetGoHint')}
                testID="keep-or-let-go-stack"
            />}
        </View>
    </ModalCardFrame>;
}

export function showLocalHistoryKeepOrLetGoSheet(items: readonly LocalHistoryKeepItem[], onSaved?: (id: string) => void): void {
    if (items.length === 0) return;
    Modal.show({ component: LocalHistoryKeepOrLetGoSheet, props: { items, onSaved } });
}

/** Developer Mode: the sheet over a sample batch, with nothing read or written. */
export function showKeepOrLetGoPreview(preview: KeepOrLetGoPreview): void {
    Modal.show({ component: KeepOrLetGoSheet, props: { preview } });
}
