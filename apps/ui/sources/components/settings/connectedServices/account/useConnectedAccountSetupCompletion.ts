import * as React from 'react';
import type { QualifiedConnectedAccountRef } from '@happier-dev/protocol/connect/qualified-connected-account-persistence';

/** Retire the acknowledged sign-in form before its host navigates or closes setup. */
export function useConnectedAccountSetupCompletion(input: Readonly<{
    isCurrent: () => boolean;
    onConnected?: (account: QualifiedConnectedAccountRef) => void;
}>): Readonly<{
    completed: boolean;
    complete: (account: QualifiedConnectedAccountRef) => void;
    reset: () => void;
}> {
    const [account, setAccount] = React.useState<QualifiedConnectedAccountRef | null>(null);
    const latest = React.useRef(input);
    latest.current = input;
    React.useEffect(() => {
        // Passive unmount cleanup releases the form's dirty navigation guard first.
        if (account && latest.current.isCurrent()) latest.current.onConnected?.(account);
    }, [account]);
    const reset = React.useCallback(() => setAccount(null), []);
    return { completed: account !== null, complete: setAccount, reset };
}
