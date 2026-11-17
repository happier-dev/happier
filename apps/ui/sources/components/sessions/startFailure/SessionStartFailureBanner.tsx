import * as React from 'react';
import { ComposerAuxiliaryFrame } from '@/components/sessions/shell/view/ComposerAuxiliaryFrame';
import { WarningActionBanner } from '@/components/sessions/shell/view/WarningActionBanner';
import { RuntimeIssueDetails } from '@/components/sessions/transcript/events/RuntimeIssueDetails';
import { t } from '@/text';

import type { SessionStartFailureNotice } from './sessionStartFailureNotice';

/**
 * Says why an inactive Session never started, in one tone: a start failure always needs the person,
 * whether its next step is Retry, an action here, or the step its cause names.
 */
export const SessionStartFailureBanner = React.memo(function SessionStartFailureBanner(props: Readonly<{
    notice: SessionStartFailureNotice;
    retry: Readonly<{ run: () => void; busy: boolean }> | null;
    managePlugin?: () => void;
    chooseModel?: () => void;
    reviewConnection?: () => void;
}>) {
    const { notice } = props;
    const retry = notice.retryable ? props.retry : null;
    return (
        <ComposerAuxiliaryFrame>
            <WarningActionBanner
                testID="session-start-failure"
                tone="warning"
                title={notice.title ?? t('session.startFailure.title')}
                body={notice.message}
                // The transcript row for this failure defers to the notice, so its raw cause moves here.
                content={<RuntimeIssueDetails issue={notice.issue} />}
                {...(notice.providerRecovery && props.reviewConnection
                    ? {
                        actionTestID: 'session-start-failure-review-connection',
                        actionLabel: t('settingsProviders.errors.actions.reviewConnection'),
                        actionAccessibilityLabel: t('settingsProviders.errors.actions.reviewConnection'),
                        onActionPress: props.reviewConnection,
                    }
                    : notice.code === 'plugin_disabled' && props.managePlugin
                    ? {
                        actionTestID: 'session-start-failure-manage-plugin',
                        actionLabel: t('settingsPlugins.managePlugin'),
                        actionAccessibilityLabel: t('settingsPlugins.managePlugin'),
                        onActionPress: props.managePlugin,
                    }
                    : props.chooseModel
                    ? {
                        actionTestID: 'session-start-failure-choose-model',
                        actionLabel: t('newSession.selectModelTitle'),
                        actionAccessibilityLabel: t('newSession.selectModelTitle'),
                        onActionPress: props.chooseModel,
                    }
                    : retry
                    ? {
                        actionTestID: 'session-start-failure-retry',
                        actionLabel: t('common.retry'),
                        actionAccessibilityLabel: t('common.retry'),
                        actionBusy: retry.busy,
                        disabled: retry.busy,
                        onActionPress: retry.run,
                    }
                    : {})}
            />
        </ComposerAuxiliaryFrame>
    );
});
