import React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import type { PlanOutputV1 } from '@happier-dev/protocol';
import {
    ExecutionRunResultLayout,
    type ExecutionRunResultPresentation,
} from '@/components/sessions/runs/ExecutionRunResultLayout';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Text } from '@/components/ui/text/Text';
import { StructuredFindText, type StructuredFindTextBlock } from '@/components/sessions/transcript/structured/structuredFindText';
import { Typography } from '@/constants/Typography';
import { sync } from '@/sync/sync';
import { t } from '@/text';
import { fireAndForget } from '@/utils/system/fireAndForget';

function buildPlanOutputContent(payload: PlanOutputV1, options: Readonly<{
    canSendMessages?: boolean;
    presentation?: ExecutionRunResultPresentation;
}>) {
    const block = (id: string, text: string) => ({ id: `structured-plan-${id}`, text });
    const risks = payload.risks ?? [];
    const milestones = payload.milestones ?? [];
    return {
        header: options.presentation === 'page' ? null : block('header', t('session.planOutput.title')),
        summary: block('summary', payload.summary),
        sections: (payload.sections ?? []).slice(0, 10).map((section, sectionIndex) => ({
            key: section.title,
            title: block(`section:${sectionIndex}:title`, section.title),
            items: section.items.slice(0, 12).map((text, index) => block(`section:${sectionIndex}:item:${index}`, text)),
        })),
        recommendedBackend: payload.recommendedBackendId ? {
            label: block('recommendedBackend:label', t('session.planOutput.recommendedBackend')),
            value: block('recommendedBackend:value', payload.recommendedBackendId),
        } : null,
        risks: risks.length > 0 ? {
            label: block('risks:label', t('session.planOutput.risks')),
            items: risks.slice(0, 12).map((text, index) => block(`risk:${index}`, text)),
        } : null,
        milestones: milestones.length > 0 ? {
            label: block('milestones:label', t('session.planOutput.milestones')),
            items: milestones.slice(0, 12).map((milestone, index) => ({
                title: block(`milestone:${index}:title`, milestone.title),
                details: milestone.details ? block(`milestone:${index}:details`, milestone.details) : null,
            })),
        } : null,
        adopt: options.canSendMessages === true ? block('adopt', t('session.planOutput.adoptPlan')) : null,
    };
}

/** Find shares displayed semantic fields and slice limits; host action labels stay outside its corpus. */
export function projectPlanOutputFindText(payload: PlanOutputV1, options: Readonly<{
    canSendMessages?: boolean;
    presentation?: ExecutionRunResultPresentation;
}> = {}): readonly StructuredFindTextBlock[] {
    const content = buildPlanOutputContent(payload, options);
    return [
        ...(content.header ? [content.header] : []),
        content.summary,
        ...content.sections.flatMap((section) => [section.title, ...section.items]),
        ...(content.recommendedBackend ? [content.recommendedBackend.label, content.recommendedBackend.value] : []),
        ...(content.risks ? [content.risks.label, ...content.risks.items] : []),
        ...(content.milestones ? [content.milestones.label, ...content.milestones.items.flatMap((milestone) => [
            milestone.title, ...(milestone.details ? [milestone.details] : []),
        ])] : []),
    ];
}

/**
 * A plan's result: its summary in words, its sections, risks and milestones, and one primary —
 * Adopt plan. The transcript shows it as a card (`message`); the Run page shows it as the page
 * itself with Adopt plan pinned at its foot (`page`, agents lab RP1).
 */
export function PlanOutputMessageCard(props: Readonly<{
    payload: PlanOutputV1;
    sessionId: string;
    canSendMessages: boolean;
    presentation?: ExecutionRunResultPresentation;
    /** Page only: what closes the result's body (the Run's steps disclosure). */
    after?: React.ReactNode;
}>) {
    const styles = stylesheet;
    const [error, setError] = React.useState<string | null>(null);
    const [isSending, setIsSending] = React.useState(false);
    const canSendMessagesRef = React.useRef(props.canSendMessages === true);
    const content = buildPlanOutputContent(props.payload, props);

    React.useLayoutEffect(() => {
        canSendMessagesRef.current = props.canSendMessages === true;
    }, [props.canSendMessages]);

    const handleAdopt = React.useCallback(() => {
        if (!canSendMessagesRef.current) return;
        fireAndForget((async () => {
            setError(null);
            setIsSending(true);
            try {
                const wire = {
                    kind: 'plan_output.v1',
                    runRef: props.payload.runRef,
                    summary: props.payload.summary,
                    sections: props.payload.sections,
                    risks: props.payload.risks ?? [],
                    milestones: props.payload.milestones ?? [],
                    recommendedBackendId: props.payload.recommendedBackendId,
                };
                const text = `@happier/plan.adopt\n${JSON.stringify(wire)}`;
                await sync.submitMessage(props.sessionId, text, 'Adopt plan', undefined, {
                    callerSurface: 'plan_output_adopt',
                });
            } catch (e) {
                setError(e instanceof Error ? e.message : t('session.planOutput.failedToAdopt'));
            } finally {
                setIsSending(false);
            }
        })(), { tag: 'PlanOutputMessageCard.adoptPlan' });
    }, [props.payload, props.sessionId]);

    return (
        <ExecutionRunResultLayout
            presentation={props.presentation ?? 'message'}
            testID="plan-output"
            after={props.after}
            footActions={content.adopt ? (
                <RoundButton
                    testID="adopt-plan-button"
                    size="small"
                    title={<StructuredFindText blockId={content.adopt.id} text={isSending ? t('session.planOutput.sending') : content.adopt.text} selectable={false} useDefaultTypography={false} />}
                    accessibilityLabel={t('session.planOutput.a11y.adoptPlan')}
                    disabled={isSending}
                    loading={isSending}
                    onPress={handleAdopt}
                />
            ) : null}
        >
            {content.header ? (
                <StructuredFindText blockId={content.header.id} text={content.header.text} selectable accessibilityRole="header" style={styles.headerText} />
            ) : null}
            <StructuredFindText blockId={content.summary.id} text={content.summary.text} selectable style={styles.lead} />

            {content.sections.map((section) => (
                <View key={section.key} style={styles.section}>
                    <StructuredFindText blockId={section.title.id} text={section.title.text} selectable accessibilityRole="header" style={styles.sectionTitle} />
                    {section.items.map((item) => (
                        <StructuredFindText blockId={item.id} text={item.text} selectable key={item.id} style={styles.sectionItem} />
                    ))}
                </View>
            ))}

            {content.recommendedBackend ? (
                <View style={styles.section}>
                    <StructuredFindText blockId={content.recommendedBackend.label.id} text={content.recommendedBackend.label.text} selectable accessibilityRole="header" style={styles.sectionTitle} />
                    <StructuredFindText blockId={content.recommendedBackend.value.id} text={content.recommendedBackend.value.text} selectable style={styles.sectionItem} />
                </View>
            ) : null}

            {content.risks ? (
                <View style={styles.section}>
                    <StructuredFindText blockId={content.risks.label.id} text={content.risks.label.text} selectable accessibilityRole="header" style={styles.sectionTitle} />
                    {content.risks.items.map((risk) => (
                        <StructuredFindText blockId={risk.id} text={risk.text} selectable key={risk.id} style={styles.sectionItem} />
                    ))}
                </View>
            ) : null}

            {content.milestones ? (
                <View style={styles.section}>
                    <StructuredFindText blockId={content.milestones.label.id} text={content.milestones.label.text} selectable accessibilityRole="header" style={styles.sectionTitle} />
                    {content.milestones.items.map((milestone) => (
                        <View key={milestone.title.id} style={styles.milestone}>
                            <StructuredFindText blockId={milestone.title.id} text={milestone.title.text} selectable style={styles.milestoneTitle} />
                            {milestone.details ? <StructuredFindText blockId={milestone.details.id} text={milestone.details.text} selectable style={styles.sectionItem} /> : null}
                        </View>
                    ))}
                </View>
            ) : null}

            {error ? <Text selectable style={styles.errorText}>{error}</Text> : null}
        </ExecutionRunResultLayout>
    );
}

const stylesheet = StyleSheet.create((theme) => ({
    headerText: {
        ...Typography.default('semiBold'),
        color: theme.colors.text.primary,
        fontSize: 15,
    },
    lead: {
        ...Typography.default(),
        color: theme.colors.text.primary,
        fontSize: 15,
        lineHeight: 22,
    },
    section: {
        gap: 6,
    },
    sectionTitle: {
        ...Typography.default('semiBold'),
        color: theme.colors.text.primary,
        fontSize: 14,
    },
    sectionItem: {
        ...Typography.default(),
        color: theme.colors.text.secondary,
        fontSize: 13.5,
        lineHeight: 19,
    },
    milestone: {
        gap: 2,
    },
    milestoneTitle: {
        ...Typography.default('semiBold'),
        color: theme.colors.text.primary,
        fontSize: 13.5,
    },
    errorText: {
        ...Typography.default(),
        color: theme.colors.state.danger.foreground,
        fontSize: 13,
    },
}));
