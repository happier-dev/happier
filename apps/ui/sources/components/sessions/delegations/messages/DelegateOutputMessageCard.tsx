import React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import type { DelegateOutputV1 } from '@happier-dev/protocol';
import {
    ExecutionRunResultLayout,
    type ExecutionRunResultPresentation,
} from '@/components/sessions/runs/ExecutionRunResultLayout';
import { StructuredFindText, type StructuredFindTextBlock } from '@/components/sessions/transcript/structured/structuredFindText';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

function buildDelegateOutputContent(payload: DelegateOutputV1, options: Readonly<{
    presentation?: ExecutionRunResultPresentation;
}>) {
    const block = (id: string, text: string) => ({ id: `structured-delegate-${id}`, text });
    return {
        header: options.presentation === 'page' ? null : block('header', t('delegation.output.title')),
        summary: block('summary', payload.summary),
        deliverables: (payload.deliverables ?? []).length > 0 ? {
            label: block('deliverables:label', t('delegation.output.deliverablesTitle')),
            items: payload.deliverables.slice(0, 30).map((deliverable, index) => ({
                key: deliverable.id,
                title: block(`deliverable:${index}:title`, deliverable.title),
                details: deliverable.details ? block(`deliverable:${index}:details`, deliverable.details) : null,
            })),
        } : null,
    };
}

/** Find shares the actual card's displayed deliverables and chrome, never hidden payload fields. */
export function projectDelegateOutputFindText(payload: DelegateOutputV1, options: Readonly<{
    presentation?: ExecutionRunResultPresentation;
}> = {}): readonly StructuredFindTextBlock[] {
    const content = buildDelegateOutputContent(payload, options);
    return [
        ...(content.header ? [content.header] : []),
        content.summary,
        ...(content.deliverables ? [content.deliverables.label, ...content.deliverables.items.flatMap((deliverable) => [
            deliverable.title, ...(deliverable.details ? [deliverable.details] : []),
        ])] : []),
    ];
}

/**
 * A delegated task's result: what was done, in words, then its deliverables. It has no primary of
 * its own — the deliverables are the result. The transcript shows it as a card (`message`); the Run
 * page shows it as the page itself (`page`, agents lab RP1).
 */
export function DelegateOutputMessageCard(props: Readonly<{
    payload: DelegateOutputV1;
    presentation?: ExecutionRunResultPresentation;
    /** Page only: what closes the result's body (the Run's steps disclosure). */
    after?: React.ReactNode;
}>) {
    const styles = stylesheet;
    const content = buildDelegateOutputContent(props.payload, props);

    return (
        <ExecutionRunResultLayout presentation={props.presentation ?? 'message'} testID="delegate-output" after={props.after}>
            {content.header ? (
                <StructuredFindText blockId={content.header.id} text={content.header.text} selectable accessibilityRole="header" style={styles.headerText} />
            ) : null}
            <StructuredFindText blockId={content.summary.id} text={content.summary.text} selectable style={styles.lead} />

            {content.deliverables ? (
                <View style={styles.section}>
                    <StructuredFindText blockId={content.deliverables.label.id} text={content.deliverables.label.text} selectable accessibilityRole="header" style={styles.sectionTitle} />
                    <View style={styles.sheet}>
                        {content.deliverables.items.map((deliverable, index) => (
                            <View key={deliverable.key} style={[styles.deliverableRow, index > 0 ? styles.deliverableDivider : null]}>
                                <StructuredFindText blockId={deliverable.title.id} text={deliverable.title.text} selectable style={styles.deliverableTitle} />
                                {deliverable.details ? <StructuredFindText blockId={deliverable.details.id} text={deliverable.details.text} selectable style={styles.deliverableDetails} /> : null}
                            </View>
                        ))}
                    </View>
                </View>
            ) : null}
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
        gap: 10,
    },
    sectionTitle: {
        ...Typography.default('semiBold'),
        color: theme.colors.text.primary,
        fontSize: 15,
    },
    sheet: {
        borderRadius: 12,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.border.default,
        paddingHorizontal: 14,
    },
    deliverableRow: {
        gap: 4,
        paddingVertical: 12,
    },
    deliverableDivider: {
        borderTopWidth: StyleSheet.hairlineWidth,
        borderTopColor: theme.colors.border.default,
    },
    deliverableTitle: {
        ...Typography.default('semiBold'),
        color: theme.colors.text.primary,
        fontSize: 14,
    },
    deliverableDetails: {
        ...Typography.default(),
        color: theme.colors.text.secondary,
        fontSize: 13.5,
        lineHeight: 19,
    },
}));
