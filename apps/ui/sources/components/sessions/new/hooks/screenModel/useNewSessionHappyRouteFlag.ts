import * as React from 'react';
import { Platform } from 'react-native';

export function useNewSessionHappyRouteFlag(pathname: string): void {
    const previousHappyRouteRef = React.useRef<string | undefined>(undefined);
    const hasCapturedPreviousHappyRouteRef = React.useRef(false);

    React.useEffect(() => {
        if (Platform.OS !== 'web') return;
        if (typeof document === 'undefined') return;

        const root = document.documentElement;
        if (!hasCapturedPreviousHappyRouteRef.current) {
            previousHappyRouteRef.current = root.dataset.happyRoute;
            hasCapturedPreviousHappyRouteRef.current = true;
        }

        const previous = previousHappyRouteRef.current;
        if (pathname === '/new') {
            root.dataset.happyRoute = 'new';
        } else if (previous === undefined) {
            delete root.dataset.happyRoute;
        } else {
            root.dataset.happyRoute = previous;
        }

        return () => {
            if (pathname !== '/new') return;
            if (root.dataset.happyRoute !== 'new') return;

            if (previous === undefined) {
                delete root.dataset.happyRoute;
            } else {
                root.dataset.happyRoute = previous;
            }
        };
    }, [pathname]);
}
