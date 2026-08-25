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
import { resolveMinimumInteractiveTargetSize } from '@/components/ui/interactiveTargetSize';
import { CopiedPill } from '@/components/ui/copy/CopiedPill';
import { useTemporaryCopyFeedback } from '@/components/ui/copy/useTemporaryCopyFeedback';
import { INSTRUMENT_SPRINGS, useMotionPreferences } from '@/components/instrument';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { useElapsedTime } from '@/hooks/ui/useElapsedTime';
import { Modal } from '@/modal';
import {
    DEFAULT_LOCAL_SERVICE_PUBLIC_PREVIEW_TTL_MS,
    type LocalServicePublicPreviewActions,
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

import { useLocalServiceActionRunner } from './localServiceActionOutcome';
import type { LocalServiceCapabilityDisabledReasons } from './useLocalServicePublicPreviewFeature';
import {
    showLocalServiceExposureSheet,
    type LocalServiceExposureModeChoice,
    type LocalServiceExposureTtlChoice,
} from './showLocalServiceExposureSheet';

type PublicPreviewTarget = Readonly<{
    target: LocalServiceLaunchTargetV1;
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

/** The gap between an exposure row's controls, shared with their press frames. */
const EXPOSURE_ACTION_GAP_PX = 8;

const stylesheet = StyleSheet.create((theme) => ({
    actionRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: EXPOSURE_ACTION_GAP_PX,
    },
    urlRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        flexWrap: 'wrap',
    },
    url: {
        ...Typography.mono(),
        flexShrink: 1,
        fontSize: 12,
        color: theme.colors.text.secondary,
    },
    /**
     * The countdown. `Typography.timestamp()` already carries tabular numerals, which is what keeps
     * the row from twitching sideways once a second as the digits change width.
     */
    clock: {
        ...Typography.timestamp(),
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

function publicPreviewTargets(targets: readonly LocalServiceLaunchTargetV1[]): readonly PublicPreviewTarget[] {
    return targets
        .map((target): PublicPreviewTarget | null => {
            const previewId = readTargetPreviewId(target);
            const supportsDisabledStatus = target.source === 'inventory_entry'
                && target.browserTarget?.kind === 'externalUrl';
            if (!previewId && !supportsDisabledStatus) {
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
    const shouldTick = ticking && !expiry.expired && expiry.remainingMs <= LIVE_COUNTDOWN_WINDOW_MS;
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

function ExposureActions(props: Readonly<{
    exposure: LocalServicePublicExposureV1;
    expired: boolean;
    revealed: boolean;
    onToggleReveal: () => void;
    onCopy: () => void;
    onRevoke: () => void;
    copied: boolean;
    testID: string;
}>): React.ReactElement {
    const styles = stylesheet;
    // Q2/F0-C3: three 28px controls in a row is exactly where the iOS/Android floor bites. The
    // primitive grows a real box-model press frame (react-native-web ignores `hitSlop`, and the
    // desktop app IS the web bundle) bounded by the declared neighbour gap, so the targets meet
    // without overlapping and the drawn squares do not move.
    const minimumTargetSize = resolveMinimumInteractiveTargetSize(Platform.OS);
    return (
        <View style={styles.actionRow}>
            <CopiedPill visible={props.copied} testID={`${props.testID}-copy-feedback`} />
            <IconButton
                testID={`${props.testID}-reveal`}
                iconName={props.revealed ? 'eye-slash' : 'eye'}
                accessibilityLabel={props.revealed
                    ? t('localServices.publicPreview.hideUrlA11y')
                    : t('localServices.publicPreview.revealUrlA11y')}
                tooltip={props.revealed
                    ? t('localServices.publicPreview.hideUrlA11y')
                    : t('localServices.publicPreview.revealUrlA11y')}
                variant="plain"
                selected={props.revealed}
                minimumInteractiveTargetSize={minimumTargetSize}
                interactiveTargetGapPx={EXPOSURE_ACTION_GAP_PX}
                onPress={props.onToggleReveal}
            />
            <IconButton
                testID={`${props.testID}-copy`}
                iconName="copy"
                accessibilityLabel={t('common.copy')}
                // Copying a link that has already expired hands someone a dead URL.
                disabled={props.expired}
                minimumInteractiveTargetSize={minimumTargetSize}
                interactiveTargetGapPx={EXPOSURE_ACTION_GAP_PX}
                onPress={props.onCopy}
            />
            <IconButton
                testID={`${props.testID}-revoke`}
                iconName="x-circle"
                accessibilityLabel={t('localServices.publicPreview.revokeActionA11y')}
                tone="danger"
                minimumInteractiveTargetSize={minimumTargetSize}
                interactiveTargetGapPx={EXPOSURE_ACTION_GAP_PX}
                onPress={props.onRevoke}
            />
        </View>
    );
}

function ExposureRow(props: Readonly<{
    exposure: LocalServicePublicExposureV1;
    serviceTitle: string;
    actions: LocalServicePublicPreviewActions;
    pending: boolean;
    runAction: ReturnType<typeof useLocalServiceActionRunner>['run'];
    testID: string;
}>): React.ReactElement {
    const styles = stylesheet;
    const { exposure } = props;
    const countdown = useExposureCountdown(exposure);
    const entrance = useExposureEntrance();
    const copyFeedback = useTemporaryCopyFeedback();
    const [revealed, setRevealed] = React.useState(false);

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
            const confirmed = await Modal.confirm(
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

    return (
        <Animated.View style={entrance.style}>
            <Item
                testID={props.testID}
                title={props.serviceTitle}
                subtitle={(
                    <View style={styles.urlRow}>
                        <Text
                            testID={`${props.testID}-url`}
                            style={styles.url}
                            numberOfLines={1}
                            ellipsizeMode="middle"
                        >
                            {revealed ? exposure.publicUrl : maskPublicUrl(exposure.publicUrl)}
                        </Text>
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
                )}
                subtitleLines={2}
                detail={modeLabel(exposure.mode)}
                detailTestID={`${props.testID}-mode`}
                mode="info"
                showChevron={false}
                loading={props.pending}
                rightElement={(
                    <ExposureActions
                        exposure={exposure}
                        expired={countdown.expired}
                        revealed={revealed}
                        onToggleReveal={() => setRevealed((current) => !current)}
                        onCopy={onCopy}
                        onRevoke={onRevoke}
                        copied={copyFeedback.isCopied()}
                        testID={props.testID}
                    />
                )}
            />
        </Animated.View>
    );
}

export function LocalServicePublicPreviewControls(props: Readonly<{
    launchTargets: readonly LocalServiceLaunchTargetV1[];
    state: LocalServicePublicPreviewState | null | undefined;
    actions?: LocalServicePublicPreviewActions;
    /**
     * The server's account of which prerequisite is unmet, resolved once by
     * `LocalServicesSurfaceHost`. Without it every disabled row shows the same generic sentence and
     * an operator cannot tell which of eleven variables is wrong (audit P1-3). Optional so a caller
     * that has no server context keeps the previous generic copy.
     */
    capabilityDisabledReasons?: LocalServiceCapabilityDisabledReasons;
    testID?: string;
}>): React.ReactElement | null {
    const runner = useLocalServiceActionRunner();
    const capabilityDisabledReasons = props.capabilityDisabledReasons;
    const state = props.state;
    const actions = props.actions;

    const targets = React.useMemo(
        () => (state && actions ? publicPreviewTargets(props.launchTargets) : []),
        [actions, props.launchTargets, state],
    );

    // UX-5 + UB-4: the exposure is created only after the consequence sheet returns a decision, so
    // the create control is not "busy" while the user is still reading. The pending state starts at
    // dispatch, which is what `runner` owns.
    const createExposure = React.useCallback((
        target: PublicPreviewCreatableTarget,
        modeChoices: readonly LocalServiceExposureModeChoice[],
        ttlChoices: readonly LocalServiceExposureTtlChoice[],
    ) => {
        void (async () => {
            const decision = await showLocalServiceExposureSheet({
                serviceTitle: target.title,
                modeChoices,
                ttlChoices,
                testIDPrefix: `local-service-exposure-sheet:${target.previewId}`,
            });
            if (!decision || !actions) return;
            await runner.run({
                id: `create:${target.previewId}`,
                failureTitle: t('localServices.actions.failureTitle.expose'),
                action: () => actions.create(target.target, decision),
            });
        })();
    }, [actions, runner]);

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
    const exposureRows = targetRows.flatMap((row) => row.exposures.map((exposure) => ({
        exposure,
        serviceTitle: row.target.title,
    })));
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
    if (exposureRows.length === 0 && creatableTargets.length === 0 && disabledTargets.length === 0) {
        return null;
    }

    const testID = props.testID ?? 'local-service-public-preview-controls';

    const allowedModes = state.policy?.allowedModes ?? [];
    const modeChoices: readonly LocalServiceExposureModeChoice[] = (
        allowedModes.length > 0 ? allowedModes : (['secret_link'] as const)
    ).map((mode) => ({ mode, label: modeLabel(mode) }));
    const ttlChoices: readonly LocalServiceExposureTtlChoice[] = resolveTtlChoices(state.policy?.maxTtlMs)
        .map((ttlMs) => ({ ttlMs, label: ttlChoiceLabel(ttlMs) }));

    return (
        <View testID={testID}>
            <ItemGroup
                title={t('localServices.publicPreview.title')}
                // The Confirm beat's missing fact: a public link is audited, and the user is
                // entitled to know that at the moment they are looking at one.
                footer={t('localServices.publicPreview.groupFooter')}
                selectableItemCountOverride={exposureRows.length + creatableTargets.length + disabledTargets.length}
            >
                {exposureRows.map(({ exposure, serviceTitle }) => (
                    <ExposureRow
                        key={`exposure:${exposure.exposureId}`}
                        exposure={exposure}
                        serviceTitle={serviceTitle}
                        actions={actions}
                        pending={runner.pendingId === `exposure:${exposure.exposureId}`}
                        runAction={runner.run}
                        testID={`${testID}-exposure:${exposure.exposureId}`}
                    />
                ))}
                {creatableTargets.map((target) => (
                    <Item
                        key={`create:${target.previewId}`}
                        testID={`${testID}-target:${target.previewId}`}
                        title={target.title}
                        subtitle={t('localServices.publicPreview.createSubtitle')}
                        detail={modeChoices[0]?.label}
                        detailTestID={`${testID}-target:${target.previewId}-mode`}
                        mode="info"
                        showChevron={false}
                        loading={runner.pendingId === `create:${target.previewId}`}
                        rightElement={(
                            <IconButton
                                testID={`${testID}-target:${target.previewId}-create`}
                                iconName="link"
                                accessibilityLabel={t('localServices.publicPreview.createActionA11y')}
                                minimumInteractiveTargetSize={resolveMinimumInteractiveTargetSize(Platform.OS)}
                                disabled={runner.pendingId === `create:${target.previewId}`}
                                onPress={() => createExposure(target, modeChoices, ttlChoices)}
                            />
                        )}
                    />
                ))}
                {disabledTargets.map((target) => (
                    <Item
                        key={`disabled:${target.targetKey}`}
                        testID={`${testID}-target:${target.targetKey}-disabled`}
                        title={target.title}
                        subtitle={target.subtitle}
                        detail={modeChoices[0]?.label}
                        detailTestID={`${testID}-target:${target.targetKey}-disabled-mode`}
                        mode="info"
                        showChevron={false}
                    />
                ))}
            </ItemGroup>
        </View>
    );
}
