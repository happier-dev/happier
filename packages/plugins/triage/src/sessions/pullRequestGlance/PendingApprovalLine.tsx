import * as React from 'react';
import type { ReactElement } from 'react';
import { ApprovalPendingNotice, usePluginHostApi, useSurfaceContext } from '@happier-dev/plugin-ui';

/**
 * A watch or link change that waits for approval: the host's own pending-approval fact for this mount, with the way
 * to it. Approving, waiting and settling stay with the request's owner; nothing here retries.
 */
export function PendingApprovalLine(props: Readonly<{ testID?: string }>): ReactElement | null {
    const host = usePluginHostApi();
    const pending = useSurfaceContext().pendingApproval ?? null;
    if (pending === null) return null;
    return <ApprovalPendingNotice presentation="line" testID={props.testID ?? 'pr-approval-pending'}
        onOpen={() => { void host.openExternalLink(pending.href).catch(() => undefined); }} />;
}
