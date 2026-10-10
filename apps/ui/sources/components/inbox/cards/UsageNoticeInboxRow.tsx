import * as React from 'react';
import { Platform } from 'react-native';
import { InboxWorkRow } from '../InboxWorkRow';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { resolveMinimumInteractiveTargetSize } from '@/components/ui/interactiveTargetSize';
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
            trailingAccessory={(
                <IconButton
                    testID={`inbox.usage-notice.dismiss.${props.entry.artifact.id}`}
                    accessibilityLabel={t('inbox.actionOperations.dismiss')}
                    tooltip={t('inbox.actionOperations.dismiss')}
                    iconName="x"
                    variant="plain"
                    size={28}
                    minimumInteractiveTargetSize={resolveMinimumInteractiveTargetSize(Platform.OS)}
                    interactiveTargetGapPx={8}
                    onPress={dismiss}
                />
            )}
        />
    );
});
