import * as React from 'react';
import { Platform, View } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withSpring, withTiming } from 'react-native-reanimated';
import { StyleSheet } from 'react-native-unistyles';

import type {
    LocalServiceLaunchTargetV1,
    LocalServicePublicExposureModeV1,
    LocalServicePublicExposureV1,
} from '@happier-dev/protocol';

import { IconButton } from '@/components/ui/buttons/IconButton';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Item } from '@/components/ui/lists/Item';
import { resolveMinimumInteractiveTargetSize } from '@/components/ui/interactiveTargetSize';
import { CopiedPill } from '@/components/ui/copy/CopiedPill';
import { useHappierCopyFeedback } from '@happier-dev/plugin-ui/presentation';
import { INSTRUMENT_SPRINGS, useMotionPreferences } from '@/components/instrument';
import { QRCode } from '@/components/qr/QRCode';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { useLayoutPresentationActive } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { useElapsedTime } from '@/hooks/ui/useElapsedTime';
import { Modal } from '@/modal';
import {
    DEFAULT_LOCAL_SERVICE_PUBLIC_PREVIEW_TTL_MS,
    type LocalServicePublicPreviewActions,
    type LocalServicePublicPreviewActionTarget,
} from '@/components/sessions/localServices/publicPreviewActions';
import {
    selectLocalServicePublicExposureExpiry,
    selectLocalServicePublicPreviewRows,
    selectLocalServicePublicPreviewRowsForPreview,
    type LocalServicePublicPreviewState,
} from '@/sync/domains/local/services/publicPreview/store';
import {
    resolveLocalServicePreviewUnavailableSubtitle,
    resolveLocalServicePublicPreviewCreateDisabledSubtitle,
} from '@/sync/domains/local/services/publicPreview/presentation';
import { t } from '@/text';
import { isActionApprovalRequiredForHome } from '@/sync/domains/settings/actionsSettings';

import { useLocalServiceActionRunner, type LocalServiceActionRunner } from './localServiceActionOutcome';
import type { LocalServiceCapabilityDisabledReasons } from './useLocalServicePublicPreviewFeature';
import {
    showLocalServiceExposureSheet,
    type LocalServiceExposureModeChoice,
    type LocalServiceExposureTtlChoice,
} from './showLocalServiceExposureSheet';

type PublicPreviewTarget = Readonly<{
    target: LocalServicePublicPreviewActionTarget;
    previewId: string | null;
    targetKey: string;
    title: string;
}>;

type PublicPreviewCreatableTarget = PublicPreviewTarget & Readonly<{
    previewId: string;
}>;

type PublicPreviewDisabledTarget = PublicPreviewTarget & Readonly<{
    subtitle: string;
}>;

/** Big enough to scan from a phone held at arm's length, small enough to sit inside a pane row. */
const PUBLIC_LINK_QR_SIZE_PX = 96;

const stylesheet = StyleSheet.create((theme) => ({
    /**
     * The service's public link, inside its expanded row's card (session-tabs lab S): separated from
     * the row's controls by one hairline, drawn on the card's own surface.
     */
    block: {
        borderTopWidth: StyleSheet.hairlineWidth,
        borderTopColor: theme.colors.border.default,
    },
    note: {
        ...Typography.variant('meta'),
        color: theme.colors.text.secondary,
        paddingHorizontal: theme.space.s12,
        paddingBottom: theme.space.s10,
    },
    disabledNote: {
        paddingTop: theme.space.s12,
    },
    reach: {
        flex: 1,
        ...Typography.variant('meta'),
        color: theme.colors.text.secondary,
    },
    qrRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s12,
        paddingHorizontal: theme.space.s12,
        paddingBottom: theme.space.s10,
    },
    qrTile: {
        padding: theme.space.s4,
        borderRadius: 6,
        backgroundColor: theme.colors.surface.base,
    },
    qrHint: {
        flex: 1,
        ...Typography.variant('meta'),
        color: theme.colors.text.secondary,
    },
    /** One issued link: a compact card inside the expansion (lab services O): label and expiry, address, consequence. */
    link: {
        paddingHorizontal: theme.space.s12,
        paddingVertical: theme.space.s12,
        gap: theme.space.s6,
    },
    linkHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: theme.space.s12,
    },
    linkLabel: {
        ...Typography.variant('body', 'semiBold'),
        color: theme.colors.text.primary,
    },
    actionRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s4,
    },
    urlRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s4,
    },
    url: {
        ...Typography.mono(),
        flex: 1,
        minWidth: 0,
        fontSize: 12,
        color: theme.colors.text.secondary,
    },
    linkFooter: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: theme.space.s12,
    },
    /** The share control hosted outside the expansion's action line (the Browser's preview frame). */
    shareRow: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: theme.space.s12,
        paddingVertical: theme.space.s12,
        gap: theme.space.s8,
    },
    /**
     * The countdown's micro role carries tabular numerals, which is what keeps
     * the row from twitching sideways once a second as the digits change width.
     */
    clock: {
        ...({ ...Typography.variant('micro', 'regular'), ...Typography.tabular() }),
        color: theme.colors.text.secondary,
    },
    /**
     * The last minute. Emphasis, not colour: `state.warning.foreground` (#FF9500) sits at ~2.1:1 on
     * `surface.base`, which is below the 4.5:1 floor for text — so the urgent reading gets the
     * PRIMARY text token instead, which raises contrast rather than lowering it.
     */
    clockUrgent: {
        color: theme.colors.text.primary,
    },
}));

function readTargetPreviewId(target: LocalServiceLaunchTargetV1): string | null {
    const browserTarget = target.browserTarget;
    return browserTarget?.kind === 'localServicePreview' && browserTarget.targetId.trim().length > 0
        ? browserTarget.targetId.trim()
        : null;
}

/**
 * Whether a service has anything to say about a public link: a registered preview it can share, or a
 * detected loopback service for which the reason it cannot be shared is worth showing. The row asks
 * this before it offers to expand, so a row never grows into an empty space.
 */
export function hasLocalServicePublicPreviewSurface(target: LocalServiceLaunchTargetV1): boolean {
    return readTargetPreviewId(target) !== null
        || (target.source === 'inventory_entry' && target.browserTarget?.kind === 'externalUrl');
}

function publicPreviewTargets(targets: readonly LocalServiceLaunchTargetV1[]): readonly PublicPreviewTarget[] {
    return targets
        .map((target): PublicPreviewTarget | null => {
            const previewId = readTargetPreviewId(target);
            if (!hasLocalServicePublicPreviewSurface(target)) {
                return null;
            }
            return {
                target,
                previewId,
                targetKey: previewId ?? target.id,
                title: target.title,
            };
        })
        .filter((target): target is PublicPreviewTarget => Boolean(target));
}

function hasPreviewId(target: PublicPreviewTarget): target is PublicPreviewCreatableTarget {
    return typeof target.previewId === 'string' && target.previewId.length > 0;
}

/**
 * Every exposure for a preview that is still worth showing.
 *
 * Deliberately NOT `state === 'active'`. Filtering to active is the §9.1 "Expire" defect: the row
 * simply vanished, and the user could not tell whether the link had expired or someone had revoked
 * it. A revoked one is hidden because the user just revoked it and its disappearance IS the
 * confirmation; everything else stays and says what it is.
 */
function visibleExposuresForPreview(
    state: LocalServicePublicPreviewState,
    previewId: string,
): readonly LocalServicePublicExposureV1[] {
    return selectLocalServicePublicPreviewRowsForPreview(state, previewId)
        .filter((exposure) => exposure.state !== 'revoked');
}

function visibleExposuresForTarget(
    state: LocalServicePublicPreviewState,
    target: PublicPreviewTarget,
): readonly LocalServicePublicExposureV1[] {
    return hasPreviewId(target) ? visibleExposuresForPreview(state, target.previewId) : [];
}

const SECOND_MS = 1_000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** Under this much time left, the row counts down live; above it, a coarse label is honest enough. */
const LIVE_COUNTDOWN_WINDOW_MS = HOUR_MS;

/** Under this much time left, the countdown takes the warning tint. */
const URGENT_COUNTDOWN_WINDOW_MS = 60 * SECOND_MS;

/** The lifetimes offered at create time, narrowed by the server's `maxTtlMs`. */
const PUBLIC_PREVIEW_TTL_CHOICES_MS: readonly number[] = [
    10 * MINUTE_MS,
    HOUR_MS,
    8 * HOUR_MS,
    24 * HOUR_MS,
];

const PUBLIC_PREVIEW_MODE_LABEL_KEYS = {
    secret_link: 'localServices.publicPreview.secretLinkMode',
    authenticated: 'localServices.publicPreview.authenticatedMode',
    public: 'localServices.publicPreview.publicMode',
} as const satisfies Record<LocalServicePublicExposureModeV1, string>;

function modeLabel(mode: LocalServicePublicExposureModeV1): string {
    return t(PUBLIC_PREVIEW_MODE_LABEL_KEYS[mode]);
}

function ttlChoiceLabel(ttlMs: number): string {
    if (ttlMs >= DAY_MS) return t('localServices.publicPreview.ttlOptionDays', { count: Math.round(ttlMs / DAY_MS) });
    if (ttlMs >= HOUR_MS) return t('localServices.publicPreview.ttlOptionHours', { count: Math.round(ttlMs / HOUR_MS) });
    return t('localServices.publicPreview.ttlOptionMinutes', { count: Math.round(ttlMs / MINUTE_MS) });
}

function resolveTtlChoices(maxTtlMs: number | undefined): readonly number[] {
    const withinPolicy = typeof maxTtlMs === 'number'
        ? PUBLIC_PREVIEW_TTL_CHOICES_MS.filter((choice) => choice <= maxTtlMs)
        : PUBLIC_PREVIEW_TTL_CHOICES_MS;
    // A policy tighter than the shortest offer still gets one honest option: its own ceiling.
    if (withinPolicy.length > 0) return withinPolicy;
    return [typeof maxTtlMs === 'number' && maxTtlMs > 0 ? maxTtlMs : DEFAULT_LOCAL_SERVICE_PUBLIC_PREVIEW_TTL_MS];
}

/** The modes and lifetimes the consequence sheet offers, from the server's policy. */
function resolvePublicLinkChoices(state: LocalServicePublicPreviewState): Readonly<{
    modeChoices: readonly LocalServiceExposureModeChoice[];
    ttlChoices: readonly LocalServiceExposureTtlChoice[];
}> {
    const allowedModes = state.policy?.allowedModes ?? [];
    return {
        modeChoices: (allowedModes.length > 0 ? allowedModes : (['secret_link'] as const))
            // Browser sharing has no signed-in admission yet; API callers retain that mode.
            .filter((mode) => mode !== 'authenticated')
            .map((mode) => ({ mode, label: modeLabel(mode) })),
        ttlChoices: resolveTtlChoices(state.policy?.maxTtlMs)
            .map((ttlMs) => ({ ttlMs, label: ttlChoiceLabel(ttlMs) })),
    };
}

/**
 * Show the consequence sheet, then create the link the person chose. One flow for the Services row's
 * link control and the Processes port menu's "Public link…"; the exposure is created only after the
 * sheet returns a decision, so nothing is busy while the person is still reading (UX-5, UB-4).
 */
async function requestPublicLink(input: Readonly<{
    target: PublicPreviewCreatableTarget;
    modeChoices: readonly LocalServiceExposureModeChoice[];
    ttlChoices: readonly LocalServiceExposureTtlChoice[];
    actions: LocalServicePublicPreviewActions;
    run: LocalServiceActionRunner['run'];
}>): Promise<void> {
    let confirmationRequired: boolean;
    try {
        confirmationRequired = await isActionApprovalRequiredForHome('localServices.publicPreview.create', { surface: 'ui' }, input.actions.serverId);
    } catch (error) {
        await input.run({ id: `create:${input.target.previewId}`, failureTitle: t('localServices.actions.failureTitle.expose'),
            action: async () => { throw error; } });
        return;
    }
    const decision = confirmationRequired ? await showLocalServiceExposureSheet({
        serviceTitle: input.target.title,
        modeChoices: input.modeChoices,
        ttlChoices: input.ttlChoices,
        testIDPrefix: `local-service-exposure-sheet:${input.target.previewId}`,
    }) : input.modeChoices[0] && input.ttlChoices[0]
        ? { mode: input.modeChoices[0].mode, ttlMs: input.ttlChoices[0].ttlMs }
        : null;
    if (!decision) return;
    await input.run({
        id: `create:${input.target.previewId}`,
        failureTitle: t('localServices.actions.failureTitle.expose'),
        action: () => input.actions.create(input.target.target, decision),
    });
}

/**
 * What one service's public link offers elsewhere than its Services row: create one (through the
 * same sheet and Action), or the reason it cannot. A link that already exists is the Services row's
 * to show, so it offers nothing here. Decided by the same selectors the row's controls use.
 */
export type LocalServicePublicLinkOffer =
    | Readonly<{ kind: 'create'; request: (actions: LocalServicePublicPreviewActions, run: LocalServiceActionRunner['run']) => Promise<void> }>
    | Readonly<{ kind: 'disabled'; subtitle: string }>;

function createLocalServicePublicLinkOffer(
    target: PublicPreviewCreatableTarget,
    state: LocalServicePublicPreviewState,
): Extract<LocalServicePublicLinkOffer, { kind: 'create' }> {
    const choices = resolvePublicLinkChoices(state);
    return { kind: 'create', request: (actions, run) => requestPublicLink({ target, ...choices, actions, run }) };
}

export function resolveLocalServicePublicLinkOffer(input: Readonly<{
    state: LocalServicePublicPreviewState | null | undefined;
    launchTarget: LocalServiceLaunchTargetV1;
    capabilityDisabledReasons?: LocalServiceCapabilityDisabledReasons;
}>): LocalServicePublicLinkOffer | null {
    const { state } = input;
    const [target] = publicPreviewTargets([input.launchTarget]);
    if (!state || !target || visibleExposuresForTarget(state, target).length > 0) return null;
    const activeExposureCount = selectLocalServicePublicPreviewRows(state)
        .filter((exposure) => exposure.state === 'active')
        .length;
    const createDisabledSubtitle = resolveLocalServicePublicPreviewCreateDisabledSubtitle({
        state,
        activeExposureCount,
        previewId: target.previewId,
        capabilityDisabledReasons: input.capabilityDisabledReasons?.publicPreview,
    });
    if (hasPreviewId(target) && !createDisabledSubtitle) {
        return createLocalServicePublicLinkOffer(target, state);
    }
    const subtitle = createDisabledSubtitle ?? (hasPreviewId(target) ? null : resolveLocalServicePreviewUnavailableSubtitle({
        capabilityDisabledReasons: input.capabilityDisabledReasons?.preview,
    }));
    return subtitle ? { kind: 'disabled', subtitle } : null;
}

function pad2(value: number): string {
    return value < 10 ? `0${value}` : String(value);
}

/** `9:58`, or `1:04:12` once the remainder crosses an hour. Digits only — the sentence is the key. */
function formatCountdownClock(remainingMs: number): string {
    const totalSeconds = Math.max(0, Math.floor(remainingMs / SECOND_MS));
    const seconds = totalSeconds % 60;
    const minutes = Math.floor(totalSeconds / 60) % 60;
    const hours = Math.floor(totalSeconds / 3600);
    return hours > 0
        ? `${hours}:${pad2(minutes)}:${pad2(seconds)}`
        : `${minutes}:${pad2(seconds)}`;
}

function coarseExpiresInLabel(remainingMs: number): string {
    if (remainingMs >= DAY_MS) {
        return t('localServices.publicPreview.expiresInDays', { count: Math.floor(remainingMs / DAY_MS) });
    }
    return t('localServices.publicPreview.expiresInHours', { count: Math.floor(remainingMs / HOUR_MS) });
}

/**
 * The secret link, masked down to the part that identifies it without disclosing it.
 *
 * A secret-link URL IS the credential, and the previous design put it in the row's TITLE. Origin
 * plus an ellipsis is enough to recognise which link this is; the reveal is an explicit act.
 * String slicing rather than `URL` parsing so an IPv6 host or a non-standard authority survives
 * verbatim instead of being reformatted by a parser.
 */
function maskPublicUrl(url: string): string {
    const schemeEnd = url.indexOf('://');
    if (schemeEnd < 0) return '…';
    const pathStart = url.indexOf('/', schemeEnd + 3);
    return pathStart < 0 ? `${url}/…` : `${url.slice(0, pathStart + 1)}…`;
}

/**
 * The live remaining-lifetime reading for one exposure.
 *
 * `selectLocalServicePublicExposureExpiry` is the canonical derivation (it also decides `expired`
 * from the deadline rather than trusting a stale daemon `state`); this hook only decides how often
 * to re-read it. The ticker is the app-wide `useElapsedTime`, anchored on `issuedAt`, and it runs
 * ONLY inside the final hour and ONLY until the deadline passes — `apps/ui/AGENTS.md` forbids
 * *indefinite* JS-driven motion, and a bounded, self-terminating one-second text update on a
 * surface that shows at most a handful of links is neither indefinite nor decorative. Above an
 * hour there is no ticker at all: nobody watches a 24-hour clock, and the coarse label re-reads on
 * the daemon snapshot that already re-renders this pane.
 */
function useExposureCountdown(exposure: LocalServicePublicExposureV1): Readonly<{
    expired: boolean;
    remainingMs: number;
    live: boolean;
}> {
    const [ticking, setTicking] = React.useState(true);
    // ONE derivation of "how long is left" — B1's canonical selector. Reading `expiresAt` directly
    // to decide whether to tick would be a second, subtly different answer to the same question.
    const expiry = selectLocalServicePublicExposureExpiry(exposure, Date.now());
    // Presentation only: a retained pane that is hidden keeps this row mounted, so it stops ticking
    // there (F-PLAN-22). Shown again, it re-renders and reads the clock afresh from the selector.
    const presented = useLayoutPresentationActive();
    const shouldTick = presented && ticking && !expiry.expired && expiry.remainingMs <= LIVE_COUNTDOWN_WINDOW_MS;
    // The return value is unused on purpose: the hook is only the tick source. Each tick re-renders,
    // and the reading above is recomputed from the selector against the current clock.
    useElapsedTime(shouldTick ? exposure.issuedAt : null);

    React.useEffect(() => {
        if (expiry.expired && ticking) {
            setTicking(false);
        }
    }, [expiry.expired, ticking]);

    return {
        expired: expiry.expired,
        remainingMs: expiry.remainingMs,
        live: !expiry.expired && expiry.remainingMs <= LIVE_COUNTDOWN_WINDOW_MS,
    };
}

/**
 * The exposure's own entrance — the one moment of weight in this corridor.
 *
 * A public link is the single most consequential thing a user can do on this surface, and until now
 * its arrival was indistinguishable from a list re-sort. It springs in from `scale 0.96` (the value
 * `make-interfaces-feel-better` fixes for tactile scale; below 0.95 reads exaggerated) through the
 * canonical `INSTRUMENT_SPRINGS.standard`. Motion is resolved at `useMotionPreferences`, the app's
 * motion chokepoint: at OS reduce-motion it already resolves to `crossfade`, so the travel is
 * dropped and only a short opacity fade remains. The countdown keeps running either way — it is
 * information, not decoration.
 */
// The return type is inferred on purpose: writing `ReturnType<typeof useAnimatedStyle>` resolves to
// the unparameterised `AnimatedStyleHandle<DefaultStyle>`, which `Animated.View`'s `style` prop does
// not accept. Letting the call's own generic flow out keeps the handle assignable.
function useExposureEntrance() {
    const motion = useMotionPreferences();
    const travel = motion.entrance.kind === 'travel';
    const progress = useSharedValue(0);

    React.useEffect(() => {
        progress.value = travel
            ? withSpring(1, INSTRUMENT_SPRINGS.standard)
            : withTiming(1, { duration: motion.entrance.durationMs });
    }, [motion.entrance.durationMs, progress, travel]);

    const style = useAnimatedStyle(() => ({
        opacity: progress.value,
        transform: travel ? [{ scale: 0.96 + (progress.value * 0.04) }] : [],
    }), [travel]);

    return { style };
}

function ExposureRow(props: Readonly<{
    exposure: LocalServicePublicExposureV1;
    actions: LocalServicePublicPreviewActions;
    pending: boolean;
    runAction: ReturnType<typeof useLocalServiceActionRunner>['run'];
    testID: string;
}>): React.ReactElement {
    const styles = stylesheet;
    const { exposure } = props;
    const countdown = useExposureCountdown(exposure);
    const entrance = useExposureEntrance();
    const copyFeedback = useHappierCopyFeedback();
    const [revealed, setRevealed] = React.useState(false);
    // Q2/F0-C3: the small plain controls grow a real box-model press frame (react-native-web ignores
    // `hitSlop`, and the desktop app IS the web bundle) bounded by the declared neighbour gap.
    const minimumTargetSize = resolveMinimumInteractiveTargetSize(Platform.OS);

    const onCopy = React.useCallback(() => {
        void (async () => {
            const copied = await props.runAction({
                id: `exposure:${exposure.exposureId}`,
                failureTitle: t('localServices.actions.failureTitle.copyExposure'),
                // `copyUrl` resolves `false` on refusal rather than an envelope, so it is mapped to
                // the shape the shared classifier reads. One outcome path, not a second one here.
                action: async () => (await props.actions.copyUrl(exposure)
                    ? { status: 'succeeded' }
                    : { ok: false, errorCode: null }),
            });
            if (copied) {
                copyFeedback.markCopied();
            }
        })();
    }, [copyFeedback, exposure, props]);

    const onRevoke = React.useCallback(() => {
        void (async () => {
            let confirmationRequired: boolean;
            try {
                confirmationRequired = await isActionApprovalRequiredForHome('localServices.publicPreview.revoke', { surface: 'ui' }, props.actions.serverId);
            } catch (error) {
                await props.runAction({ id: `exposure:${exposure.exposureId}`, failureTitle: t('localServices.actions.failureTitle.revokeExposure'),
                    action: async () => { throw error; } });
                return;
            }
            const confirmed = !confirmationRequired || await Modal.confirm(
                t('localServices.publicPreview.revokeConfirmTitle'),
                t('localServices.publicPreview.revokeConfirmMessage', { url: maskPublicUrl(exposure.publicUrl) }),
                { confirmText: t('localServices.publicPreview.revokeConfirmCta'), destructive: true },
            );
            if (!confirmed) return;
            await props.runAction({
                id: `exposure:${exposure.exposureId}`,
                failureTitle: t('localServices.actions.failureTitle.revokeExposure'),
                action: () => props.actions.revoke(exposure),
            });
        })();
    }, [exposure, props]);

    const detail = countdown.expired
        ? t('localServices.publicPreview.expiredSubtitle')
        : countdown.live
            ? t('localServices.publicPreview.expiresInClock', {
                clock: formatCountdownClock(countdown.remainingMs),
            })
            : coarseExpiresInLabel(countdown.remainingMs);
    const reach = exposure.mode === 'authenticated'
        ? t('localServices.publicPreview.consequenceReachSignedIn')
        : t('localServices.publicPreview.consequenceReach');

    return (
        <Animated.View style={entrance.style}>
            <View testID={props.testID} style={styles.link}>
                <View style={styles.linkHeader}>
                    <Text style={styles.linkLabel}>{t('localServices.pane.publicLinkTitle')}</Text>
                    <Text
                        testID={`${props.testID}-countdown`}
                        style={[
                            styles.clock,
                            !countdown.expired && countdown.remainingMs <= URGENT_COUNTDOWN_WINDOW_MS
                                ? styles.clockUrgent
                                : null,
                        ]}
                        // A value that changes on its own must announce itself politely rather
                        // than interrupting; the deadline is not an alert.
                        accessibilityLiveRegion="polite"
                    >
                        {detail}
                    </Text>
                </View>
                <View style={styles.urlRow}>
                    <Text
                        testID={`${props.testID}-url`}
                        style={styles.url}
                        numberOfLines={1}
                        ellipsizeMode="middle"
                    >
                        {revealed ? exposure.publicUrl : maskPublicUrl(exposure.publicUrl)}
                    </Text>
                    <View style={styles.actionRow}>
                        <CopiedPill visible={copyFeedback.isCopied()} testID={`${props.testID}-copy-feedback`} />
                        <IconButton
                            testID={`${props.testID}-reveal`}
                            iconName={revealed ? 'eye-slash' : 'eye'}
                            accessibilityLabel={revealed
                                ? t('localServices.publicPreview.hideUrlA11y')
                                : t('localServices.publicPreview.revealUrlA11y')}
                            tooltip={revealed
                                ? t('localServices.publicPreview.hideUrlA11y')
                                : t('localServices.publicPreview.revealUrlA11y')}
                            variant="plain"
                            size={24}
                            minimumInteractiveTargetSize={minimumTargetSize}
                            interactiveTargetGapPx={4}
                            onPress={() => setRevealed((current) => !current)}
                        />
                        <IconButton
                            testID={`${props.testID}-copy`}
                            iconName="copy"
                            accessibilityLabel={t('common.copy')}
                            variant="plain"
                            size={24}
                            // Copying a link that has already expired hands someone a dead URL.
                            disabled={countdown.expired}
                            minimumInteractiveTargetSize={minimumTargetSize}
                            interactiveTargetGapPx={4}
                            onPress={onCopy}
                        />
                    </View>
                </View>
                <View style={styles.linkFooter}>
                    <Text style={styles.reach}>{reach}</Text>
                    {/* Revoke is a deliberate, confirmed act, not an alarm: a quiet button, red only in its confirmation. */}
                    <RoundButton
                        testID={`${props.testID}-revoke`}
                        size="mini"
                        display="secondary"
                        title={t('localServices.publicPreview.revokeConfirmCta')}
                        accessibilityLabel={t('localServices.publicPreview.revokeActionA11y')}
                        loading={props.pending}
                        onPress={onRevoke}
                    />
                </View>
            </View>
            {/* The QR carries the secret link, so it appears only once the user reveals the link. */}
            {revealed && !countdown.expired ? (
                <View style={styles.qrRow}>
                    <View testID={`${props.testID}-qr`} style={styles.qrTile}>
                        <QRCode data={exposure.publicUrl} size={PUBLIC_LINK_QR_SIZE_PX} />
                    </View>
                    <Text style={styles.qrHint}>{t('localServices.pane.publicLinkScanHint')}</Text>
                </View>
            ) : null}
        </Animated.View>
    );
}

/**
 * The create control: "Share a link". Hosted by the expansion's action line next to Copy address, or
 * by `LocalServicePublicPreviewControls` itself where the host has no action line (the Browser's
 * preview frame). One button, one flow (`requestPublicLink`), decided by `resolveLocalServicePublicLinkOffer`.
 */
export function LocalServiceShareLinkButton(props: Readonly<{
    offer: Extract<LocalServicePublicLinkOffer, { kind: 'create' }>;
    actions: LocalServicePublicPreviewActions;
    testID: string;
}>): React.ReactElement {
    const runner = useLocalServiceActionRunner();
    const { offer, actions } = props;
    return (
        <RoundButton
            testID={props.testID}
            size="small"
            display="secondary"
            title={t('localServices.publicPreview.shareCta')}
            accessibilityLabel={t('localServices.publicPreview.createActionA11y')}
            loading={runner.pendingId !== null}
            onPress={() => { void offer.request(actions, runner.run); }}
        />
    );
}

/** The same create control as a list row, for the phone detail's grouped list (lab RUNSONp). */
export function LocalServiceShareLinkRow(props: Readonly<{
    offer: Extract<LocalServicePublicLinkOffer, { kind: 'create' }>;
    actions: LocalServicePublicPreviewActions;
    testID: string;
}>): React.ReactElement {
    const runner = useLocalServiceActionRunner();
    const { offer, actions } = props;
    return (
        <Item
            testID={props.testID}
            title={t('localServices.publicPreview.shareCta')}
            accessibilityLabel={t('localServices.publicPreview.createActionA11y')}
            loading={runner.pendingId !== null}
            onPress={() => { void offer.request(actions, runner.run); }}
        />
    );
}

export function LocalServicePublicPreviewControls(props: Readonly<{
    launchTargets: readonly LocalServiceLaunchTargetV1[];
    browserTarget?: Extract<LocalServicePublicPreviewActionTarget, { kind: 'localServicePreview' }>;
    serviceTitle?: string;
    state: LocalServicePublicPreviewState | null | undefined;
    actions?: LocalServicePublicPreviewActions;
    /**
     * The server's account of which prerequisite is unmet, resolved once by
     * `LocalServicesSurfaceHost`. Without it every disabled row shows the same generic sentence and
     * an operator cannot tell which of eleven variables is wrong (audit P1-3). Optional so a caller
     * that has no server context keeps the previous generic copy.
     */
    capabilityDisabledReasons?: LocalServiceCapabilityDisabledReasons;
    /**
     * The host draws "Share a link" in its own action line (the Services expansion beside Copy
     * address), so this block shows only issued links and the reasons a link cannot be created.
     */
    shareInActionLine?: boolean;
    testID?: string;
}>): React.ReactElement | null {
    const runner = useLocalServiceActionRunner();
    const capabilityDisabledReasons = props.capabilityDisabledReasons;
    const state = props.state;
    const actions = props.actions;

    const targets = React.useMemo(
        (): readonly PublicPreviewTarget[] => (state && actions
            ? props.browserTarget
                ? [{ target: props.browserTarget, previewId: props.browserTarget.targetId, targetKey: props.browserTarget.targetId, title: props.serviceTitle ?? props.browserTarget.display?.title ?? props.browserTarget.targetId }]
                : publicPreviewTargets(props.launchTargets)
            : []),
        [actions, props.browserTarget, props.launchTargets, props.serviceTitle, state],
    );

    if (!state || !actions) {
        return null;
    }

    // One scan of the exposure set for the whole pane. This used to run once per service row
    // because the group was mounted inside the row (U-10).
    const activeExposureCount = selectLocalServicePublicPreviewRows(state)
        .filter((exposure) => exposure.state === 'active')
        .length;
    const targetRows = targets.map((target) => ({
        target,
        exposures: visibleExposuresForTarget(state, target),
        createDisabledSubtitle: resolveLocalServicePublicPreviewCreateDisabledSubtitle({
            state,
            activeExposureCount,
            previewId: target.previewId,
            capabilityDisabledReasons: capabilityDisabledReasons?.publicPreview,
        }),
    }));
    const exposureRows = targetRows.flatMap((row) => row.exposures);
    const creatableTargets: readonly PublicPreviewCreatableTarget[] = targetRows
        .filter((row) => !row.createDisabledSubtitle)
        .map((row) => row.target)
        .filter(hasPreviewId);
    const disabledTargets: readonly PublicPreviewDisabledTarget[] = targetRows
        .filter((row) => row.exposures.length === 0)
        .map((row): PublicPreviewDisabledTarget | null => {
            const subtitle = hasPreviewId(row.target)
                ? row.createDisabledSubtitle
                : (row.createDisabledSubtitle ?? resolveLocalServicePreviewUnavailableSubtitle({
                    capabilityDisabledReasons: capabilityDisabledReasons?.preview,
                }));
            return subtitle ? { ...row.target, subtitle } : null;
        })
        .filter((target): target is PublicPreviewDisabledTarget => Boolean(target));
    const hostedCreatableTargets = props.shareInActionLine ? [] : creatableTargets;
    if (exposureRows.length === 0 && hostedCreatableTargets.length === 0 && disabledTargets.length === 0) {
        return null;
    }

    const testID = props.testID ?? 'local-service-public-preview-controls';
    const styles = stylesheet;

    return (
        <View testID={testID} style={styles.block}>
            {exposureRows.map((exposure) => (
                <ExposureRow
                    key={`exposure:${exposure.exposureId}`}
                    exposure={exposure}
                    actions={actions}
                    pending={runner.pendingId === `exposure:${exposure.exposureId}`}
                    runAction={runner.run}
                    testID={`${testID}-exposure:${exposure.exposureId}`}
                />
            ))}
            {hostedCreatableTargets.map((target) => (
                <View key={`create:${target.previewId}`} style={styles.shareRow}>
                    <LocalServiceShareLinkButton
                        testID={`${testID}-target:${target.previewId}-create`}
                        offer={createLocalServicePublicLinkOffer(target, state)}
                        actions={actions}
                    />
                </View>
            ))}
            {disabledTargets.map((target) => (
                <Text
                    key={`disabled:${target.targetKey}`}
                    testID={`${testID}-target:${target.targetKey}-disabled`}
                    style={[styles.note, styles.disabledNote]}
                >
                    {target.subtitle}
                </Text>
            ))}
            {/*
              * The Confirm beat's missing fact: a public link is audited, and the user is entitled
              * to know that at the moment they are looking at one.
              */}
            {exposureRows.length > 0 || hostedCreatableTargets.length > 0
                ? <Text style={styles.note}>{t('localServices.publicPreview.groupFooter')}</Text>
                : null}
        </View>
    );
}
