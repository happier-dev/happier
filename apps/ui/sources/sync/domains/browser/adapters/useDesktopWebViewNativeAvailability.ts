import * as React from 'react';

import type { BrowserPlatformV1 } from '@happier-dev/protocol';

import {
    readDesktopWebViewNativeAvailability,
} from './desktopWebViewBridge';
import type { DesktopWebViewNativeAvailability } from './desktopWebView';

export function useDesktopWebViewNativeAvailability(input: Readonly<{
    platform: BrowserPlatformV1;
    availability?: DesktopWebViewNativeAvailability | null;
}>): DesktopWebViewNativeAvailability | null {
    const [availability, setAvailability] = React.useState<DesktopWebViewNativeAvailability | null>(
        input.availability ?? null,
    );

    React.useEffect(() => {
        if (input.availability !== undefined) {
            setAvailability(input.availability ?? null);
            return undefined;
        }
        if (input.platform !== 'desktop') {
            setAvailability(null);
            return undefined;
        }

        let disposed = false;
        readDesktopWebViewNativeAvailability().then((nextAvailability) => {
            if (!disposed) {
                setAvailability(nextAvailability);
            }
        }).catch(() => {
            if (!disposed) {
                setAvailability(null);
            }
        });

        return () => {
            disposed = true;
        };
    }, [input.availability, input.platform]);

    return availability;
}
