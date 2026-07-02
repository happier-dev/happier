import * as React from 'react';

import { useComposerKeyboardLayout } from './ComposerKeyboardContext';

export function useComposerAvailablePanelHeight(): number | undefined {
    const layout = useComposerKeyboardLayout();
    const [height, setHeight] = React.useState<number | undefined>(() => layout?.availablePanelHeight.value);

    React.useEffect(() => {
        if (!layout) {
            setHeight(undefined);
            return undefined;
        }
        if (layout.subscribeAvailablePanelHeight) {
            return layout.subscribeAvailablePanelHeight(setHeight);
        }
        setHeight(layout.availablePanelHeight.value);
        return undefined;
    }, [layout]);

    return height;
}
