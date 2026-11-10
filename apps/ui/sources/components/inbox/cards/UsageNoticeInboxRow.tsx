import * as React from 'react';
import { InboxWorkRow } from '../InboxWorkRow';
import { InboxDismissRowMenu } from '../InboxRowMenu';
import type { OpenUsageNoticeArtifact } from '@/sync/domains/artifacts/usageNoticeArtifacts';
import { Modal } from '@/modal';
import { t } from '@/text';

export const UsageNoticeInboxRow = React.memo(function UsageNoticeInboxRow(props: Readonly<{
    entry: OpenUsageNoticeArtifact;
    onOpen: () => void;
    onDismiss: (entry: OpenUsageNoticeArtifact) => Promise<void>;
}>) {
    const dismiss = React.useCallback(async () => {
        try { await props.onDismiss(props.entry); }
        catch { Modal.alert(t('common.error'), t('errors.unknownError')); }
    }, [props.entry, props.onDismiss]);
    return (
        <InboxWorkRow
            testID={`inbox.usage-notice.${props.entry.artifact.id}`}
            title={props.entry.header.title}
            onPress={props.onOpen}
            trailingAccessory={<InboxDismissRowMenu testID={`inbox.usage-notice.dismiss.${props.entry.artifact.id}`} onDismiss={dismiss} />}
        />
    );
});
