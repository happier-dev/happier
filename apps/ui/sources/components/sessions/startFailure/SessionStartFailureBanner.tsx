import * as React from 'react';
import { ComposerAuxiliaryFrame } from '@/components/sessions/shell/view/ComposerAuxiliaryFrame';
import { WarningActionBanner } from '@/components/sessions/shell/view/WarningActionBanner';
import { t } from '@/text';

import type { SessionStartFailureNotice } from './sessionStartFailureNotice';

/**
 * Says why an inactive Session never started. With a retry it is an actionable warning; without one
 * (machine offline, access removed) it is quiet context beside the banner that carries the next step.
 */
export const SessionStartFailureBanner = React.memo(function SessionStartFailureBanner(props: Readonly<{
    notice: SessionStartFailureNotice;
    retry: Readonly<{ run: () => void; busy: boolean }> | null;
    managePlugin?: () => void;
}>) {
    const { notice, retry } = props;
    return (
        <ComposerAuxiliaryFrame>
            <WarningActionBanner
                testID="session-start-failure"
                tone={retry ? 'warning' : 'neutral'}
                title={t('session.startFailure.title')}
                body={notice.message}
                {...(notice.code === 'plugin_disabled' && props.managePlugin
                    ? {
                        actionTestID: 'session-start-failure-manage-plugin',
                        actionLabel: t('settingsPlugins.managePlugin'),
                        actionAccessibilityLabel: t('settingsPlugins.managePlugin'),
                        onActionPress: props.managePlugin,
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
