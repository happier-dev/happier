import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Icon, type IconName } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t, type TranslationKeyNoParams } from '@/text';

import { SupporterPass } from '../pass/SupporterPass';
import { SupporterPassStylePicker } from '../pass/SupporterPassStylePicker';

/** The Supporter pack's Wave 1 deliverables, in the pack's own words (owner, 2026-11-26). */
export const SUPPORTER_PACK_PERKS: ReadonlyArray<Readonly<{
    id: 'number' | 'pass' | 'listed' | 'credits';
    icon: IconName;
    short: TranslationKeyNoParams;
    title: TranslationKeyNoParams;
}>> = [
    { id: 'number', icon: 'medal', short: 'planSurface.perkNumberShort', title: 'planSurface.perkNumber' },
    { id: 'pass', icon: 'user-circle', short: 'planSurface.perkPassShort', title: 'planSurface.perkPass' },
    { id: 'listed', icon: 'link', short: 'planSurface.perkListedShort', title: 'planSurface.perkListed' },
    { id: 'credits', icon: 'list', short: 'planSurface.perkCreditsShort', title: 'planSurface.perkCredits' },
];

export type SupporterOfferBlockProps = Readonly<{
    compact: boolean;
    /** Primary on a page whose only offer this is (Support Happier); secondary beside plans. */
    primary: boolean;
    /** "From $3, monthly or once", formatted from the server's minimum. */
    fromLabel: string;
    /** Happier Cloud only: the cheapest plan that already includes the pack (PROGRAM Q30). */
    cloudPlanLine: string | null;
    /** Null where the pack cannot be bought on this platform yet. */
    onSupport: (() => void) | null;
}>;

/** The pack's four items in their short words: two columns, or one per line when `stacked`. */
export function SupporterPackPerkGrid(props: Readonly<{ stacked: boolean }>) {
    const { theme } = useUnistyles();
    return (
        <View style={styles.perks}>
            {SUPPORTER_PACK_PERKS.map((perk) => (
                <View key={perk.id} style={[styles.perk, props.stacked ? styles.perkStacked : null]}>
                    <Icon name={perk.icon} size={16} color={theme.colors.text.secondary} />
                    <Text style={styles.perkText}>{t(perk.short)}</Text>
                </View>
            ))}
        </View>
    );
}

export const SupporterOfferBlock = React.memo(function SupporterOfferBlock(props: SupporterOfferBlockProps) {
    const { theme } = useUnistyles();
    const passWidth = props.compact ? 220 : 230;
    return (
        <View style={[styles.block, props.compact ? styles.blockCompact : null]} testID="supporter-offer-block">
            <View style={[styles.passColumn, props.compact ? styles.passCompact : null]}>
                <SupporterPass editionLabel={t('planSurface.passSupporterEdition')} identity={null} width={passWidth} />
                {props.compact ? <SupporterPassStylePicker /> : null}
            </View>
            <View style={styles.content}>
                <Text style={styles.headline}>{t('planSurface.packHeadline')}</Text>
                <Text style={styles.body}>{t('planSurface.packBody')}</Text>
                <SupporterPackPerkGrid stacked={props.compact} />
                {props.cloudPlanLine ? (
                    <View style={styles.cloudLine}>
                        <Icon name="star" weight="fill" size={13} color={theme.colors.supporter.accent} />
                        <Text style={styles.cloudLineText}>{props.cloudPlanLine}</Text>
                    </View>
                ) : null}
                {/* Beside the pass, the switcher follows the perks; on a phone it sits under the pass. */}
                {props.compact ? null : <View style={styles.pickerGap}><SupporterPassStylePicker align="start" /></View>}
                <View style={[styles.ctaRow, styles.ctaGap, props.compact ? styles.ctaRowCompact : null]}>
                    {props.onSupport ? (
                        <RoundButton
                            testID="supporter-offer-cta"
                            size="normal"
                            display={props.primary ? 'contrast' : 'outline'}
                            leading={<Icon name="heart" size={16} color={props.primary ? theme.colors.surface.base : theme.colors.text.primary} />}
                            title={t('planSurface.supportCta')}
                            onPress={props.onSupport}
                        />
                    ) : null}
                    <Text style={styles.from}>{props.onSupport ? props.fromLabel : t('planSurface.storePurchaseUnavailable')}</Text>
                </View>
            </View>
        </View>
    );
});

const styles = StyleSheet.create((theme) => ({
    block: {
        flexDirection: 'row',
        gap: 36,
        padding: 28,
    },
    blockCompact: {
        flexDirection: 'column',
        gap: 24,
        padding: 20,
    },
    passColumn: {
        alignItems: 'center',
        gap: 14,
    },
    passCompact: {
        alignSelf: 'center',
    },
    content: {
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
    perks: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        rowGap: 12,
        marginTop: 4,
    },
    perk: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        width: '50%',
        paddingRight: 12,
    },
    perkStacked: {
        width: '100%',
        paddingRight: 0,
    },
    perkText: {
        ...Typography.default('semiBold'),
        fontSize: 15,
        color: theme.colors.text.primary,
    },
    cloudLine: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: 10,
        marginTop: 4,
    },
    cloudLineText: {
        ...Typography.default(),
        flex: 1,
        fontSize: 14,
        lineHeight: 20,
        color: theme.colors.text.secondary,
    },
    // With the content's 12 pt gap: 28 pt sets the style choice apart from the pack's perks, and
    // 24 pt gives the call to action its own beat.
    pickerGap: {
        marginTop: 16,
    },
    ctaGap: {
        marginTop: 12,
    },
    ctaRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 16,
        flexWrap: 'wrap',
    },
    ctaRowCompact: {
        flexDirection: 'column',
        alignItems: 'flex-start',
        gap: 10,
    },
    from: {
        ...Typography.default(),
        fontSize: 14,
        color: theme.colors.text.secondary,
    },
}));
