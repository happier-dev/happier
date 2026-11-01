import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { ActionIdSchema } from '@happier-dev/protocol/actions/actionIds';
import { WidgetLayoutFragmentActionIdV1Schema, readWidgetApprovalPresentationV1 } from '@happier-dev/protocol/widgets';
import { presentActionApproval } from './actionApprovalPresentation';
import { usePreferredLanguage } from '@/text/usePreferredLanguage';

type ApprovalSummaryInput = Readonly<{ actionId: string; actionArgs: unknown }>;

/** A supplied request summary reads through its domain owner; absent previews remain absent. */
export function readApprovalPreviewSummary(preview: unknown, request?: ApprovalSummaryInput): string | null {
    if (!preview || typeof preview !== 'object' || Array.isArray(preview)) return null;
    const storedSummary = typeof (preview as { summary?: unknown }).summary === 'string'
        ? (preview as { summary: string }).summary.trim()
        : '';
    if (!storedSummary) return null;
    const actionId = request ? ActionIdSchema.safeParse(request.actionId) : null;
    if (actionId?.success) {
        // The library owner captured this name before the mutation. Raw delete
        // operands contain only an id and cannot re-derive that description.
        if (WidgetLayoutFragmentActionIdV1Schema.safeParse(actionId.data).success
            && 'widgetLibraryName' in preview && typeof preview.widgetLibraryName === 'string' && preview.widgetLibraryName.trim()) return storedSummary;
        const spec = getActionSpec(actionId.data);
        if (readWidgetApprovalPresentationV1(preview)) return presentActionApproval({ actionId: actionId.data,
            actionArgs: request?.actionArgs, preview }).summary;
        const summary = spec.approvalPresentation && (spec.inputSchema.safeParse(request?.actionArgs).success
            || spec.approvalPresentation.inputSchema?.safeParse(request?.actionArgs).success)
            ? spec.approvalPresentation?.summary(request?.actionArgs) : null;
        return presentActionApproval({ actionId: actionId.data, actionArgs: request?.actionArgs,
            authoredSummary: summary || storedSummary }).summary;
    }
    return storedSummary;
}

export const ApprovalPreviewCard = React.memo(function ApprovalPreviewCard(props: Readonly<{ preview: unknown; request?: ApprovalSummaryInput }>) {
    const language = usePreferredLanguage();
    const summary = React.useMemo(() => readApprovalPreviewSummary(props.preview, props.request), [props.preview, props.request, language]);
    if (!summary) return null;

    return (
        <View style={styles.card}>
            <Text style={styles.summary}>{summary}</Text>
        </View>
    );
});

const styles = StyleSheet.create((theme) => ({
    // Sheet content of the approval's "Request" section: the section owns the chrome.
    card: {
        gap: theme.space.s4,
    },
    summary: {
        fontSize: 14,
        color: theme.colors.text.secondary,
        lineHeight: 20,
    },
}));
