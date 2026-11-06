import * as React from 'react';
import { useRouter } from 'expo-router';

import { runGuardedNavigation } from '@/utils/navigation/runGuardedNavigation';
import { fireAndForget } from '@/utils/system/fireAndForget';

/** Home on a phone is a pushed page, since the tabs stay Sessions · Projects · Inbox · Workflows. */
export const PHONE_HOME_ROUTE = '/home';

/** The phone's one way to open Home as a page: the first row of the tab bar's More. */
export function useOpenPhoneHome(): () => void {
    const router = useRouter();
    return React.useCallback(() => {
        const result = runGuardedNavigation(() => router.push(PHONE_HOME_ROUTE));
        if (result !== true) fireAndForget(result, { tag: 'PhoneHomeLogoButton.home' });
    }, [router]);
}
