import * as React from 'react';

import { RowStatusLine } from '@/components/ui/status/RowStatusLine';

import { formatMachineAgentStatus } from './machineAgentCopy';
import type { MachineAgentStatus } from './machineAgentPresentation';

/**
 * The one status line of an agent row or card: the shared row status line over the agent's status.
 * Work in progress (installing, checking, waiting for sign-in) leads with a spinner.
 */
export const MachineAgentStatusLine = React.memo(function MachineAgentStatusLine(props: Readonly<{
    status: MachineAgentStatus;
    testID?: string;
    /** Cards allow two lines; rows keep one. */
    numberOfLines?: number;
}>) {
    const { status } = props;
    const busy = status.kind === 'installing' || status.kind === 'checking' || status.kind === 'waitingForSignIn';
    return (
        <RowStatusLine
            testID={props.testID}
            text={formatMachineAgentStatus(status)}
            tone={status.tone}
            busy={busy}
            numberOfLines={props.numberOfLines}
        />
    );
});
