import * as React from 'react';
import { ScrollView, View } from 'react-native';
import { ReviewStartInputSchema } from '@happier-dev/protocol/reviews/reviewStart';
import type { PluginUiSelectActionInputResultV1 } from '@happier-dev/protocol/plugins/ui';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Text } from '@/components/ui/text/Text';
import { getSessionInputFailureLabelKey } from '@/components/sessions/pending/pendingMessageVisualState';
import { Modal } from '@/modal';
import type { CustomModalInjectedProps } from '@/modal/types';
import { randomUUID } from '@/platform/randomUUID';
import { t } from '@/text';

import { useReviewExecutionRunLaunchOptions } from './useReviewExecutionRunLaunchOptions';

type LaunchSelection = Extract<PluginUiSelectActionInputResultV1, { kind: 'executionRunLaunch' }>;
export type ReviewExecutionRunLaunchSelectionRequest = Readonly<{
    sessionId: string;
    serverId: string;
    draft: Readonly<{ engineIds: readonly string[]; instructions: string }>;
    isCurrent: () => boolean;
}>;

/** No-invoke review selection: the same controls and admission as the incumbent review dialog. */
export function ReviewExecutionRunLaunchSelectionModal(props: CustomModalInjectedProps & ReviewExecutionRunLaunchSelectionRequest & Readonly<{
    onResolve: (selection: LaunchSelection | null) => void;
}>) {
    const [busy, setBusy] = React.useState(false);
    const [error, setError] = React.useState<string | null>(null);
    const [operationId] = React.useState(randomUUID);
    const options = useReviewExecutionRunLaunchOptions({ sessionId: props.sessionId, serverId: props.serverId,
        engineIds: props.draft.engineIds, busy });
    const continueLaunch = async () => {
        if (busy || !options.ready || !props.isCurrent()) return;
        setBusy(true);
        setError(null);
        try {
            // The complete canonical review context retains the Team single-engine
            // and consent refinements; only its value-free credential fields leave.
            const admitted = ReviewStartInputSchema.parse({ ...props.draft, ...options.input, sessionId: props.sessionId });
            await options.launcher.admitExactTarget({
                secretReferenceOverlay: admitted.secretReferenceOverlay !== undefined,
                teamCredentialModel: admitted.teamCredentialModel !== undefined,
            }, operationId);
            if (!props.isCurrent() || !options.launcher.accountLifetime?.isCurrent()) return;
            props.onResolve({ kind: 'executionRunLaunch', input: {
                ...(admitted.secretReferenceOverlay ? { secretReferenceOverlay: admitted.secretReferenceOverlay } : {}),
                ...(admitted.teamCredentialModel ? { teamCredentialModel: admitted.teamCredentialModel } : {}),
                ...(admitted.teamCredentialSessionBindingConsent ? { teamCredentialSessionBindingConsent: admitted.teamCredentialSessionBindingConsent } : {}),
            } });
        } catch (cause) {
            const label = getSessionInputFailureLabelKey(cause);
            setError(label ? t(label) : cause instanceof Error ? cause.message : t('common.requestFailed'));
        } finally {
            setBusy(false);
        }
    };
    return <View testID="review-execution-run-launch-selection" style={{ gap: 16, maxHeight: '100%', flexShrink: 1 }}>
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ gap: 16 }}>
            <Text>{t('reviewWalkthrough.dialog.instructions')}</Text>
            <Text>{props.draft.instructions}</Text>
            {options.controls}
            {error ? <Text testID="review-execution-run-launch-error" accessibilityRole="alert">{error}</Text> : null}
        </ScrollView>
        <View style={{ flexDirection: 'row', justifyContent: 'flex-end', gap: 8 }}>
            <RoundButton testID="review-execution-run-launch-cancel" size="normal" display="secondary"
                title={t('common.cancel')} onPress={() => props.onResolve(null)} />
            <RoundButton testID="review-execution-run-launch-continue" size="normal" title={t('common.continue')}
                disabled={busy || !options.ready} loading={busy} onPress={() => { void continueLaunch(); }} />
        </View>
    </View>;
}

/** Native/modal lifecycle boundary; dismissal never admits a review or carries a readiness receipt. */
export function presentReviewExecutionRunLaunchSelection(request: ReviewExecutionRunLaunchSelectionRequest) {
    let modalId = '';
    let settled = false;
    let hideAfterShow = false;
    let resolveResult!: (selection: LaunchSelection | null) => void;
    const result = new Promise<LaunchSelection | null>((resolve) => { resolveResult = resolve; });
    const settle = (selection: LaunchSelection | null) => {
        if (settled) return;
        settled = true;
        resolveResult(selection);
        if (modalId) Modal.hide(modalId);
        else hideAfterShow = true;
    };
    const close = () => settle(null);
    modalId = Modal.show({
        component: ReviewExecutionRunLaunchSelectionModal,
        props: { ...request, onResolve: settle },
        onRequestClose: close,
        onHostUnmount: close,
        closeOnBackdrop: true,
        chrome: { kind: 'card', title: t('scmComparison.startReview'), dimensions: { width: 520 }, phonePresentation: 'sheet' },
    });
    if (!modalId) close();
    else if (hideAfterShow) Modal.hide(modalId);
    return { result, close };
}
