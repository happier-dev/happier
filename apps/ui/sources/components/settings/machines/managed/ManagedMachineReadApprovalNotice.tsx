import * as React from 'react';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { useActionApprovalContinuation } from '@/components/approvals/useActionApprovalContinuation';
import { AttentionBanner } from '@/components/ui/lists/AttentionBanner';
import { t } from '@/text';
import type { ManagedMachineInventoryEntry } from './useManagedMachineInventory';

/** Reconnects a demanded inventory read to the existing approval Artifact, without issuing another read. */
export function ManagedMachineReadApprovalNotice(props: Readonly<{
    serverId: string;
    entry?: ManagedMachineInventoryEntry;
    testID?: string;
}>) {
    const router = useRouter();
    const approval = useActionApprovalContinuation({
        scopeKey: JSON.stringify([props.serverId, props.entry?.accountId, props.entry?.managedId]),
        serverId: props.serverId,
        onExecuted: () => {},
    });
    React.useEffect(() => {
        if (props.entry?.approval) approval.requestApproval(props.entry.approval);
    }, [props.entry?.approval, approval.requestApproval]);
    if (!approval.approvalId) return null;
    return <AttentionBanner testID={props.testID ?? 'managed-machine.read-approval'} tone="neutral"
        title={t('approvals.title')} description={t('approvals.status.open')}
        action={{ label: t('approvals.details'), onPress: () => router.push(
            `/inbox/approvals/${encodeURIComponent(approval.approvalId!)}?serverId=${encodeURIComponent(props.serverId)}` as never,
        ) }} />;
}
