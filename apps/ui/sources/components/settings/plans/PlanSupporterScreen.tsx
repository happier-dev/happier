import * as React from 'react';
import { ActivityIndicator, Platform, Pressable, View, type LayoutChangeEvent } from 'react-native';
import { useRouter } from 'expo-router';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import type { AccountPlanResponseV1 } from '@happier-dev/protocol';

import { buildPlanLadder, cheapestPackPlan, formatMinorAmount, formatPinLimit, formatPlanDate, formatPrice, formatRetentionPeriod, formatStorageBytes, formatSupporterNumber, formatSupporterTenure, joinPlanNames, billedByLabel, monthlyPrice, nextPlanUp } from '@/components/plans/planSurfaceCopy';
import { canPurchaseSupporterOffer, showSupporterOfferSheet } from '@/components/plans/offer/showSupporterOfferSheet';
import { PlanLadder, planLadderFootnote } from '@/components/plans/offer/PlanLadder';
import { PlanTextLink } from '@/components/plans/PlanTextLink';
import { TickRibbon } from '@/components/plans/TickRibbon';
import { fetchSessionRetentionSummary, type SessionRetentionSummary } from '@/sync/api/session/apiRetentionSummary';
import { SUPPORTER_PACK_PERKS, SupporterOfferBlock } from '@/components/plans/offer/SupporterOfferBlock';
import { SupporterPass } from '@/components/plans/pass/SupporterPass';
import { SupporterPassStylePicker } from '@/components/plans/pass/SupporterPassStylePicker';
import { showExportSheet } from '@/components/sessions/export/ExportSheet';
import { showKeepOrLetGoSheet } from '@/components/sessions/keepOrLetGo/KeepOrLetGoSheet';
import { formatLeavingDate } from '@/components/sessions/keepOrLetGo/keepOrLetGoCopy';
import { LeavingSessionsProvider, useLeavingSessionsView } from '@/components/sessions/keepOrLetGo/leavingSessionsView';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Switch } from '@/components/ui/forms/Switch';
import { Icon, type IconName } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { StatusPill } from '@/components/ui/status/StatusPill';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { useLayoutMaxWidth } from '@/components/ui/layout/layout';
import { ITEM_GROUP_CONTAINER_HORIZONTAL_PADDING_PX } from '@/components/ui/lists/itemGroupSpacing';
import { putSupporterRing } from '@/sync/api/account/apiAccountPlan';
import { refreshAccountPlan, useAccountPlan, type AccountPlanEntry } from '@/sync/domains/plans/accountPlanResource';
import { checkPurchaseAgain, openBillingManage, openPlanCheckout, restoreStorePurchases, supportsHostedCheckout, supportsStoreCheckout, usesAccountBilling } from '@/sync/domains/purchases/purchaseFlow';
import { storage } from '@/sync/domains/state/storage';
import { createDefaultActionExecutor } from '@/sync/ops/actions/defaultActionExecutor';
import { t, type TranslationKeyNoParams } from '@/text';

import { planSurfaceTitle, usePlanSurfacePresentation } from './usePlanSurfaceVisibility';

const COMPACT_BELOW_PX = 620;
const RIBBON_INSET = 20;

const selectEntry = (entry: AccountPlanEntry) => entry;

/** Export is one sheet; this page opens it on "everything", with the page's session count for its bar. */
function exportEverything(totalSessions: number | null): void {
    showExportSheet({ initialScope: 'everything', totalSessions });
}

type SummaryState = Readonly<{ status: 'idle' | 'ready' | 'error'; summary: SessionRetentionSummary | null; readAtMs: number }>;

/** The ribbon's data: one read when the page opens with plans on, none otherwise (plan 02 F4). */
function useRetentionSummaryOnOpen(enabled: boolean): SummaryState {
    const [state, setState] = React.useState<SummaryState>({ status: 'idle', summary: null, readAtMs: 0 });
    React.useEffect(() => {
        if (!enabled) return undefined;
        const controller = new AbortController();
        fetchSessionRetentionSummary(controller.signal).then(
            (summary) => setState({ status: 'ready', summary, readAtMs: Date.now() }),
            () => {
                if (!controller.signal.aborted) setState({ status: 'error', summary: null, readAtMs: Date.now() });
            },
        );
        return () => controller.abort();
    }, [enabled]);
    return state;
}

export type PlanSupporterScreenProps = Readonly<{
    plans: boolean;
    supporter: boolean;
    /** From `happier://settings/plan?supporterCode=…`: opens the sheet prefilled, never applied by itself. */
    prefilledSupporterCode?: string | null;
    showSupporterOffer?: boolean;
}>;

/**
 * Settings › Plans & Supporter (Cloud) or Support Happier (self-hosted), plan 04 U1/U8.
 *
 * Everything shown comes from one `GET /v1/account/plan`. A read that failed with nothing known
 * renders an error and never a plan; a later failure keeps the last-known page with a quiet line.
 */
export const PlanSupporterScreen = React.memo(function PlanSupporterScreen(props: PlanSupporterScreenProps) {
    const { theme } = useUnistyles();
    const router = useRouter();
    const entry = useAccountPlan(selectEntry);
    const accountId = storage((state) => state.profile.id);
    const firstName = storage((state) => state.profile.firstName);
    const hostedCheckout = supportsHostedCheckout();
    const storeCheckout = supportsStoreCheckout();
    const purchasable = hostedCheckout || storeCheckout;
    const contentWidth = { maxWidth: useLayoutMaxWidth() };
    const accountBilling = usesAccountBilling();
    const [width, setWidth] = React.useState(0);
    const compact = width > 0 && width < COMPACT_BELOW_PX;
    const [pendingPlanId, setPendingPlanId] = React.useState<string | null>(null);
    const [busyPlanId, setBusyPlanId] = React.useState<string | null>(null);
    const [inlineError, setInlineError] = React.useState<string | null>(null);
    const [checking, setChecking] = React.useState(false);
    const { cloudPlans, isCloudServer } = usePlanSurfacePresentation(props.plans);
    // The history card is about what the server lets go. Happier Cloud always has a rule; a
    // self-hosted server shows it only when its operator set one, since supporting changes nothing there.
    const historyLimited = entry.data ? entry.data.limits.sessionRetentionDays !== null : false;
    const showHistory = props.plans && (isCloudServer || historyLimited);
    const summaryState = useRetentionSummaryOnOpen(showHistory);
    const [ribbonWidth, setRibbonWidth] = React.useState(0);

    const data = entry.data;
    const planId = data?.plan?.id ?? null;
    // The push that follows a finished checkout flips the page; the pending line ends with it.
    React.useEffect(() => {
        setPendingPlanId(null);
    }, [planId]);

    const onLayout = React.useCallback((event: LayoutChangeEvent) => {
        setWidth(event.nativeEvent.layout.width);
    }, []);

    const openSupporterSheet = React.useCallback((prefilledCode: string | null) => {
        const offer = data?.offers?.supporter;
        if (!offer) return;
        showSupporterOfferSheet({ offer, prefilledCode });
    }, [data?.offers?.supporter]);

    const openedPrefill = React.useRef(false);
    React.useEffect(() => {
        if (openedPrefill.current || !(props.prefilledSupporterCode || props.showSupporterOffer) || !data?.offers?.supporter) return;
        if (!canPurchaseSupporterOffer(data.offers.supporter)) return;
        openedPrefill.current = true;
        openSupporterSheet(props.prefilledSupporterCode ?? null);
    }, [data?.offers?.supporter, openSupporterSheet, props.prefilledSupporterCode, props.showSupporterOffer]);

    const choosePlan = React.useCallback(async (chosenId: string) => {
        const plan = data?.offers?.plans.find((candidate) => candidate.id === chosenId);
        if (!plan) return;
        setBusyPlanId(chosenId);
        setInlineError(null);
        const result = await openPlanCheckout({ plan, interval: 'month', accountId });
        setBusyPlanId(null);
        if (result === 'opened') setPendingPlanId(chosenId);
        else setInlineError(result === 'unavailable' ? t('planSurface.checkoutUnavailable') : t('planSurface.checkoutOpenFailed'));
    }, [accountId, data?.offers?.plans]);

    const checkAgain = React.useCallback(async () => {
        setChecking(true);
        setInlineError(null);
        try {
            await checkPurchaseAgain();
        } catch {
            setInlineError(t('planSurface.checkFailed'));
        } finally {
            setChecking(false);
        }
    }, []);

    const manage = React.useCallback(async () => {
        const opened = await openBillingManage(data?.offers?.portalUrl ?? null, {
            accountId, source: data?.plan?.source ?? null,
        });
        if (!opened) setInlineError(t('planSurface.manageOpenFailed'));
    }, [accountId, data?.offers?.portalUrl, data?.plan?.source]);

    const restore = React.useCallback(async () => {
        setChecking(true);
        setInlineError(null);
        try {
            await restoreStorePurchases(accountId);
        } catch {
            setInlineError(t('planSurface.checkFailed'));
        } finally {
            setChecking(false);
        }
    }, [accountId]);

    const setRing = React.useCallback((visible: boolean) => {
        void putSupporterRing(visible).catch(() => setInlineError(t('planSurface.ringFailed')));
    }, []);

    const title = planSurfaceTitle({ cloudPlans });
    const hero = (
        <View style={[styles.hero, contentWidth]}>
            <View style={[styles.heroRow, compact ? styles.heroRowCompact : null]}>
                <Text style={styles.title} accessibilityRole="header">{title}</Text>
                {data ? <PlanChip data={data} cloudPlans={cloudPlans} /> : null}
            </View>
            <PlanStory
                cloudPlans={cloudPlans}
                onClaimNumber={data && props.supporter && data.offers?.supporter && !(data.supporter.active && data.supporter.number !== null) && !data.plan
                    && canPurchaseSupporterOffer(data.offers.supporter)
                    ? openSupporterSheet
                    : null}
            />
        </View>
    );

    if (!data) {
        return (
            <ItemList style={styles.list} testID="plan-supporter-screen">
                <View onLayout={onLayout}>{hero}</View>
                {entry.status === 'error' || entry.status === 'unavailable' ? (
                    <ItemGroup>
                        <View style={styles.stateBody} testID="plan-supporter-error">
                            <Text style={styles.stateTitle}>{t('planSurface.readFailedTitle')}</Text>
                            <Text style={styles.stateText}>{t('planSurface.readFailedBody')}</Text>
                            <RoundButton size="small" title={t('planSurface.retry')} action={refreshAccountPlan} testID="plan-supporter-retry" />
                        </View>
                    </ItemGroup>
                ) : (
                    <ItemGroup>
                        <View style={styles.stateBody}>
                            <ActivityIndicator color={theme.colors.text.secondary} />
                        </View>
                    </ItemGroup>
                )}
            </ItemList>
        );
    }

    const offers = data.offers;
    const ladder = props.plans && offers
        ? buildPlanLadder({ baseLimits: offers.baseLimits, plans: offers.plans, currentPlanId: planId })
        : [];
    const upgrade = nextPlanUp(ladder);
    const isMember = data.plan !== null;
    const isSupporter = data.supporter.active && data.supporter.number !== null;
    const supporterOffer = props.supporter ? offers?.supporter ?? null : null;
    const packPlan = cloudPlans && accountBilling && offers ? cheapestPackPlan(offers.plans) : null;
    const packPlanPrice = packPlan ? monthlyPrice(packPlan) : null;
    const identity = isSupporter
        ? { number: data.supporter.number!, name: firstName ?? null, sinceMs: data.supporter.since }
        : null;
    const supporterTenure = identity ? formatSupporterTenure(data.supporter) : null;
    const sessionsPeriod = data.limits.sessionRetentionDays;
    const paidPlanNames = joinPlanNames(ladder.filter((column) => column.price).map((column) => column.name));

    return (
        <ItemList style={styles.list} testID="plan-supporter-screen">
            <View onLayout={onLayout}>{hero}</View>

            {entry.status === 'error' && entry.readAtMs ? (
                <View style={[styles.staleRow, contentWidth]}>
                    <Text style={styles.staleText}>
                        {t('planSurface.refreshFailedLine', { time: new Date(entry.readAtMs).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) })}
                    </Text>
                    <RoundButton size="small" display="inverted" title={t('planSurface.retry')} action={refreshAccountPlan} />
                </View>
            ) : null}

            {showHistory ? (
                <LeavingSessionsProvider enabled>
                <ItemGroup title={t(isCloudServer ? 'planSurface.historyTitle' : 'planSurface.selfHistoryTitle')}>
                    <View style={[styles.historyTop, compact ? styles.historyTopCompact : null]} testID="plan-history-stats">
                        {summaryState.summary ? (
                            <View style={styles.stat}>
                                <Text style={styles.statValue}>{String(summaryState.summary.sessions)}</Text>
                                <Text style={styles.statLabel}>{t(isCloudServer ? 'planSurface.statSessions' : 'planSurface.statSessionsSelf')}</Text>
                            </View>
                        ) : null}
                        <View style={styles.stat}>
                            <Text style={styles.statValue}>{formatPinLimit(data.usage.pinnedSessions)}</Text>
                            <Text style={styles.statLabel}>
                                {data.limits.pinnedSessions === null
                                    ? t('planSurface.statPins')
                                    : t('planSurface.statPinsOf', { limit: formatPinLimit(data.limits.pinnedSessions) })}
                            </Text>
                        </View>
                        {data.usage.artifactStorageBytes !== null && data.limits.artifactStorageBytes !== null ? (
                            <View style={styles.stat}>
                                <Text style={styles.statValue}>{formatStorageBytes(data.usage.artifactStorageBytes)}</Text>
                                <Text style={styles.statLabel}>{t('planSurface.statFilesOf', { limit: formatStorageBytes(data.limits.artifactStorageBytes) })}</Text>
                            </View>
                        ) : null}
                        <View style={styles.grow} />
                        <HistoryChip isMember={isMember} keptForLabel={sessionsPeriod !== null
                            ? t('planSurface.keptFor', { period: formatRetentionPeriod(sessionsPeriod) })
                            : null}
                        />
                    </View>
                    <View style={styles.ribbonWrap} onLayout={(event) => setRibbonWidth(Math.max(0, event.nativeEvent.layout.width - RIBBON_INSET * 2))}>
                        {summaryState.summary ? (
                            <TickRibbon
                                ticks={summaryState.summary.ticks}
                                nowMs={summaryState.readAtMs}
                                windowDays={summaryState.summary.windowDays}
                                retentionDays={sessionsPeriod}
                                width={ribbonWidth}
                                compact={compact}
                            />
                        ) : summaryState.status === 'error' ? (
                            <Text style={styles.statLabel}>{t('planSurface.ribbonUnavailable')}</Text>
                        ) : null}
                    </View>
                    <View style={[styles.legend, { borderTopColor: theme.colors.border.default }]}>
                        {summaryState.summary ? (
                            <>
                            <View style={styles.legendKey}>
                                <View style={[styles.keyTick, { backgroundColor: theme.colors.text.primary }]} />
                                <Text style={styles.legendText}>{t('planSurface.ribbonKeySession')}</Text>
                            </View>
                            <View style={styles.legendKey}>
                                <View style={[styles.keyDot, { backgroundColor: theme.colors.supporter.accent }]} />
                                <Text style={styles.legendText}>{t('planSurface.ribbonKeyPinned')}</Text>
                            </View>
                            {summaryState.summary.ticks.some((tick) => tick.leaving) ? (
                                <View style={styles.legendKey}>
                                    <View style={[styles.keyTick, styles.keyOutline, { borderColor: theme.colors.text.secondary }]} />
                                    <Text style={styles.legendText}>{t('planSurface.ribbonKeyLeaving')}</Text>
                                </View>
                            ) : null}
                            </>
                        ) : null}
                        <View style={styles.grow} />
                        <ReviewLeavingLink />
                        <PlanTextLink
                            testID="plan-history-export"
                            label={t('planSurface.exportEverything')}
                            onPress={() => exportEverything(summaryState.summary?.sessions ?? null)}
                        />
                    </View>
                </ItemGroup>
                </LeavingSessionsProvider>
            ) : null}

            {isMember && data.plan ? (
                <ItemGroup title={t('planSurface.memberTitle')}>
                    <View style={[styles.offerRow, compact ? styles.offerRowCompact : null]} testID="plan-member-block">
                        <View style={[styles.passColumn, compact ? styles.centerSelf : null]}>
                            <SupporterPass editionLabel={data.plan.name} identity={identity} width={compact ? 220 : 230} />
                            {supporterTenure ? <Text style={styles.supporterTenure}>{supporterTenure}</Text> : null}
                            <SupporterPassStylePicker />
                        </View>
                        <View style={styles.memberContent}>
                            <Text style={styles.headline}>
                                {firstName ? t('planSurface.thankYouName', { name: firstName }) : t('planSurface.thankYou')}
                            </Text>
                            <Text style={styles.body}>
                                {t('planSurface.memberBody', { plan: data.plan.name, period: formatRetentionPeriod(sessionsPeriod) })}
                            </Text>
                            {data.plan.overdue ? <Text style={styles.overdue}>{t('planSurface.overdue')}</Text> : null}
                            <View style={[styles.facts, { borderColor: theme.colors.border.default }]}>
                                <MemberFact
                                    label={data.plan.renews ? t('planSurface.renews') : t('planSurface.ends')}
                                    value={data.plan.endsAt === null ? null : data.plan.renews
                                        ? t('planSurface.renewsValue', {
                                            date: formatPlanDate(data.plan.endsAt),
                                            price: formatPrice(monthlyPrice(offers?.plans.find((plan) => plan.id === data.plan?.id) ?? { prices: [] })),
                                        })
                                        : formatPlanDate(data.plan.endsAt)}
                                />
                                <MemberFact label={t('planSurface.billedBy')} value={billedByLabel(data.plan.source)} />
                                {offers ? <MemberFact label={t('planSurface.ifYouCancel')} value={t('planSurface.nothingLeavesFor', { days: offers.graceDays })} /> : null}
                            </View>
                            <View style={styles.grow} />
                            <View style={styles.ctaRow}>
                                {hostedCheckout || (storeCheckout && (data.plan.source === 'app_store' || data.plan.source === 'play')) ? (
                                    <RoundButton
                                        size="normal"
                                        display="outline"
                                        leading={<Icon name="arrow-square-out" size={16} color={theme.colors.text.primary} />}
                                        title={t('planSurface.manage')}
                                        action={manage}
                                        testID="plan-manage"
                                    />
                                ) : null}
                                {data.plan.overdue ? (
                                    <RoundButton size="normal" display="inverted" title={t('planSurface.checkAgain')} loading={checking} action={checkAgain} />
                                ) : null}
                            </View>
                        </View>
                    </View>
                </ItemGroup>
            ) : null}

            {!isMember && isSupporter && identity ? (
                <ItemGroup title={t('planSurface.passSupporterEdition')}>
                    <View style={[styles.offerRow, compact ? styles.offerRowCompact : null]}>
                        <View style={[styles.passColumn, compact ? styles.centerSelf : null]}>
                            <SupporterPass editionLabel={t('planSurface.passSupporterEdition')} identity={identity} width={compact ? 220 : 230} />
                            {supporterTenure ? <Text style={styles.supporterTenure}>{supporterTenure}</Text> : null}
                            <SupporterPassStylePicker />
                        </View>
                        <View style={styles.memberContent}>
                            <Text style={styles.headline}>
                                {firstName ? t('planSurface.thankYouName', { name: firstName }) : t('planSurface.thankYou')}
                            </Text>
                            <Text style={styles.body}>{t('planSurface.thanksBody', { number: formatSupporterNumber(identity.number) })}</Text>
                        </View>
                    </View>
                </ItemGroup>
            ) : null}

            {props.plans && upgrade ? (
                <ItemGroup clipContent title={t('planSurface.keepMoreTitle')} footer={planLadderFootnote({ purchasable: purchasable, graceDays: offers?.graceDays ?? 0 })}>
                    <View style={styles.leadWrap}>
                        <Text style={styles.body}>
                            {isMember && data.plan
                                ? t('planSurface.keepMoreLeadMember', { plan: upgrade.name })
                                // A supporter already has the pack; the plans' pitch to them is history alone.
                                : (isSupporter ? t('planSurface.keepMoreLeadSupporter', { plans: paidPlanNames }) : t('planSurface.keepMoreLeadFree', { plans: paidPlanNames }))}
                        </Text>
                    </View>
                    <PlanLadder
                        columns={ladder}
                        compact={compact}
                        purchasable={purchasable}
                        busyPlanId={busyPlanId}
                        onChoosePlan={(id) => void choosePlan(id)}
                    />
                    {pendingPlanId ? (
                        <PendingCheckoutLine checking={checking} onCheckAgain={checkAgain} onCancel={() => setPendingPlanId(null)} />
                    ) : null}
                </ItemGroup>
            ) : null}

            {storeCheckout ? (
                <ItemGroup>
                    <Item testID="plan-restore-purchases" title={t('planSurface.restorePurchases')} onPress={checking ? undefined : restore} />
                </ItemGroup>
            ) : null}
            {inlineError ? <Text style={[styles.inlineError, contentWidth]}>{inlineError}</Text> : null}

            {props.supporter && (isMember || isSupporter) ? (
                <ItemGroup title={t('planSurface.packTitle')} columns={compact ? 1 : 2}>
                    {SUPPORTER_PACK_PERKS.map((perk) => (
                        <Item
                            key={perk.id}
                            mode="info"
                            icon={<Icon name={perk.icon} size={22} color={theme.colors.text.secondary} />}
                            title={t(perk.title)}
                            subtitle={perkSubtitle(perk.id, data)}
                            subtitleLines={0}
                            showChevron={false}
                        />
                    ))}
                </ItemGroup>
            ) : null}

            {props.supporter && isSupporter ? (
                <ItemGroup>
                    <Item
                        testID="plan-supporter-ring"
                        title={t('planSurface.ringTitle')}
                        subtitle={t('planSurface.ringSubtitle')}
                        subtitleLines={0}
                        showChevron={false}
                        rightElement={<Switch value={data.supporterRing} onValueChange={setRing} accessibilityLabel={t('planSurface.ringTitle')} />}
                    />
                    <SupporterDiscordLinkRow />
                </ItemGroup>
            ) : null}

            {supporterOffer && !isMember && !isSupporter ? (
                <ItemGroup title={t('planSurface.supportTitle')}>
                    <SupporterOfferBlock
                        compact={compact}
                        primary={!cloudPlans}
                        fromLabel={t('planSurface.fromAmount', { amount: formatMinorAmount(supporterOffer.minimumMinor, supporterOffer.currency) })}
                        cloudPlanLine={packPlan && packPlanPrice
                            ? t('planSurface.cloudPlanIncludesPack', { plan: packPlan.name, price: formatPrice(packPlanPrice) })
                            : null}
                        onSupport={canPurchaseSupporterOffer(supporterOffer) ? () => openSupporterSheet(null) : null}
                    />
                </ItemGroup>
            ) : null}

            <ItemGroup title={t('planSurface.yourHistoryTitle')}>
                <Item
                    testID="plan-export-everything"
                    title={t('planSurface.exportEverything')}
                    detail={t('planSurface.exportFormats')}
                    icon={<Icon name="download" size={22} color={theme.colors.text.secondary} />}
                    onPress={() => exportEverything(summaryState.summary?.sessions ?? null)}
                />
                <Item
                    testID="plan-local-history"
                    title={t('planSurface.localHistory')}
                    detail={t('planSurface.localHistoryHint')}
                    icon={<Icon name="hard-drives" size={22} color={theme.colors.text.secondary} />}
                    onPress={() => router.push('/settings/session/local-history')}
                />
            </ItemGroup>
        </ItemList>
    );
});

function SupporterDiscordLinkRow() {
    const { theme } = useUnistyles();
    const actions = React.useMemo(() => createDefaultActionExecutor(), []);
    const [status, setStatus] = React.useState<'idle' | 'loading' | 'error'>('idle');
    const link = React.useCallback(async () => {
        setStatus('loading');
        try {
            const result = await actions.execute('supporter.discord.link', {}, { surface: 'ui_button' });
            setStatus(result.ok ? 'idle' : 'error');
        } catch {
            setStatus('error');
        }
    }, [actions]);

    return (
        <>
            <Item
                testID="plan-supporter-discord"
                title={t('planSurface.discordLinkTitle')}
                icon={<Icon name="discord-logo" size={22} color={theme.colors.text.secondary} />}
                loading={status === 'loading'}
                onPress={link}
            />
            {status === 'error' ? (
                <Text style={styles.inlineError} accessibilityRole="alert" testID="plan-supporter-discord-error">
                    {t('planSurface.discordLinkFailed')}
                </Text>
            ) : null}
        </>
    );
}

function perkSubtitle(id: (typeof SUPPORTER_PACK_PERKS)[number]['id'], data: AccountPlanResponseV1): string {
    switch (id) {
        case 'number': return t('planSurface.perkNumberBody');
        case 'pass': return t('planSurface.perkPassBody');
        case 'listed': return t('planSurface.perkListedBody', { number: data.supporter.number ? formatSupporterNumber(data.supporter.number) : '····' });
        case 'credits': return t('planSurface.perkCreditsBody');
    }
}

const STORY_FACTS = [
    { icon: 'code', label: 'planSurface.storyFactOpenSource' },
    { icon: 'globe', label: 'planSurface.storyFactEverywhere' },
    { icon: 'heart', label: 'planSurface.storyFactSupporters' },
] as const satisfies ReadonlyArray<Readonly<{ icon: IconName; label: TranslationKeyNoParams }>>;

/**
 * Why the page exists, before any chart: Happier is independent and MIT open source, every feature
 * is free everywhere, and supporters (and, on Cloud, plans) are what fund it. A person who is not a
 * supporter yet is invited to the permanent number, with no number promised until the server gives one.
 */
function PlanStory(props: Readonly<{ cloudPlans: boolean; onClaimNumber: ((prefilledCode: string | null) => void) | null }>) {
    const { theme } = useUnistyles();
    const { onClaimNumber } = props;
    return (
        <View style={styles.story} testID="plan-story">
            <Text style={styles.storyLead}>{t('planSurface.storyLede')}</Text>
            <Text style={styles.storyBody}>{props.cloudPlans ? t('planSurface.storyBodyCloud') : t('planSurface.storyBodySelf')}</Text>
            <View style={[styles.storyFacts, { borderTopColor: theme.colors.border.default }]}>
                {STORY_FACTS.map((fact) => (
                    <View key={fact.icon} style={styles.storyFact}>
                        <Icon name={fact.icon} size={15} color={fact.icon === 'heart' ? theme.colors.supporter.accent : theme.colors.text.secondary} />
                        <Text style={styles.storyFactText}>{t(fact.label)}</Text>
                    </View>
                ))}
            </View>
            {onClaimNumber ? (
                <Pressable
                    testID="plan-story-claim-number"
                    accessibilityRole="button"
                    onPress={() => onClaimNumber(null)}
                    style={({ pressed }) => [styles.storyInvite, { backgroundColor: theme.colors.supporter.tint }, pressed ? styles.storyInvitePressed : null]}
                >
                    <Icon name="star" weight="fill" size={14} color={theme.colors.supporter.accent} />
                    <Text style={[styles.storyInviteText, { color: theme.colors.supporter.onTint }]}>{t('planSurface.storyNumberInvite')}</Text>
                    <Icon name="arrow-right" size={14} color={theme.colors.supporter.onTint} />
                </Pressable>
            ) : null}
        </View>
    );
}

function PlanChip(props: Readonly<{ data: AccountPlanResponseV1; cloudPlans: boolean }>) {
    const number = props.data.supporter.active && props.data.supporter.number ? formatSupporterNumber(props.data.supporter.number) : null;
    if (props.data.plan) {
        return <GoldChip label={number ? t('planSurface.chipPlanNumber', { plan: props.data.plan.name, number }) : props.data.plan.name} />;
    }
    if (number) return <GoldChip label={t('planSurface.chipSupporterNumber', { number })} />;
    return props.cloudPlans
        ? <StatusPill variant="neutral" label={t('planSurface.free')} labelVariant="phrase" />
        : null;
}

/** The lab's gold chip: the supporter wash with its own ink, led by the filled star. */
function GoldChip(props: Readonly<{ label: string }>) {
    const { theme } = useUnistyles();
    return (
        <StatusPill
            variant="neutral"
            hideDot
            leading={<Icon name="star" weight="fill" size={12} color={theme.colors.supporter.accent} />}
            foregroundColor={theme.colors.supporter.onTint}
            style={{ backgroundColor: theme.colors.supporter.tint }}
            label={props.label}
            labelVariant="phrase"
        />
    );
}

/**
 * The history card's chip: a member's "Kept a year after last use" in gold; on Free, the next
 * batch leaving ("4 leave on 31 Dec") from the same leaving read the session list uses.
 */
function HistoryChip(props: Readonly<{ isMember: boolean; keptForLabel: string | null }>) {
    const view = useLeavingSessionsView();
    if (props.isMember) return props.keptForLabel ? <GoldChip label={props.keptForLabel} /> : null;
    if (view) {
        return (
            <StatusPill
                variant="neutral"
                label={t('planSurface.leavingOn', { count: view.count, date: formatLeavingDate(view.soonestLeavesAt, Date.now()) })}
                labelVariant="phrase"
                testID="plan-history-leaving"
            />
        );
    }
    return props.keptForLabel ? <StatusPill variant="neutral" label={props.keptForLabel} labelVariant="phrase" /> : null;
}

/** "Review 4 leaving": opens Keep or let go on the batch the session list foot counts. */
function ReviewLeavingLink() {
    const view = useLeavingSessionsView();
    if (!view) return null;
    return <PlanTextLink testID="plan-review-leaving" label={t('planSurface.reviewLeaving', { count: view.count })} onPress={showKeepOrLetGoSheet} />;
}

function MemberFact(props: Readonly<{ label: string; value: string | null }>) {
    if (props.value === null) return null;
    return (
        <View style={styles.fact}>
            <Text style={styles.factLabel}>{props.label}</Text>
            <Text style={styles.factValue}>{props.value}</Text>
        </View>
    );
}

function PendingCheckoutLine(props: Readonly<{ checking: boolean; onCheckAgain: () => Promise<void>; onCancel: () => void }>) {
    return (
        <View style={styles.pending} testID="plan-checkout-pending">
            <Text style={styles.pendingText}>{t('planSurface.pendingLine')}</Text>
            <View style={styles.ctaRow}>
                <RoundButton size="small" title={t('planSurface.checkAgain')} loading={props.checking} action={props.onCheckAgain} testID="plan-check-again" />
                <RoundButton size="small" display="inverted" title={t('planSurface.cancel')} onPress={props.onCancel} />
            </View>
        </View>
    );
}

const styles = StyleSheet.create((theme) => ({
    list: {
        paddingTop: 0,
    },
    hero: {
        width: '100%',
        alignSelf: 'center',
        paddingHorizontal: (Platform.select(ITEM_GROUP_CONTAINER_HORIZONTAL_PADDING_PX) ?? 0) + 12,
        paddingTop: 28,
        paddingBottom: 8,
        gap: 6,
    },
    title: {
        ...Typography.default('semiBold'),
        flexShrink: 1,
        fontSize: 32,
        lineHeight: 38,
        letterSpacing: -0.6,
        color: theme.colors.text.primary,
    },
    heroRow: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 12,
    },
    heroRowCompact: {
        flexDirection: 'column',
        alignItems: 'flex-start',
    },
    story: {
        gap: 10,
        marginTop: 16,
        maxWidth: 660,
    },
    // The lede is the page's voice: larger and calm, set a touch tight like the title above it.
    storyLead: {
        ...Typography.default('semiBold'),
        fontSize: 21,
        lineHeight: 28,
        letterSpacing: -0.3,
        color: theme.colors.text.primary,
    },
    storyBody: {
        ...Typography.default(),
        fontSize: 16,
        lineHeight: 24,
        color: theme.colors.text.secondary,
    },
    storyFacts: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        columnGap: 22,
        rowGap: 8,
        marginTop: 6,
        paddingTop: 14,
        borderTopWidth: StyleSheet.hairlineWidth,
    },
    storyFact: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 7,
    },
    storyFactText: {
        ...Typography.default('semiBold'),
        fontSize: 13,
        lineHeight: 18,
        color: theme.colors.text.secondary,
    },
    storyInvite: {
        flexDirection: 'row',
        alignItems: 'center',
        alignSelf: 'flex-start',
        gap: 8,
        marginTop: 6,
        paddingHorizontal: 12,
        minHeight: 36,
        borderRadius: 18,
    },
    storyInvitePressed: {
        transform: [{ scale: 0.98 }],
        opacity: 0.85,
    },
    storyInviteText: {
        ...Typography.default('semiBold'),
        flexShrink: 1,
        fontSize: 14,
        lineHeight: 19,
    },
    passColumn: {
        alignItems: 'center',
        gap: 14,
    },
    supporterTenure: {
        ...Typography.rowMeta(),
        color: theme.colors.text.secondary,
        maxWidth: 230,
        textAlign: 'center',
    },
    staleRow: {
        width: '100%',
        alignSelf: 'center',
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        paddingHorizontal: 20,
    },
    staleText: {
        ...Typography.default(),
        fontSize: 13,
        color: theme.colors.text.secondary,
    },
    stateBody: {
        padding: 24,
        gap: 10,
        alignItems: 'flex-start',
    },
    stateTitle: {
        ...Typography.default('semiBold'),
        fontSize: 17,
        color: theme.colors.text.primary,
    },
    stateText: {
        ...Typography.default(),
        fontSize: 15,
        lineHeight: 21,
        color: theme.colors.text.secondary,
    },
    historyTop: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: 28,
        padding: 20,
    },
    historyTopCompact: {
        flexWrap: 'wrap',
        gap: 16,
    },
    stat: {
        gap: 2,
    },
    ribbonWrap: {
        paddingHorizontal: RIBBON_INSET,
        paddingBottom: 16,
    },
    legend: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: 18,
        marginHorizontal: 20,
        paddingVertical: 14,
        borderTopWidth: 1,
    },
    legendKey: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
    },
    legendText: {
        ...Typography.default(),
        fontSize: 14,
        color: theme.colors.text.secondary,
    },
    keyTick: {
        width: 2,
        height: 11,
        borderRadius: 1,
    },
    keyOutline: {
        width: 4,
        borderWidth: 1,
        backgroundColor: 'transparent',
    },
    keyDot: {
        width: 5,
        height: 5,
        borderRadius: 2.5,
    },
    statValue: {
        ...Typography.default('semiBold'),
        fontSize: 26,
        lineHeight: 30,
        letterSpacing: -0.4,
        color: theme.colors.text.primary,
        fontVariant: ['tabular-nums'],
    },
    statLabel: {
        ...Typography.default(),
        fontSize: 14,
        color: theme.colors.text.secondary,
    },
    grow: {
        flex: 1,
    },
    offerRow: {
        flexDirection: 'row',
        gap: 36,
        padding: 28,
    },
    offerRowCompact: {
        flexDirection: 'column',
        gap: 24,
        padding: 20,
    },
    centerSelf: {
        alignSelf: 'center',
    },
    memberContent: {
        flex: 1,
        gap: 12,
    },
    headline: {
        ...Typography.default('semiBold'),
        fontSize: 24,
        lineHeight: 30,
        letterSpacing: -0.3,
        color: theme.colors.text.primary,
    },
    body: {
        ...Typography.default(),
        fontSize: 16,
        lineHeight: 23,
        color: theme.colors.text.secondary,
    },
    overdue: {
        ...Typography.default(),
        fontSize: 15,
        lineHeight: 21,
        color: theme.colors.state.danger.foreground,
    },
    facts: {
        borderWidth: 1,
        borderRadius: 14,
        marginTop: 4,
    },
    // Wraps instead of squeezing: on a phone the value drops under its label whole rather than
    // breaking both into two-line fragments.
    fact: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        justifyContent: 'space-between',
        columnGap: 16,
        rowGap: 2,
        paddingHorizontal: 18,
        paddingVertical: 14,
    },
    factLabel: {
        ...Typography.default(),
        flexShrink: 0,
        fontSize: 15,
        color: theme.colors.text.secondary,
    },
    factValue: {
        ...Typography.default(),
        flexShrink: 1,
        textAlign: 'right',
        fontSize: 15,
        color: theme.colors.text.primary,
        fontVariant: ['tabular-nums'],
    },
    ctaRow: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: 12,
    },
    leadWrap: {
        paddingHorizontal: 20,
        paddingTop: 18,
        paddingBottom: 6,
    },
    pending: {
        gap: 10,
        padding: 20,
        borderTopWidth: 1,
        borderTopColor: theme.colors.border.default,
    },
    pendingText: {
        ...Typography.default(),
        fontSize: 15,
        color: theme.colors.text.primary,
    },
    inlineError: {
        width: '100%',
        alignSelf: 'center',
        ...Typography.default(),
        fontSize: 14,
        color: theme.colors.state.danger.foreground,
        paddingHorizontal: 20,
    },
}));
