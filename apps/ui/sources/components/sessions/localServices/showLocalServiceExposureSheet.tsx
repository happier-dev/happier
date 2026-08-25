import * as React from 'react';
import { Platform, Pressable, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import type { LocalServicePublicExposureModeV1 } from '@happier-dev/protocol';

import { Icon, type IconName } from '@/components/ui/icons/Icon';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { SegmentedTabBar } from '@/components/ui/navigation/SegmentedTabBar';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { Modal, type CustomModalInjectedProps } from '@/modal';
import { createDeferredOnce } from '@/modal/async/createDeferredOnce';
import { t } from '@/text';

export type LocalServiceExposureDecision = Readonly<{
    mode: LocalServicePublicExposureModeV1;
    ttlMs: number;
}>;

export type LocalServiceExposureModeChoice = Readonly<{
    mode: LocalServicePublicExposureModeV1;
    label: string;
}>;

export type LocalServiceExposureTtlChoice = Readonly<{
    ttlMs: number;
    label: string;
}>;

const stylesheet = StyleSheet.create((theme) => ({
    body: {
        paddingHorizontal: 16,
        paddingTop: 4,
        paddingBottom: 14,
        gap: 18,
    },
    consequences: {
        gap: 12,
    },
    consequence: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: 10,
    },
    /**
     * A fixed leading slot so the three sentences share one text edge. The glyph is nudged down
     * a hair because a 16px icon centred on a 20px line box reads high against the first line.
     */
    consequenceIcon: {
        width: 20,
        alignItems: 'center',
        paddingTop: 1,
    },
    consequenceText: {
        flex: 1,
        minWidth: 0,
        fontSize: 13,
        lineHeight: 19,
        color: theme.colors.text.primary,
    },
    choice: {
        gap: 6,
    },
    choiceLabel: {
        ...Typography.default('semiBold'),
        fontSize: 11,
        letterSpacing: 0.4,
        textTransform: 'uppercase',
        color: theme.colors.text.secondary,
    },
    commit: {
        gap: 10,
        paddingTop: 2,
    },
    cancelRow: {
        alignItems: 'center',
        paddingVertical: 8,
        borderRadius: 8,
    },
    /** Keyboard focus ring from the theme's focus role — never `border.strong`. */
    cancelRowFocused: {
        ...(Platform.select({
            web: {
                outlineStyle: 'solid',
                outlineWidth: 2,
                outlineColor: theme.colors.border.focus,
                outlineOffset: -2,
            },
            default: {},
        }) as object),
    },
    cancelText: {
        ...Typography.default('semiBold'),
        fontSize: 13,
        color: theme.colors.text.secondary,
    },
}));

function Consequence(props: Readonly<{
    iconName: IconName;
    text: string;
    testID: string;
}>): React.ReactElement {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    return (
        <View style={styles.consequence} testID={props.testID}>
            <View style={styles.consequenceIcon}>
                <Icon name={props.iconName} size={16} color={theme.colors.text.secondary} />
            </View>
            <Text style={styles.consequenceText}>{props.text}</Text>
        </View>
    );
}

type ExposureSheetProps = CustomModalInjectedProps & Readonly<{
    modeChoices: readonly LocalServiceExposureModeChoice[];
    ttlChoices: readonly LocalServiceExposureTtlChoice[];
    testIDPrefix: string;
    onResolve: (decision: LocalServiceExposureDecision | null) => void;
}>;

/**
 * The consequence sheet for spending public-exposure trust (tunnels audit §9.1).
 *
 * It replaces THREE sequential dialogs — a two-string `Modal.confirm`, then a mode picker, then a
 * lifetime picker — with one moment. The three dialogs were not a smaller design: they asked the
 * user to commit before telling them the two facts that decide the answer (no sign-in is required;
 * the link expires on its own), and then made them answer two more questions afterwards, by which
 * point the decision was already made. `DESIGN.md` asks for privacy and cost consequences to be
 * explained *before* commitment and for choices to be described in terms of outcomes.
 *
 * Every control here is a primitive the corridor already owns: the card chrome is `@/modal`'s, the
 * two choices are the canonical `SegmentedTabBar` (which owns the sliding thumb, roving focus and
 * the tablist semantics), and the commit is `RoundButton`. This is not a second consent gate — it
 * IS the gate, and the daemon still rejects any create that does not carry the acknowledgement.
 */
const LocalServiceExposureSheet: React.FC<ExposureSheetProps> = (props) => {
    const styles = stylesheet;
    const [mode, setMode] = React.useState<LocalServicePublicExposureModeV1>(
        () => props.modeChoices[0]?.mode ?? 'secret_link',
    );
    const [ttlMs, setTtlMs] = React.useState<number>(() => props.ttlChoices[0]?.ttlMs ?? 0);

    const modeTabs = React.useMemo(
        () => props.modeChoices.map((choice) => ({ id: choice.mode, label: choice.label })),
        [props.modeChoices],
    );
    const ttlTabs = React.useMemo(
        () => props.ttlChoices.map((choice) => ({ id: String(choice.ttlMs), label: choice.label })),
        [props.ttlChoices],
    );

    const commit = React.useCallback(() => {
        props.onResolve({ mode, ttlMs });
        props.onClose();
    }, [mode, props, ttlMs]);

    const cancel = React.useCallback(() => {
        props.onResolve(null);
        props.onClose();
    }, [props]);

    return (
        <View style={styles.body}>
            <View style={styles.consequences}>
                <Consequence
                    iconName="globe"
                    text={t('localServices.publicPreview.consequenceReach')}
                    testID={`${props.testIDPrefix}-consequence-reach`}
                />
                <Consequence
                    iconName="clock"
                    text={t('localServices.publicPreview.consequenceExpiry')}
                    testID={`${props.testIDPrefix}-consequence-expiry`}
                />
                <Consequence
                    iconName="shield-check"
                    text={t('localServices.publicPreview.consequenceRevoke')}
                    testID={`${props.testIDPrefix}-consequence-revoke`}
                />
            </View>

            {/* One allowed mode is not a decision: the bar appears only when the server offers a choice. */}
            {modeTabs.length > 1 ? (
                <View style={styles.choice}>
                    <Text style={styles.choiceLabel}>{t('localServices.publicPreview.linkTypeLabel')}</Text>
                    <SegmentedTabBar
                        tabs={modeTabs}
                        activeTabId={mode}
                        onSelectTab={(next) => setMode(next as LocalServicePublicExposureModeV1)}
                        accessibilityLabel={t('localServices.publicPreview.linkTypeLabel')}
                        testIDPrefix={`${props.testIDPrefix}-mode`}
                        slidingThumb
                        compact
                    />
                </View>
            ) : null}

            {ttlTabs.length > 1 ? (
                <View style={styles.choice}>
                    <Text style={styles.choiceLabel}>{t('localServices.publicPreview.lifetimeLabel')}</Text>
                    <SegmentedTabBar
                        tabs={ttlTabs}
                        activeTabId={String(ttlMs)}
                        onSelectTab={(next) => setTtlMs(Number.parseInt(next, 10))}
                        accessibilityLabel={t('localServices.publicPreview.lifetimeLabel')}
                        testIDPrefix={`${props.testIDPrefix}-ttl`}
                        slidingThumb
                        compact
                    />
                </View>
            ) : null}

            <View style={styles.commit}>
                <RoundButton
                    testID={`${props.testIDPrefix}-commit`}
                    title={t('localServices.publicPreview.confirmCta')}
                    size="normal"
                    onPress={commit}
                />
                <Pressable
                    testID={`${props.testIDPrefix}-cancel`}
                    accessibilityRole="button"
                    onPress={cancel}
                    style={(interactionState) => {
                        const webState = interactionState as typeof interactionState & { focused?: boolean };
                        return [
                            styles.cancelRow,
                            interactionState.pressed ? { opacity: 0.85 } : null,
                            webState.focused === true ? styles.cancelRowFocused : null,
                        ];
                    }}
                >
                    <Text style={styles.cancelText}>{t('common.cancel')}</Text>
                </Pressable>
            </View>
        </View>
    );
};

/**
 * Present the sheet. Resolves to the user's decision, or `null` if they backed out through any
 * surface (cancel, backdrop, Escape) — backing out creates nothing.
 */
export async function showLocalServiceExposureSheet(params: Readonly<{
    serviceTitle: string;
    modeChoices: readonly LocalServiceExposureModeChoice[];
    ttlChoices: readonly LocalServiceExposureTtlChoice[];
    testIDPrefix?: string;
}>): Promise<LocalServiceExposureDecision | null> {
    const testIDPrefix = params.testIDPrefix ?? 'local-service-exposure-sheet';
    const deferred = createDeferredOnce<LocalServiceExposureDecision | null>();

    Modal.show({
        component: LocalServiceExposureSheet,
        props: {
            modeChoices: params.modeChoices,
            ttlChoices: params.ttlChoices,
            testIDPrefix,
            onResolve: deferred.resolve,
        },
        onRequestClose: () => deferred.resolve(null),
        chrome: {
            kind: 'card',
            title: t('localServices.publicPreview.confirmTitle'),
            subtitle: t('localServices.publicPreview.confirmMessage', { service: params.serviceTitle }),
            testID: `${testIDPrefix}-modal`,
            bodyScroll: 'auto',
            dimensions: { width: 420, maxHeightRatio: 0.85, size: 'md' },
        },
        closeOnBackdrop: true,
    });

    return await deferred.promise;
}
