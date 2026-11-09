import * as React from 'react';
import { Redirect, useLocalSearchParams } from 'expo-router';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';

import { resolveLegacyAccountEntryRedirect } from '@/components/navigation/accountEntry/authenticatedAccountEntryRoute';
import { buildMachineAddHref } from '@/components/settings/machines/collection/machineCollectionModel';
import { openAddHome } from '@/components/homes/add/openAddHome';

export default function SetupWizardRoute() {
    const params = useLocalSearchParams() as Readonly<Record<string, string | string[] | undefined>>;
    const router = useRouter();
    const accountEntry = resolveLegacyAccountEntryRedirect(params);
    const scope = typeof params.scope === 'string' ? params.scope.trim() : '';
    React.useEffect(() => {
        if (!accountEntry && scope === 'relay') openAddHome(router, { replace: true, path: 'server_home' });
    }, [accountEntry, router, scope]);
    if (accountEntry) {
        return <Redirect href={accountEntry} />;
    }

    if (scope === 'machine') {
        const action = typeof params.action === 'string' ? params.action.trim() : '';
        const path = action === 'local' ? 'thisComputer' : action === 'remote' ? 'ssh' : undefined;
        return <Redirect href={buildMachineAddHref({ path })} />;
    }
    if (scope === 'relay') {
        return null;
    }
    return <Redirect href="/" />;
}
