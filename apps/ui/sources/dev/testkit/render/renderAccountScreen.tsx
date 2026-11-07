import * as React from 'react';

import { renderScreen } from './renderScreen';

/** Account pages borrow their shell providers without pulling runtime singletons into the testkit barrel. */
export async function renderAccountScreen(
    element: React.ReactElement,
    options: Parameters<typeof renderScreen>[1] = {},
) {
    // The caller installs Home transports before the runtime-bearing provider loads.
    const [{ AccountNoticeInvestigationBoundary }, { AppPaneProvider }] = await Promise.all([
        import('@/hooks/inbox/AccountNoticeInvestigationProvider'),
        import('@/components/appShell/panes/AppPaneProvider'),
    ]);
    return renderScreen(
        <AppPaneProvider>
            <AccountNoticeInvestigationBoundary>{element}</AccountNoticeInvestigationBoundary>
        </AppPaneProvider>,
        options,
    );
}
