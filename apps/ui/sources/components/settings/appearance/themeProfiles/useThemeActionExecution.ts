import * as React from 'react';
import type { ThemeActionId, ThemeActionInput, ThemeActionOutput } from '@happier-dev/protocol/actions/themeActionFamily';
import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { apiSocket } from '@/sync/api/session/apiSocket';
import { useAccountSettingsScope } from '@/sync/store/settingsWriters';
import type { UiActionOperation } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';

export type ThemeUiActionExecute = <Id extends ThemeActionId>(id: Id,
    input: ThemeActionInput<Id> & Readonly<{ clientId?: string }>,
    operation?: Pick<UiActionOperation, 'signal'>) => Promise<ThemeActionOutput<Id>>;

/** Theme controls share the mounted Action lifetime and target this app unless the person chose another. */
export function useThemeActionExecution(): ThemeUiActionExecute {
    const scope = useAccountSettingsScope();
    const { executeValue } = useMountedActionExecution(scope);
    return React.useCallback(async <Id extends ThemeActionId>(id: Id,
        input: ThemeActionInput<Id> & Readonly<{ clientId?: string }>,
        operation?: Pick<UiActionOperation, 'signal'>): Promise<ThemeActionOutput<Id>> => {
        const clientId = input.clientId ?? apiSocket.getSocketId();
        // The Action front door already validates the output associated with this catalog id.
        return await executeValue(id, { ...input, ...(clientId ? { clientId } : {}) }, operation) as ThemeActionOutput<Id>;
    }, [executeValue]);
}
