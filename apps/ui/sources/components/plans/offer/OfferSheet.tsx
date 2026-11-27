import * as React from 'react';
import { useWindowDimensions, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import type { SupporterOfferV1 } from '@happier-dev/protocol';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { SegmentedTabBar } from '@/components/ui/navigation/SegmentedTabBar';
import { Text, TextInput } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import type { CustomModalInjectedProps } from '@/modal';
import { useModalCardChrome } from '@/modal/components/card/useModalCardChrome';
import { log } from '@/log';
import { putSupporterRing } from '@/sync/api/account/apiAccountPlan';
import { useAccountPlanValue, type AccountPlanEntry } from '@/sync/domains/plans/accountPlanResource';
import { applySupporterCode, checkPurchaseAgain, loadSupporterStorePackages, openSupporterCheckout, supportsHostedCheckout } from '@/sync/domains/purchases/purchaseFlow';
import type { Package } from '@/sync/domains/purchases/types';
import { createDefaultActionExecutor } from '@/sync/ops/actions/defaultActionExecutor';
import { t } from '@/text';

import { formatMinorAmount, formatSupporterNumber } from '../planSurfaceCopy';
import { PlanTextLink } from '../PlanTextLink';
import { SupporterPass } from '../pass/SupporterPass';
import { SupporterPassStylePicker } from '../pass/SupporterPassStylePicker';
import { SupporterThanks } from './SupporterThanks';
import { AmountPicker, resolveAmountMinor, type AmountChoice } from './AmountPicker';
import { SupporterPackPerkGrid } from './SupporterOfferBlock';

type Interval = 'monthly' | 'once';

/** Side by side needs the full 700 pt dialog: a 210 pt pass and perks that each fit one line. */
const WIDE_SHEET_MIN_WINDOW_PX = 740;
type Step = 'choose' | 'pending' | 'thanks';

export type OfferSheetProps = CustomModalInjectedProps & Readonly<{
    offer: SupporterOfferV1;
    accountId: string;
    /** Web and desktop on a server other than Happier Cloud: "Already a supporter? Paste your code". */
    allowCodePaste: boolean;
    /** From `happier://settings/plan?supporterCode=…`: prefilled, applied only on a press. */
    prefilledCode: string | null;
    profileName?: string | null;
}>;

const selectSupporterIdentity = (entry: AccountPlanEntry) => entry.data?.supporter ?? null;
const selectRing = (entry: AccountPlanEntry) => entry.data?.supporterRing ?? false;

function initialChoice(offer: SupporterOfferV1, interval: Interval): AmountChoice {
    const presets = offer.presets[interval];
    const suggested = interval === 'monthly' && presets.includes(offer.suggestedMonthlyMinor) ? offer.suggestedMonthlyMinor : presets[0];
    return suggested === undefined ? { otherText: '' } : { presetMinor: suggested };
}

/**
 * The Supporter sheet (plan 04 U4): choose monthly or once and an amount, finish in the browser,
 * then the thank-you with the pass turning to the person's number and the ring switch on.
 */
export function OfferSheet(props: OfferSheetProps) {
    const { theme } = useUnistyles();
    const { offer } = props;
    const [step, setStep] = React.useState<Step>('choose');
    const [interval, setInterval] = React.useState<Interval>(() =>
        !offer.checkoutUrls?.monthly && offer.checkoutUrls?.once ? 'once' : 'monthly',
    );
    const [choice, setChoice] = React.useState<AmountChoice>(() => initialChoice(offer, interval));
    const [busy, setBusy] = React.useState(false);
    const [error, setError] = React.useState<string | null>(null);
    const [codeOpen, setCodeOpen] = React.useState(props.prefilledCode !== null);
    const [code, setCode] = React.useState(props.prefilledCode ?? '');
    const hosted = supportsHostedCheckout();
    // The pass and its story sit side by side on a dialog-wide sheet and stack on a phone.
    const wide = useWindowDimensions().width >= WIDE_SHEET_MIN_WINDOW_PX;
    const actions = React.useMemo(() => createDefaultActionExecutor(), []);
    const [githubPending, setGithubPending] = React.useState(false);
    const claimGitHub = React.useCallback(async () => {
        setGithubPending(true);
        try {
            const result = await actions.execute('supporter.github.link', {}, { surface: 'ui_button' });
            if (!result.ok) setError(t('planSurface.checkFailed'));
        } finally {
            setGithubPending(false);
        }
    }, [actions]);
    const [storePackages, setStorePackages] = React.useState<Package[] | null>(null);
    React.useEffect(() => {
        if (hosted) return;
        let current = true;
        void loadSupporterStorePackages(offer, props.accountId).then((packages) => {
            if (current) setStorePackages(packages);
        }).catch(() => {
            if (current) {
                log.log('[supporter] store offers could not be loaded');
                setStorePackages([]);
            }
        });
        return () => { current = false; };
    }, [hosted, offer, props.accountId]);

    const supporter = useAccountPlanValue(selectSupporterIdentity);
    const ring = useAccountPlanValue(selectRing);
    const joined = supporter?.active === true && supporter.number !== null;
    // Set only by this sheet's own purchase: a checkout it opened or a code it applied.
    const [purchaseStarted, setPurchaseStarted] = React.useState(false);

    // The thank-you follows the supporter fact arriving after this flow's own purchase (the push
    // after a checkout, Check again, or an applied code). A plan read that merely lands while the
    // sheet is open — an existing supporter, or a gift — never reaches it, and never writes the ring.
    React.useEffect(() => {
        if (purchaseStarted && joined && step !== 'thanks') setStep('thanks');
    }, [joined, purchaseStarted, step]);

    // The buyer's own flow turns the ring on once, at the thank-you, and shows the switch on.
    // A purchase alone never does, so a gift by someone else never marks anyone (Decided 11).
    const ringWritten = React.useRef(false);
    React.useEffect(() => {
        if (step !== 'thanks' || ringWritten.current) return;
        ringWritten.current = true;
        void putSupporterRing(true).catch(() => setError(t('planSurface.ringFailed')));
    }, [step]);

    const amountMinor = resolveAmountMinor(choice);
    const belowMinimum = amountMinor !== null && amountMinor < offer.minimumMinor;
    const checkoutUrl = offer.checkoutUrls?.[interval] ?? null;
    const amountLabel = amountMinor !== null ? formatMinorAmount(amountMinor, offer.currency) : null;
    const minimumReason = t('planSurface.minimumAmount', { amount: formatMinorAmount(offer.minimumMinor, offer.currency) });
    const disabledReason = !checkoutUrl
        ? t('planSurface.checkoutUnavailable')
        : amountMinor === null || belowMinimum ? minimumReason : null;

    const pay = React.useCallback(async (storeProductId?: string) => {
        if (hosted && (amountMinor === null || belowMinimum || !checkoutUrl)) return;
        setBusy(true);
        setError(null);
        const result = await openSupporterCheckout({
            offer, interval: hosted ? interval : 'once', accountId: props.accountId,
            amountMinor: hosted ? amountMinor ?? undefined : undefined, storeProductId,
        });
        setBusy(false);
        if (result === 'opened') {
            setPurchaseStarted(true);
            setStep('pending');
        }
        else setError(result === 'unavailable' ? t('planSurface.checkoutUnavailable') : t('planSurface.checkoutOpenFailed'));
    }, [amountMinor, belowMinimum, checkoutUrl, hosted, interval, offer, props.accountId]);

    const checkAgain = React.useCallback(async () => {
        if (step !== 'pending' || busy) return;
        setBusy(true);
        setError(null);
        try {
            await checkPurchaseAgain();
        } catch {
            setError(t('planSurface.checkFailed'));
        } finally {
            setBusy(false);
        }
    }, [busy, step]);

    const applyCode = React.useCallback(async () => {
        setBusy(true);
        setError(null);
        const result = await applySupporterCode(code);
        setBusy(false);
        if (result === 'applied') setPurchaseStarted(true);
        if (result === 'invalid') setError(t('planSurface.codeInvalid'));
        else if (result === 'not_found') setError(t('planSurface.codeNotFound'));
        else if (result === 'conflict') setError(t('planSurface.codeConflict'));
        else if (result === 'failed') setError(t('planSurface.checkFailed'));
    }, [code]);

    const chrome = React.useMemo(() => ({
        kind: 'card' as const,
        title: step === 'thanks' ? t('planSurface.thanksTitle') : t('planSurface.sheetTitle'),
        // Choosing leads with the blank pass and its line in the body, as the lab draws it.
        // Choosing carries its own headline beside the pass, so the bar gives way to a floating close;
        // the title still names the dialog for assistive tech.
        header: step === 'choose' ? 'floatingClose' as const : 'bar' as const,
        subtitle: step === 'choose' ? undefined
            : step === 'pending' ? t('planSurface.pendingLine')
            : supporter?.number != null ? t('planSurface.thanksBody', { number: formatSupporterNumber(supporter.number) }) : undefined,
        testID: 'supporter-offer-sheet',
        bodyScroll: 'auto' as const,
        dimensions: { width: 700, maxHeightRatio: 0.9, size: 'dialog' as const },
    }), [step, supporter?.number]);
    useModalCardChrome(props.setChrome, chrome);

    if (step === 'thanks' && supporter?.number != null) {
        return (
            <SupporterThanks
                identity={{ number: supporter.number, name: props.profileName ?? null, sinceMs: supporter.since }}
                ring={ring}
                onRingChange={(visible) => {
                    void putSupporterRing(visible).catch(() => setError(t('planSurface.ringFailed')));
                }}
                error={error}
                onDone={props.onClose}
            />
        );
    }

    if (step === 'pending') {
        return (
            <View style={styles.body} testID="supporter-pending">
                <View style={styles.passRow}>
                    <SupporterPass editionLabel={t('planSurface.passSupporterEdition')} identity={null} width={180} />
                </View>
                {error ? <Text style={styles.error}>{error}</Text> : null}
                <View style={styles.actions}>
                    <RoundButton title={t('planSurface.checkAgain')} size="normal" loading={busy} action={checkAgain} testID="supporter-check-again" />
                    <RoundButton title={t('planSurface.cancel')} size="normal" display="inverted" onPress={() => setStep('choose')} />
                </View>
            </View>
        );
    }

    return (
        <View style={styles.body} testID="supporter-choose">
            <View style={[styles.hero, wide ? styles.heroWide : null]} testID="supporter-offer-hero">
                <View style={styles.heroPass}>
                    <SupporterPass editionLabel={t('planSurface.passSupporterEdition')} identity={null} width={wide ? 210 : 180} />
                    {wide ? null : <SupporterPassStylePicker />}
                </View>
                <View style={[styles.heroText, wide ? styles.heroTextWide : null]}>
                    <Text style={[styles.headline, wide ? styles.headlineWide : styles.centered]}>{t('planSurface.sheetHeadline')}</Text>
                    <Text style={[styles.leadText, wide ? null : styles.centered]}>{t('planSurface.sheetSubtitle')}</Text>
                    <SupporterPackPerkGrid stacked={false} />
                    {/* Beside the pass, the switcher closes the text column; on a phone it sits under the pass. */}
                    {wide ? <View style={styles.pickerSlot}><SupporterPassStylePicker align="start" /></View> : null}
                </View>
            </View>
            {hosted ? <>
            <SegmentedTabBar
                testIDPrefix="supporter-interval"
                tabs={[
                    { id: 'monthly', label: t('planSurface.monthly') },
                    { id: 'once', label: t('planSurface.once') },
                ]}
                activeTabId={interval}
                onSelectTab={(next) => {
                    setInterval(next);
                    setChoice(initialChoice(offer, next));
                }}
            />
            <AmountPicker
                presetsMinor={offer.presets[interval]}
                suggestedMinor={interval === 'monthly' ? offer.suggestedMonthlyMinor : null}
                currency={offer.currency}
                choice={choice}
                onChange={setChoice}
                disabled={busy}
            />
            {disabledReason && 'otherText' in choice ? <Text style={styles.reason}>{disabledReason}</Text> : null}
            {!checkoutUrl ? <Text style={styles.reason}>{t('planSurface.checkoutUnavailable')}</Text> : null}
            <RoundButton
                testID="supporter-checkout-cta"
                size="normal"
                display="contrast"
                title={amountLabel
                    ? (interval === 'monthly' ? t('planSurface.payMonthly', { amount: amountLabel }) : t('planSurface.payOnce', { amount: amountLabel }))
                    : t('planSurface.supportCta')}
                disabled={disabledReason !== null || busy}
                accessibilityHint={disabledReason ?? undefined}
                loading={busy}
                onPress={() => void pay()}
            />
            </> : (
                <>
                    {storePackages?.length === 0 ? <Text style={styles.reason}>{t('planSurface.checkoutUnavailable')}</Text> : null}
                    {storePackages?.map((tier) => (
                        <RoundButton
                            key={tier.identifier}
                            size="normal"
                            title={t('planSurface.payOnce', { amount: tier.product.priceString })}
                            disabled={busy}
                            onPress={() => void pay(tier.product.identifier)}
                        />
                    ))}
                </>
            )}
            {error ? <Text style={styles.error} testID="supporter-offer-error">{error}</Text> : null}
            {hosted || props.allowCodePaste ? (
                // One footer for the two quiet ways in, aligned on one row: an existing supporter's
                // code on the left, a GitHub sponsorship on the right; they wrap whole on a phone.
                <View style={[styles.footer, { borderTopColor: theme.colors.border.default }]} testID="supporter-offer-footer">
                    {props.allowCodePaste ? (
                        codeOpen ? (
                            <View style={styles.codeRow}>
                                <TextInput
                                    testID="supporter-code-input"
                                    value={code}
                                    onChangeText={setCode}
                                    placeholder={t('planSurface.pasteCode')}
                                    accessibilityLabel={t('planSurface.pasteCode')}
                                    autoCapitalize="none"
                                    autoCorrect={false}
                                    style={[styles.codeInput, { borderColor: theme.colors.border.default }]}
                                />
                                <RoundButton title={t('planSurface.applyCode')} size="small" loading={busy} disabled={!code.trim()} action={applyCode} testID="supporter-code-apply" />
                            </View>
                        ) : (
                            <PlanTextLink label={t('planSurface.alreadySupporter')} onPress={() => setCodeOpen(true)} testID="supporter-code-open" />
                        )
                    ) : null}
                    {hosted ? (
                        <View style={styles.footerEnd}>
                            <PlanTextLink label={t('planSurface.claimGitHubSponsor')} disabled={githubPending} onPress={() => void claimGitHub()} testID="supporter-github-claim" />
                        </View>
                    ) : null}
                </View>
            ) : null}
        </View>
    );
}

const styles = StyleSheet.create((theme) => ({
    body: {
        gap: 16,
        paddingHorizontal: 16,
        paddingVertical: 16,
    },
    passRow: {
        alignItems: 'center',
        paddingVertical: 8,
    },
    // Room above and around the pass so its edge and shadow never meet the sheet's scroll edge.
    hero: {
        alignItems: 'center',
        gap: 20,
        paddingTop: 12,
        paddingBottom: 4,
    },
    // Side by side, the headline starts flush with the pass's top edge.
    heroWide: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: 28,
        paddingHorizontal: 8,
    },
    heroPass: {
        alignItems: 'center',
        gap: 12,
    },
    heroText: {
        alignSelf: 'stretch',
        gap: 10,
    },
    // Clear of the floating close button in the corner.
    heroTextWide: {
        flex: 1,
        alignSelf: 'flex-start',
        gap: 12,
    },
    // 28 pt from the perks (with the column's 12 pt gap): the style choice is its own group.
    pickerSlot: {
        marginTop: 16,
    },
    headline: {
        ...Typography.default('semiBold'),
        fontSize: 20,
        lineHeight: 26,
        letterSpacing: -0.2,
        color: theme.colors.text.primary,
    },
    // Line box to cap height: pulls the first line's glyph tops level with the pass's top edge.
    // Clear of the floating close button in the corner; only the headline reaches that high.
    headlineWide: {
        marginTop: -4,
        paddingRight: 28,
    },
    leadText: {
        ...Typography.default(),
        fontSize: 15,
        lineHeight: 22,
        color: theme.colors.text.secondary,
    },
    centered: {
        textAlign: 'center',
    },
    footer: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 10,
        paddingTop: 14,
        borderTopWidth: 1,
    },
    // The sponsorship link keeps the right edge even when it is the footer's only action.
    footerEnd: {
        marginLeft: 'auto',
    },
    reason: {
        ...Typography.default(),
        fontSize: 13,
        color: theme.colors.text.secondary,
    },
    error: {
        ...Typography.default(),
        fontSize: 13,
        color: theme.colors.state.danger.foreground,
    },
    actions: {
        flexDirection: 'row',
        justifyContent: 'center',
        gap: 12,
    },
    codeRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        flexGrow: 1,
        flexBasis: 260,
    },
    codeInput: {
        ...Typography.mono(),
        flex: 1,
        fontSize: 13,
        borderWidth: 1,
        borderRadius: 10,
        paddingHorizontal: 10,
        paddingVertical: 8,
        color: theme.colors.text.primary,
    },
}));
