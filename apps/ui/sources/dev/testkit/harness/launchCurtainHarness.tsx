import * as React from 'react';

import { finishLaunchCurtain, holdLaunchCurtain, useLaunchCurtainState } from '@/boot/launchCurtain';
import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import { installShippedNativeFrameScheduler } from '@/dev/testkit/legend/shippedNativeLegendRuntime';

/** The HTML poster is present on an initial web document, even in the node renderer. */
export function startTestLaunchCurtain() {
    installShippedNativeFrameScheduler();
    const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
    let releaseShell: () => void;
    if (typeof document === 'undefined') {
        Object.defineProperty(globalThis, 'document', {
            configurable: true,
            value: { documentElement: { classList: { contains: (name: string) => name === 'launch-planet' } } },
        });
        try {
            releaseShell = holdLaunchCurtain();
        } finally {
            if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument);
            else Reflect.deleteProperty(globalThis, 'document');
        }
    } else {
        document.documentElement.classList.add('launch-planet');
        releaseShell = holdLaunchCurtain();
    }
    return {
        releaseShell,
        paint: () => flushHookEffects({ frames: 2, cycles: 1 }),
        finish: finishLaunchCurtain,
        dispose() {
            releaseShell();
            finishLaunchCurtain();
        },
    };
}

export function CurtainProbe() {
    return React.createElement('CurtainProbe', { state: useLaunchCurtainState() });
}
