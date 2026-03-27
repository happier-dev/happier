import * as React from 'react';

import type { CustomModalChromeCardConfig, CustomModalInjectedProps } from '../../types';

export function useModalCardChrome(
    setChrome: CustomModalInjectedProps['setChrome'] | undefined,
    chrome: CustomModalChromeCardConfig | null,
): void {
    React.useLayoutEffect(() => {
        if (!setChrome) return;
        setChrome(chrome);
    }, [chrome, setChrome]);
}

