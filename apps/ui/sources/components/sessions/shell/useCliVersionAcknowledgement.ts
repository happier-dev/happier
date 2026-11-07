import * as React from 'react';
import { cliVersionAcknowledgementsState, useCliVersionAcknowledgements } from '@/sync/domains/state/onboardingUiState';
import { isVersionSupported, MINIMUM_CLI_VERSION } from '@/utils/system/versionUtils';

/** The existing Machine/version warning choice is device presentation history. */
export function useCliVersionAcknowledgement(machineId: string | null | undefined, cliVersion: string | null | undefined) {
    const acknowledged = useCliVersionAcknowledgements();
    const outdated = cliVersion && !isVersionSupported(cliVersion, MINIMUM_CLI_VERSION);
    const shouldShowCliWarning = Boolean(outdated && !(machineId && acknowledged[machineId] === cliVersion));
    const handleDismissCliWarning = React.useCallback(() => {
        if (!machineId || !cliVersion) return;
        cliVersionAcknowledgementsState.set('machines', {
            ...cliVersionAcknowledgementsState.read('machines'),
            [machineId]: cliVersion,
        });
    }, [cliVersion, machineId]);
    return { shouldShowCliWarning, handleDismissCliWarning };
}
