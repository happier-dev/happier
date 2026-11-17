import * as React from 'react';

import { RowStatusLine } from '@/components/ui/status/RowStatusLine';

import { formatMachineAgentLastKnown, formatMachineAgentStatus } from './machineAgentCopy';
import type { MachineAgentStatus } from './machineAgentPresentation';

/**
 * The one status line of an agent row or card: the shared row status line over the agent's status.
 * Work in progress (installing, checking, waiting for sign-in) leads with a spinner. Where the host already says the
 * machine is offline once, an offline row keeps only what it last reported ("Last seen signed in"), or nothing.
 */
export const MachineAgentStatusLine = React.memo(function MachineAgentStatusLine(props: Readonly<{
    status: MachineAgentStatus;
    testID?: string;
    /** Cards allow two lines; rows keep one. */
    numberOfLines?: number;
    /** The host says once that the machine is offline (a section line, an "N offline machines" row). */
    machineOfflineSaid?: boolean;
}>) {
    const { status } = props;
    const text = status.kind === 'offline' && props.machineOfflineSaid
        ? formatMachineAgentLastKnown(status)
        : formatMachineAgentStatus(status);
    if (text === null) return null;
    const busy = status.kind === 'installing' || status.kind === 'checking' || status.kind === 'waitingForSignIn';
    return (
        <RowStatusLine
            testID={props.testID}
            text={text}
            tone={status.tone}
            busy={busy}
            numberOfLines={props.numberOfLines}
        />
    );
});
