import * as React from 'react';

import type { BrowserPlatformV1 } from '@happier-dev/protocol/browser/view/v1';

import {
    readDesktopWebViewLaunchAvailability,
    readDesktopWebViewNativeAvailability,
} from './desktopWebViewBridge';
import type { DesktopWebViewNativeAvailability } from './desktopWebView';

export function useDesktopWebViewNativeAvailability(input: Readonly<{
    platform: BrowserPlatformV1;
    availability?: DesktopWebViewNativeAvailability | null;
}>): DesktopWebViewNativeAvailability | null {
    const [launchAvailability] = React.useState(readDesktopWebViewLaunchAvailability);
    const [availability, setAvailability] = React.useState<DesktopWebViewNativeAvailability | null>(null);

    React.useEffect(() => {
        if (input.availability !== undefined || launchAvailability || input.platform !== 'desktop') {
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
    }, [input.availability, input.platform, launchAvailability]);

    if (input.availability !== undefined) return input.availability;
    return input.platform === 'desktop' ? launchAvailability ?? availability : null;
}
