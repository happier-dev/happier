import * as React from 'react';
import { useRouter } from 'expo-router';

export type ProjectRouteRouter = ReturnType<typeof useRouter>;

export function useProjectRouteRouterRef(): React.MutableRefObject<ProjectRouteRouter> {
    const router = useRouter();
    const routerRef = React.useRef(router);
    routerRef.current = router;
    return routerRef;
}
