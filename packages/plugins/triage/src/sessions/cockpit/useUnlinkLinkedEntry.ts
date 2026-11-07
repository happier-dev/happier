import * as React from 'react';
import { usePluginHostApi } from '@happier-dev/plugin-ui';
import {
    createActionTriageUnlinkTransport,
    type TriageUnlinkLinkedEntryV1,
} from './unlinkLinkedEntry.js';

/** Both ends of a relationship use the same admitted removal and authoritative reread. */
export function useTriageUnlinkLinkedEntry(onRefresh: () => void | Promise<void>) {
    const host = usePluginHostApi();
    const transport = React.useMemo(
        () => createActionTriageUnlinkTransport(host),
        [host],
    );
    const [phase, setPhase] = React.useState<'idle' | 'removing' | 'failed'>('idle');
    const unlink = React.useCallback(async (target: TriageUnlinkLinkedEntryV1) => {
        if (phase === 'removing') return;
        setPhase('removing');
        try {
            const result = await transport.unlink(target);
            if (result === null) {
                setPhase('idle');
                return;
            }
            if (result.status === 'failed') {
                setPhase('failed');
                return;
            }
            // A conflict also requires a reread; it never authorizes a forced delete.
            await onRefresh();
            setPhase('idle');
        } catch {
            setPhase('failed');
        }
    }, [onRefresh, phase, transport]);
    return { phase, unlink };
}
