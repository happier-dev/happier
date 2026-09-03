import * as React from 'react';
import type { ActionOperationSnapshotV1 } from '@happier-dev/protocol';

import { requestActionOperationStop } from './requestActionOperationStop';

export function useActionOperationStopControl(operation: ActionOperationSnapshotV1 | null | undefined) {
    const mountedRef = React.useRef(true);
    const [pending, setPending] = React.useState(false);
    const [failed, setFailed] = React.useState(false);

    React.useEffect(() => {
        mountedRef.current = true;
        return () => {
            mountedRef.current = false;
        };
    }, []);

    const requestStop = React.useCallback(() => {
        if (!operation || pending) return;
        setPending(true);
        setFailed(false);
        void requestActionOperationStop(operation)
            .catch(() => {
                if (mountedRef.current) setFailed(true);
            })
            .finally(() => {
                if (mountedRef.current) setPending(false);
            });
    }, [operation, pending]);

    return { pending, failed, requestStop } as const;
}
