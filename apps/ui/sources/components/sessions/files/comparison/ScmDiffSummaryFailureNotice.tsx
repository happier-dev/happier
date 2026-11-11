import * as React from 'react';

import { AttentionBanner } from '@/components/ui/lists/AttentionBanner';
import type { ScmDiffSummaryFailurePresentation } from '@/sync/domains/scm/diffSummary/state';
import { t } from '@/text';

import { describeScmDiffSummaryFailure } from './ScmDiffSummaryStartOptions';

/**
 * A refused or failed generation beside a reading or proposal that is already on screen: local to its pane, so
 * the shared inline notice (never a hard-edged strip, PATTERN-AUDIT-UI-1111 E), written from the same typed presentation the empty state uses ({@link describeScmDiffSummaryFailure}).
 * Native codes and reason strings remain diagnostic data; only typed presentation reaches this copy.
 */
export function ScmDiffSummaryFailureNotice(props: Readonly<{
    failure: ScmDiffSummaryFailurePresentation;
    /** The surface's test id prefix: `<prefix>-notice-failed`, `<prefix>-choose-model`, `<prefix>-retry`. */
    testID: string;
    /**
     * The fact of where writing stopped ("Writing stopped after 3 stops"), for an output that kept what it wrote. It leads
     * the band; a typed cause follows it as the description, and an unclassified ending says nothing more.
     */
    lead?: string;
    onChooseModel?: () => void;
    onEnableExplain?: () => void;
    onRetry?: () => void;
}>) {
    const described = describeScmDiffSummaryFailure(props.failure);
    const failed = props.failure.reason === 'generationFailed' || props.failure.reason === 'endedPartway';
    const chooseModel = described.nextAction === 'chooseModel' ? props.onChooseModel : undefined;
    const enableExplain = described.nextAction === 'enableExplain' ? props.onEnableExplain : undefined;
    const link = chooseModel
        ? { testID: `${props.testID}-choose-model`, label: described.action!, onPress: chooseModel }
        : enableExplain ? { testID: `${props.testID}-enable-explain`, label: described.action!, onPress: enableExplain }
        : null;
    // A step with nothing to press (update the machine, reconnect it) finishes the sentence the failure leads.
    const cause = props.lead && props.failure.reason === 'endedPartway' ? null : described.message;
    const description = [cause, described.nextStep].filter(Boolean).join(' ') || undefined;
    return (
        <AttentionBanner placement="inline" testID={`${props.testID}-notice-failed`} announce={failed ? 'alert' : 'status'} tone={failed ? 'danger' : 'warning'}
            title={props.lead ? (description ? `${props.lead} ·` : props.lead) : described.message} description={props.lead ? description : described.nextStep ?? undefined}
            secondaryAction={link}
            action={props.onRetry && props.failure.nextAction !== 'narrowChange' ? { testID: `${props.testID}-retry`, icon: 'arrows-clockwise', label: t('walkthrough.notice.tryAgain'), onPress: props.onRetry } : null} />
    );
}
