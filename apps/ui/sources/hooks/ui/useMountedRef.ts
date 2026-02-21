import * as React from 'react';

export function useMountedRef(): React.MutableRefObject<boolean> {
    const mountedRef = React.useRef(false);

    React.useEffect(() => {
        mountedRef.current = true;
        return () => {
            mountedRef.current = false;
        };
    }, []);

    return mountedRef;
}
