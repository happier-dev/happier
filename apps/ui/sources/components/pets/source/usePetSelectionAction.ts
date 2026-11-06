import * as React from 'react';
import type { PetChooseInputV1 } from '@happier-dev/protocol/pets/selection';
import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';

import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { storage } from '@/sync/domains/state/storage';

/** The existing mounted Action lifetime holds a device choice through Inbox approval. */
export function usePetSelectionAction(): (input: PetChooseInputV1, operation?: Readonly<{ signal?: AbortSignal }>) => Promise<ActionExecuteResult> {
    const scope = storage(state => state.settingsScope);
    const mounted = useMountedActionExecution(scope, { retainInvocation: true });
    return React.useCallback((input: PetChooseInputV1, operation?: Readonly<{ signal?: AbortSignal }>) =>
        mounted.execute('ui.pet.choose', input, operation), [mounted.execute]);
}
