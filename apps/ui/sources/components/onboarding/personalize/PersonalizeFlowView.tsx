import * as React from 'react';
import { Pressable, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { happierPageTextMetrics } from '@happier-dev/plugin-ui/presentation';

import { JourneyConfigSlot, type JourneyConfigControllerSurface } from '@/components/onboarding/tour/config/JourneyConfigSlot';
import { SplitStageFrame } from '@/components/onboarding/tour/desktop/SplitStageLayout';
import { Icon } from '@/components/ui/icons/Icon';
import { MeterBar } from '@/components/ui/lists/MeterBar';
import { PAGE_LIST_METRICS } from '@/components/ui/lists/pageListMetrics';
import { SlideTransitionSwitch } from '@/components/ui/motion/SlideTransitionSwitch';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

import { PersonalizeStage, resolvePersonalizeStageFocus } from './PersonalizeStage';
import { PersonalizeStepBody, PersonalizeStyleChoices, countPersonalizeChanges } from './PersonalizeStepBody';
import { PERSONALIZE_STEPS, isPersonalizeStep, type PersonalizePageId } from './personalizeFlowModel';
import { personalizeStepName } from './personalizeLabels';
import { usePersonalizeFlow, type PersonalizeFlow } from './usePersonalizeFlow';

/** Where the page stands in the six steps: the optional style sits between Look and Conversation. */
function resolveProgress(page: PersonalizePageId): number {
    if (page === 'summary') return PERSONALIZE_STEPS.length;
    if (page === 'style') return 1;
    return PERSONALIZE_STEPS.indexOf(page) + 1;
}

function pageHeading(flow: PersonalizeFlow): Readonly<{ eyebrow: string; title: string; description: string }> {
    const { page } = flow;
    if (page === 'style') return { eyebrow: t('personalize.styleEyebrow'), title: t('personalize.styleTitle'), description: t('personalize.styleDescription') };
    if (page === 'summary') return { eyebrow: t('personalize.summaryEyebrow'), title: t('personalize.summaryTitle'), description: t('personalize.summaryDescription', { changed: countPersonalizeChanges(flow) }) };
    const eyebrow = t('personalize.stepEyebrow', { n: PERSONALIZE_STEPS.indexOf(page) + 1, total: PERSONALIZE_STEPS.length, name: personalizeStepName(page) });
    switch (page) {
        case 'look': return { eyebrow, title: t('personalize.lookTitle'), description: t('personalize.lookDescription') };
        case 'conversation': return { eyebrow, title: t('personalize.conversationTitle'), description: t('personalize.conversationDescription') };
        case 'tools': return { eyebrow, title: t('personalize.toolsTitle'), description: t('personalize.toolsDescription') };
        case 'work': return { eyebrow, title: t('personalize.workTitle'), description: t('personalize.workDescription') };
        case 'attention': return { eyebrow, title: t('personalize.attentionTitle'), description: t('personalize.attentionDescription') };
        case 'notifications': return { eyebrow, title: t('personalize.notificationsTitle'), description: t('personalize.notificationsDescription') };
    }
}

/** Skip · Back · Next for a page, on the tour's config slot (its one action bar). */
function buildController(flow: PersonalizeFlow, body: React.ReactNode, phone: boolean): JourneyConfigControllerSurface {
    const failed = flow.status === 'failed';
    const step = isPersonalizeStep(flow.page);
    return {
        body,
        primaryLabel: failed ? t('personalize.tryAgain')
            : flow.page === 'summary' ? t('personalize.useThisSetup')
                : flow.page === 'notifications' ? t('personalize.review') : t('personalize.next'),
        onPrimary: async () => { await flow.next(); },
        primaryDisabled: flow.status === 'saving',
        // On a phone, Back lives in the sheet's header.
        onBack: !phone && flow.page !== 'look' ? flow.back : null,
        showBack: !phone && flow.page !== 'look',
        onSkip: step || flow.page === 'style' ? flow.skip : null,
        showSkip: step || flow.page === 'style',
        skipDisabled: flow.status === 'saving',
        skipLabel: failed ? t('personalize.skipThisStep') : t('common.skip'),
        footerHint: failed ? t('personalize.saveFailed') : flow.page === 'summary' ? t('personalize.summaryFooter') : null,
    };
}

/** Six segments: one per step, filled up to the current one. Each is the canonical meter. */
function PersonalizeProgress(props: Readonly<{ done: number; testID: string }>) {
    return (
        <View testID={props.testID} style={styles.progress} accessibilityLabel={t('personalize.stepCounter', { n: props.done, total: PERSONALIZE_STEPS.length })}>
            {PERSONALIZE_STEPS.map((step, index) => (
                <MeterBar key={step} style={styles.progressSegment} tone="neutral" fillFraction={index < props.done ? 1 : 0} />
            ))}
        </View>
    );
}

function PageHeading(props: Readonly<{ flow: PersonalizeFlow; testID: string }>) {
    const heading = pageHeading(props.flow);
    return (
        <View testID={`${props.testID}-heading`} style={styles.heading}>
            <Text style={styles.eyebrow}>{heading.eyebrow}</Text>
            <Text accessibilityRole="header" style={styles.title}>{heading.title}</Text>
            <Text style={styles.description}>{heading.description}</Text>
        </View>
    );
}

/**
 * Personalize Happier on a computer: the step column on the tour's split frame and config slot, the
 * live workspace on the stage. Each Next saves its step; "Finish later" keeps what was saved.
 */
export function PersonalizeFlowView(props: Readonly<{
    initialPage?: PersonalizePageId;
    onExit: () => void;
    testID?: string;
    presentation?: 'desktop' | 'phone';
}>) {
    const flow = usePersonalizeFlow({ initialPage: props.initialPage, onExit: props.onExit });
    return props.presentation === 'phone'
        ? <PersonalizePhonePresentation flow={flow} testID={props.testID} />
        : <PersonalizeDesktopPresentation flow={flow} testID={props.testID} />;
}

function PersonalizeDesktopPresentation(props: Readonly<{ flow: PersonalizeFlow; testID?: string }>) {
    const testID = props.testID ?? 'personalize-flow';
    const { flow } = props;
    const body = (
        <SlideTransitionSwitch contentKey={flow.page} direction={flow.direction} preset="routine">
            <View style={styles.body}>
                <PageHeading flow={flow} testID={testID} />
                <PersonalizeStepBody flow={flow} phone={false} testID={testID} />
            </View>
        </SlideTransitionSwitch>
    );
    const narration = (
        <>
            <View style={styles.header}>
                <Text style={styles.flowTitle}>{t('personalize.flowTitle')}</Text>
                {flow.page !== 'summary' ? (
                    <Pressable testID={`${testID}-later`} accessibilityRole="button" onPress={flow.later} hitSlop={8}>
                        <Text style={styles.headerAction}>{t('personalize.finishLater')}</Text>
                    </Pressable>
                ) : null}
            </View>
            <PersonalizeProgress done={resolveProgress(flow.page)} testID={`${testID}-progress`} />
            <JourneyConfigSlot controller={buildController(flow, body, false)} layout="flow" testID={`${testID}-config`} />
        </>
    );
    return (
        <SplitStageFrame
            testID={testID}
            orientation="narration-left"
            narration={narration}
            stage={flow.page === 'style' ? (
                <View style={styles.styleStage}>
                    <PersonalizeStyleChoices flow={flow} phone={false} testID={testID} />
                </View>
            ) : (
                <PersonalizeStage
                    testID={`${testID}-stage`}
                    draft={flow.draft}
                    focus={resolvePersonalizeStageFocus(flow.page)}
                    presentation="window"
                    note={flow.page === 'summary' ? t('personalize.previewNoteSummary') : t('personalize.previewNote')}
                />
            )}
        />
    );
}

/**
 * Personalize Happier on a phone: a full-height sheet with Back, "n of 6" and Later in its header,
 * one preview card, the controls beneath, and Skip · Next pinned at the bottom.
 */
export function PersonalizeFlowSheet(props: Readonly<{ initialPage?: PersonalizePageId; onClose: () => void; testID?: string }>) {
    return <PersonalizeFlowView initialPage={props.initialPage} onExit={props.onClose} testID={props.testID} presentation="phone" />;
}

function PersonalizePhonePresentation(props: Readonly<{ flow: PersonalizeFlow; testID?: string }>) {
    const { theme } = useUnistyles();
    const testID = props.testID ?? 'personalize-sheet';
    const { flow } = props;
    const progress = resolveProgress(flow.page);
    const heading = pageHeading(flow);
    const body = (
        <SlideTransitionSwitch contentKey={flow.page} direction={flow.direction} preset="routine">
            <View style={styles.body}>
                {flow.page !== 'summary' && flow.page !== 'style' ? (
                    <PersonalizeStage
                        testID={`${testID}-stage`}
                        draft={flow.draft}
                        focus={resolvePersonalizeStageFocus(flow.page)}
                        presentation="card"
                    />
                ) : null}
                <Text accessibilityRole="header" style={styles.title}>{heading.title}</Text>
                {flow.page === 'summary' || flow.page === 'style' ? <Text style={styles.description}>{heading.description}</Text> : null}
                <PersonalizeStepBody flow={flow} phone testID={testID} />
            </View>
        </SlideTransitionSwitch>
    );
    return (
        <View testID={testID} style={styles.sheet}>
            <View style={styles.sheetHeader}>
                <Pressable
                    testID={`${testID}-back`}
                    accessibilityRole="button"
                    accessibilityLabel={t('common.back')}
                    disabled={flow.page === 'look' || flow.status === 'saving'}
                    onPress={flow.back}
                    hitSlop={8}
                    style={flow.page === 'look' ? styles.hidden : null}
                >
                    <Icon name="caret-left" size={22} color={theme.colors.text.primary} />
                </Pressable>
                <View style={styles.sheetTitle}>
                    <Text style={styles.flowTitle}>{t('personalize.flowTitle')}</Text>
                    <Text style={styles.eyebrow}>{t('personalize.stepCounter', { n: progress, total: PERSONALIZE_STEPS.length })}</Text>
                </View>
                <Pressable testID={`${testID}-later`} accessibilityRole="button" onPress={flow.later} hitSlop={8}>
                    <Text style={styles.headerAction}>{t('personalize.later')}</Text>
                </Pressable>
            </View>
            <PersonalizeProgress done={progress} testID={`${testID}-progress`} />
            <JourneyConfigSlot controller={buildController(flow, body, true)} layout="scroll" primarySizing="fill" testID={`${testID}-config`} />
        </View>
    );
}

const styles = StyleSheet.create((theme) => ({
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 12,
    },
    flowTitle: {
        ...Typography.default('semiBold'),
        ...happierPageTextMetrics('rowTitle'),
        color: theme.colors.text.secondary,
    },
    headerAction: {
        ...Typography.default('semiBold'),
        ...happierPageTextMetrics('rowTitle'),
        color: theme.colors.text.secondary,
    },
    progress: {
        flexDirection: 'row',
        gap: 6,
    },
    progressSegment: {
        flex: 1,
    },
    body: {
        gap: 20,
        width: '100%',
    },
    styleStage: {
        flex: 1,
        justifyContent: 'center',
        padding: 32,
    },
    heading: {
        gap: 8,
    },
    eyebrow: {
        ...Typography.default(),
        ...happierPageTextMetrics('meta'),
        color: theme.colors.text.tertiary,
    },
    title: {
        ...Typography.default('bold'),
        ...happierPageTextMetrics('heroTitle'),
        color: theme.colors.text.primary,
    },
    description: {
        ...Typography.default(),
        ...happierPageTextMetrics('pageDescription'),
        color: theme.colors.text.secondary,
    },
    sheet: {
        flex: 1,
        minHeight: 0,
        paddingHorizontal: PAGE_LIST_METRICS.sheetInsetPx,
        paddingTop: 8,
        paddingBottom: 16,
        gap: 12,
    },
    sheetHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 12,
    },
    sheetTitle: {
        alignItems: 'center',
    },
    hidden: {
        opacity: 0,
    },
}));
