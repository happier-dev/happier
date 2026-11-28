import * as React from 'react';
import { InboxWorkRow } from '../InboxWorkRow';
import { InboxDismissRowMenu } from '../InboxRowMenu';
import type { OpenUsageNoticeArtifact } from '@/sync/domains/artifacts/usageNoticeArtifacts';
import { alertInboxNoticeDismissalFailure } from '../noticeDismissalFailure';
import { t } from '@/text';

export const UsageNoticeInboxRow = React.memo(function UsageNoticeInboxRow(props: Readonly<{
    entry: OpenUsageNoticeArtifact;
    onOpen: () => void;
    onDismiss: (entry: OpenUsageNoticeArtifact) => Promise<void>;
    /** A phone row gives the title the row's width (see `InboxWorkRow`). */
    narrow?: boolean;
}>) {
    const dismiss = React.useCallback(async () => {
        try { await props.onDismiss(props.entry); }
        catch (error) { alertInboxNoticeDismissalFailure(error); }
    }, [props.entry, props.onDismiss]);
    return (
        <InboxWorkRow
            testID={`inbox.usage-notice.${props.entry.artifact.id}`}
            title={props.entry.header.title}
            onPress={props.onOpen}
            narrow={props.narrow}
            trailingAccessory={<InboxDismissRowMenu testID={`inbox.usage-notice.dismiss.${props.entry.artifact.id}`} onDismiss={dismiss} />}
        />
    );
});
