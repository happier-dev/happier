import * as React from 'react';

import { createReactNativeWebMock } from '../mocks/reactNative';

/** Observe row renders at the React Native View boundary with the actual row components mounted. */
export function createNativeViewRenderCounts(...rowIds: string[]) {
    const counts = new Map(rowIds.map(id => [id, 0]));
    const View = React.forwardRef<unknown, Readonly<{ testID?: string; children?: React.ReactNode }>>((props, ref) => {
        const id = props.testID;
        if (id && counts.has(id)) counts.set(id, counts.get(id)! + 1);
        return React.createElement('View', { ...props, ref });
    });
    return {
        reactNative: () => createReactNativeWebMock({ View }),
        read: () => Object.fromEntries(counts),
        reset: () => { for (const id of rowIds) counts.set(id, 0); },
    };
}
