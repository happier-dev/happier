import * as React from 'react';
import { View, type LayoutChangeEvent } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { happierPageTextMetrics } from '@happier-dev/plugin-ui/presentation';
import { useDeviceType } from '@/utils/platform/responsive';

import { IconButton } from '@/components/ui/buttons/IconButton';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Icon } from '@/components/ui/icons/Icon';
import type { SetupBlockItem } from '@/components/ui/setupBlocks/SetupBlockGrid';
import { SetupBlockTile } from '@/components/ui/setupBlocks/SetupBlockTile';
import { SetupSteps } from '@/components/ui/setupBlocks/SetupSteps';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

import { LookChoices } from './PersonalizeStepBody';
import {
    PERSONALIZE_SETUP_ENTRY_ID,
    PERSONALIZE_STEPS,
    resolvePersonalizeCardProgress,
} from './personalizeFlowModel';
import { personalizeStepName } from './personalizeLabels';
import { useOpenPersonalize } from './useOpenPersonalize';
import { usePersonalizeFlow, usePersonalizeProgress } from './usePersonalizeFlow';

/** Below this width the in-place step list moves under the choices. */
const SIDE_BY_SIDE_MIN_WIDTH_PX = 720;

/**
 * "Personalize Happier" as a Get set up block. On a computer the first press grows the block in place
 * into step 1 (lab H2) — Home itself is the preview, so picking Dark repaints the page — and Continue
 * opens the rest of the flow. On a phone, or once started, it opens the flow where it left off. Done
 * or dismissed hides `setup:personalize` through the Home setup owner (Customize brings it back).
 */
export function usePersonalizeSetupItem(input: Readonly<{
    hidden: ReadonlySet<string>;
    onDismiss: (stepId: string) => void;
}>): SetupBlockItem | null {
    const progress = usePersonalizeProgress();
    const openFlow = useOpenPersonalize();
    const phone = useDeviceType() === 'phone';
    if (input.hidden.has(PERSONALIZE_SETUP_ENTRY_ID)) return null;
    const card = resolvePersonalizeCardProgress(progress);
    const total = PERSONALIZE_STEPS.length;
    const title = t('personalize.cardTitle');
    const subtitle = !card.started ? t('personalize.cardSubtitle')
        : card.nextStep ? t('personalize.cardProgress', { saved: card.savedCount, total, step: personalizeStepName(card.nextStep) })
            : t('personalize.cardProgressReview', { saved: card.savedCount, total });
    const growsInPlace = !phone && !card.started;
    return {
        id: PERSONALIZE_SETUP_ENTRY_ID,
        renderTile: ({ open }) => (
            <SetupBlockTile
                testID="hub-setup.personalize"
                layout={phone ? 'row' : 'card'}
                icon="palette"
                title={title}
                subtitle={subtitle}
                progress={card.started ? { fraction: card.savedCount / total, accessibilityLabel: subtitle } : undefined}
                action={{
                    label: card.started ? t('personalize.cardContinue') : t('personalize.cardAction'),
                    testID: 'hub-setup.personalize.action',
                    onPress: growsInPlace ? open : () => openFlow(),
                }}
                dismiss={{
                    label: t('homeSetup.dismiss', { title }),
                    tooltip: t('homeSetup.dismissTooltip'),
                    onPress: () => input.onDismiss(PERSONALIZE_SETUP_ENTRY_ID),
                }}
            />
        ),
        // Kept on a computer even once started, so a panel that is collapsing after Continue keeps
        // its content; only the tile's button decides whether it grows or opens the flow.
        ...(!phone ? {
            renderPanel: ({ close }: Readonly<{ close: () => void }>) => (
                <PersonalizeInPlacePanel
                    close={close}
                    onContinue={() => { close(); openFlow('style'); }}
                />
            ),
        } : {}),
    };
}

/** Step 1 grown in place on Home: theme and glass, then Continue into the rest of the flow. */
function PersonalizeInPlacePanel(props: Readonly<{ close: () => void; onContinue: () => void }>) {
    const { theme } = useUnistyles();
    const flow = usePersonalizeFlow({ initialPage: 'look', onExit: props.close });
    const [width, setWidth] = React.useState<number | null>(null);
    const onLayout = React.useCallback((event: LayoutChangeEvent) => {
        const next = event.nativeEvent.layout.width;
        if (Number.isFinite(next) && next > 0) setWidth((current) => (current === next ? current : next));
    }, []);
    const sideBySide = width === null || width >= SIDE_BY_SIDE_MIN_WIDTH_PX;
    const testID = 'hub-setup.personalize-panel';
    const { onContinue } = props;
    const continueFlow = React.useCallback(async () => {
        // Continue saves step 1 the same way the page's Next does; a failed save stays here.
        if (await flow.next()) onContinue();
    }, [flow, onContinue]);
    return (
        <View testID={testID} onLayout={onLayout} style={[styles.panel, sideBySide ? styles.panelSideBySide : null]}>
            <View style={styles.main}>
                <Icon name="palette" size={20} color={theme.colors.text.secondary} />
                <Text accessibilityRole="header" style={styles.title}>{t('personalize.inPlaceTitle')}</Text>
                <Text style={styles.body}>{t('personalize.inPlaceBody')}</Text>
                <LookChoices flow={flow} testID={testID} />
                {flow.status === 'failed' ? <Text style={styles.body}>{t('personalize.saveFailed')}</Text> : null}
                <View style={styles.actions}>
                    <RoundButton
                        testID={`${testID}.continue`}
                        size="small"
                        title={flow.status === 'failed'
                            ? t('personalize.tryAgain')
                            : t('personalize.inPlaceContinue', { count: PERSONALIZE_STEPS.length - 1 })}
                        onPress={continueFlow}
                        disabled={flow.status === 'saving'}
                    />
                    <RoundButton
                        testID={`${testID}.not-now`}
                        size="small"
                        display="inverted"
                        title={t('personalize.notNow')}
                        onPress={flow.later}
                    />
                </View>
            </View>
            <View style={[styles.steps, sideBySide ? styles.stepsSide : null]}>
                <SetupSteps
                    testID={`${testID}.steps`}
                    steps={PERSONALIZE_STEPS.map((step, index) => ({
                        key: step,
                        state: index === 0 ? 'current' : 'upcoming',
                        title: personalizeStepName(step),
                    }))}
                />
            </View>
            <View style={styles.close}>
                <IconButton
                    testID={`${testID}.close`}
                    iconName="x"
                    variant="plain"
                    size={24}
                    iconSize={13}
                    accessibilityLabel={t('common.close')}
                    tooltip={t('common.close')}
                    onPress={flow.later}
                />
            </View>
        </View>
    );
}

const styles = StyleSheet.create((theme) => ({
    panel: {
        padding: 20,
        gap: 20,
    },
    panelSideBySide: {
        flexDirection: 'row',
    },
    main: {
        flex: 1,
        minWidth: 0,
        gap: 10,
    },
    title: {
        ...Typography.default('semiBold'),
        ...happierPageTextMetrics('pageTitle'),
        color: theme.colors.text.primary,
    },
    body: {
        ...Typography.default(),
        ...happierPageTextMetrics('pageDescription'),
        color: theme.colors.text.secondary,
    },
    actions: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        paddingTop: 6,
    },
    steps: {
        paddingTop: 8,
    },
    stepsSide: {
        width: 260,
        paddingLeft: 20,
        borderLeftWidth: StyleSheet.hairlineWidth,
        borderLeftColor: theme.colors.border.default,
    },
    close: {
        position: 'absolute',
        top: 10,
        right: 10,
    },
}));
