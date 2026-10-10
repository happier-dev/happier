import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SectionContentRow } from '@/components/ui/lists/SectionContentRow';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';
import { isSessionAwarenessContentReadableV1 } from '@happier-dev/protocol/sessions/awareness/availability';
import { useSessionListRenderableWithServerScope } from '@/sync/domains/state/storage';
import { projectUiSessionAwareness } from '@/sync/domains/session/awareness/sessionAwareness';
import { getSessionName } from '@/utils/sessions/sessionUtils';
import type { ApprovalActionFieldsPresentation } from './approvalFieldValues';
import {
    describeUnnamedApprovalSession,
    resolveApprovalHomeName,
} from './approvalRequesterLabels';

/**
 * The arguments an approval would run with. `card` (default) is the self-contained card a transcript
 * prompt shows; `page` is the approval page's "Details" section, in the page's own section and row
 * anatomy (one row per argument: its name, then its value).
 */
export const ActionApprovalFieldsCard = React.memo(function ActionApprovalFieldsCard(props: Readonly<{
    presentation: ApprovalActionFieldsPresentation;
    anatomy?: 'card' | 'page';
    /** The approval's Home: a value that is one of its sessions (or a Home) reads by its name. */
    serverId?: string | null;
}>) {
    const rows = props.presentation.rows;
    if (rows.length === 0) return null;

    if (props.anatomy === 'page') {
        return (
            <ItemGroup title={t('approvals.details')}>
                {rows.map((row) => row.kind === 'value' ? (
                    <ApprovalValueItem key={row.path} row={row} serverId={props.serverId ?? null} anatomy="page" />
                ) : (
                    // Questions and answers, or the notice that a value cannot be shown, are content
                    // rather than one value: they sit in the section under the argument's name.
                    <SectionContentRow key={row.path}>
                        <View style={styles.row}>
                            <Text style={styles.label}>{row.title}</Text>
                            <ApprovalFieldValue row={row} />
                        </View>
                    </SectionContentRow>
                ))}
            </ItemGroup>
        );
    }

    return (
        <View style={styles.card}>
            <Text style={styles.sectionTitle}>{t('approvals.details')}</Text>
            <View style={styles.rows}>
                {rows.map((row) => (
                    <View key={row.path} style={styles.row}>
                        <Text style={styles.label}>{row.title}</Text>
                        <ApprovalFieldValue row={row} serverId={props.serverId ?? null} />
                    </View>
                ))}
            </View>
        </View>
    );
});

/**
 * One argument row. An id the person knows by name (a session, a Home) reads by that name; a session
 * this device cannot name reads by where it lives. Non-references, including Host identities,
 * keep the Protocol's literal value and structured keys.
 */
function ApprovalValueItem(props: Readonly<{
    row: Extract<ApprovalActionFieldsPresentation['rows'][number], { kind: 'value' }>;
    serverId: string | null;
    anatomy?: 'page';
}>) {
    const { row } = props;
    const reference = row.reference;
    const serverId = reference?.kind === 'session' ? reference.serverId ?? props.serverId : props.serverId;
    const name = useApprovalSessionName(serverId, reference?.kind === 'session' ? reference.id : '');
    const value = reference?.kind === 'session'
        ? name ?? describeUnnamedApprovalSession(resolveApprovalHomeName(serverId))
        : reference?.kind === 'home'
            ? resolveApprovalHomeName(reference.id)
                ?? (reference.id === props.serverId?.trim() ? t('settingsAccount.thisHomeTitle') : row.value)
            : row.value;
    if (props.anatomy !== 'page') return <Text style={styles.value}>{value}</Text>;
    return (
        <Item
            title={row.title}
            subtitle={value}
            subtitleLines={0}
            mode="info"
            showChevron={false}
        />
    );
}

function useApprovalSessionName(serverId: string | null, value: string): string | null {
    // An unresolved approval Home must not borrow the active Home's session names.
    const candidate = serverId?.trim() ? value : '';
    const session = useSessionListRenderableWithServerScope(serverId, candidate);
    if (!candidate || !session) return null;
    // A locked session's cached name stays private, as on every other approval surface.
    const encryption = projectUiSessionAwareness(session, Date.now()).encryption;
    const readable = encryption !== 'unknown' && isSessionAwarenessContentReadableV1(encryption);
    return readable ? getSessionName(session, serverId) : null;
}

function ApprovalFieldValue(props: Readonly<{ row: ApprovalActionFieldsPresentation['rows'][number]; serverId?: string | null }>) {
    const { row } = props;
    return (
        <>
            {row.kind === 'unrepresentable' ? (
                <View testID="approvals.unrepresentable-details" style={styles.unrepresentable}>
                    <Text style={styles.unrepresentableTitle}>{t('approvals.unsafeDetailsTitle')}</Text>
                    <Text style={styles.unrepresentableBody}>{t('approvals.unsafeDetailsBody')}</Text>
                </View>
            ) : null}
            {row.kind === 'structuredAnswers' ? (
                <View style={styles.structuredAnswers}>
                    {row.answers.map((answer, index) => (
                        <View key={`${answer.question}:${index}`} style={styles.structuredAnswer}>
                            <Text style={styles.question}>{answer.question}</Text>
                            {answer.values.map((value, valueIndex) => (
                                <Text key={`${value}:${valueIndex}`} style={styles.value}>{value}</Text>
                            ))}
                        </View>
                    ))}
                </View>
            ) : null}
            {row.kind === 'value' ? (
                <ApprovalValueItem row={row} serverId={props.serverId ?? null} />
            ) : null}
        </>
    );
}

const styles = StyleSheet.create((theme) => ({
    card: {
        borderRadius: 16,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.elevated,
        padding: 16,
        gap: 12,
    },
    sectionTitle: {
        fontSize: 14,
        fontWeight: '700',
        color: theme.colors.text.primary,
    },
    rows: {
        gap: 10,
    },
    row: {
        gap: 4,
    },
    label: {
        fontSize: 12,
        color: theme.colors.text.secondary,
        fontWeight: '600',
    },
    value: {
        fontSize: 14,
        color: theme.colors.text.primary,
        lineHeight: 20,
    },
    structuredAnswers: {
        gap: 10,
    },
    structuredAnswer: {
        gap: 2,
    },
    question: {
        fontSize: 14,
        color: theme.colors.text.primary,
        lineHeight: 20,
        fontWeight: '600',
    },
    unrepresentable: {
        gap: 2,
    },
    unrepresentableTitle: {
        fontSize: 14,
        lineHeight: 20,
        fontWeight: '600',
        color: theme.colors.state.danger.foreground,
    },
    unrepresentableBody: {
        fontSize: 14,
        lineHeight: 20,
        color: theme.colors.text.secondary,
    },
}));
