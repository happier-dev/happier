import * as React from 'react';

import { useMountedRef } from '@/hooks/ui/useMountedRef';

export function useMountedShouldContinue(): () => boolean {
    const mountedRef = useMountedRef();
    return React.useCallback(() => mountedRef.current, [mountedRef]);
}

