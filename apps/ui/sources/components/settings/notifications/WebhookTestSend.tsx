import * as React from 'react';
import type { WebhookNotificationTestResult } from '@happier-dev/protocol/actions/notificationConfigurationActionFamily';
import { Item } from '@/components/ui/lists/Item';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { t } from '@/text';

export type ExecuteWebhookTest = (channelId: string) => Promise<WebhookNotificationTestResult | null>;

export function WebhookTestSend(props: Readonly<{ channelId: string; disabled: boolean; executeTest: ExecuteWebhookTest }>) {
    const [result, setResult] = React.useState<WebhookNotificationTestResult | null>(null);
    const [sending, setSending] = React.useState(false);
    const failed = result !== null && result.status !== 'delivered';
    const subtitle = result?.status === 'delivered' ? t('settingsNotifications.webhooks.testDelivered')
        : result?.status === 'refused' ? t('settingsNotifications.webhooks.testRefused', {
            reason: t(`settingsNotifications.webhooks.testReasons.${result.reason}`)
                + (result.httpStatus === undefined ? '' : ` (HTTP ${result.httpStatus})`),
        }) : result?.status === 'unreachable' ? t('settingsNotifications.webhooks.testUnreachable', { reason: result.reason })
        : t('settingsNotifications.webhooks.testSubtitle');
    return <Item testID={`settings-notifications-webhook-${props.channelId}-test-result-${result?.status ?? 'idle'}`}
        title={t('settingsNotifications.webhooks.testTitle')} subtitle={subtitle} showChevron={false}
        accessoryLayout="adaptive" rightElement={<RoundButton size="small" display="inverted"
            testID={`settings-notifications-webhook-${props.channelId}-test${failed ? '-retry' : ''}`}
            title={failed ? t('common.retry') : t('settingsNotifications.webhooks.sendTest')}
            disabled={props.disabled || sending} loading={sending}
            onPress={async () => {
                setSending(true);
                try {
                    const next = await props.executeTest(props.channelId);
                    if (next) setResult(next);
                } finally { setSending(false); }
            }} />}
    />;
}
