import * as React from 'react';

import { HomeHub } from '@/components/hub/HomeHub';
import { PHONE_HOME_ROUTE } from '@/components/navigation/shell/PhoneHomeLogoButton';

/** Home as a page: phones open it from the Sessions header logo (tablets show it in the main pane). */
export default function HomeRoute() {
    return <HomeHub launchPathname={PHONE_HOME_ROUTE} />;
}
