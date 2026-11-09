import * as React from 'react';
import type { QualifiedConnectedAccountRef } from '@happier-dev/protocol/connect/qualified-connected-account-persistence';
import type { QualifiedConnectedAccountProfileV4 } from '@happier-dev/protocol/connect/qualifiedConnectedAccountsV4';

export type ConnectedAccountSetupFacts = Pick<QualifiedConnectedAccountProfileV4, 'includesApiKey'>;
export type ConnectedAccountSetupCompletion = Readonly<{ account: QualifiedConnectedAccountRef }> & ConnectedAccountSetupFacts;

/** Retire the acknowledged sign-in form before its host navigates or closes setup. */
export function useConnectedAccountSetupCompletion(input: Readonly<{
    isCurrent: () => boolean;
    onConnected?: (account: QualifiedConnectedAccountRef, facts?: ConnectedAccountSetupFacts) => void;
}>): Readonly<{
    completed: boolean;
    complete: (account: QualifiedConnectedAccountRef, facts?: ConnectedAccountSetupFacts) => void;
    reset: () => void;
}> {
    const [completion, setCompletion] = React.useState<ConnectedAccountSetupCompletion | null>(null);
    const latest = React.useRef(input);
    latest.current = input;
    React.useEffect(() => {
        // Passive unmount cleanup releases the form's dirty navigation guard first.
        if (!completion || !latest.current.isCurrent()) return;
        if (completion.includesApiKey) latest.current.onConnected?.(completion.account, { includesApiKey: completion.includesApiKey });
        else latest.current.onConnected?.(completion.account);
    }, [completion]);
    const complete = React.useCallback((account: QualifiedConnectedAccountRef, facts?: ConnectedAccountSetupFacts) =>
        setCompletion({ account, ...facts }), []);
    const reset = React.useCallback(() => setCompletion(null), []);
    return { completed: completion !== null, complete, reset };
}
