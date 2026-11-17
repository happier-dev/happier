import * as React from 'react';
import type { ThemeActionId, ThemeActionInput, ThemeActionOutput } from '@happier-dev/protocol/actions/themeActionFamily';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { Modal } from '@/modal';
import { t } from '@/text';
import type { ThemeProfileMode, ThemeReference } from '@/theme/profiles/themeProfileTypes';
import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { apiSocket } from '@/sync/api/session/apiSocket';
import { useAccountSettingsScope } from '@/sync/store/settingsWriters';
import type { UiActionOperation } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';

export type ThemeUiActionExecute = <Id extends ThemeActionId>(id: Id,
    input: ThemeActionInput<Id> & Readonly<{ clientId?: string }>,
    operation?: Pick<UiActionOperation, 'signal'>) => Promise<ThemeActionOutput<Id>>;

export function confirmThemeProfileDelete(
    reference: ThemeReference,
    selection: Readonly<Record<ThemeProfileMode, ThemeReference | null>>,
): Promise<boolean> {
    const assignedSlots = (['light', 'dark'] as const)
        .filter(mode => sameStrictJsonValue(selection[mode], reference))
        .map(mode => t(mode === 'light'
            ? 'settingsAppearance.themeProfiles.lightModeSection'
            : 'settingsAppearance.themeProfiles.darkModeSection'));

    return Modal.confirm(
        t('settingsAppearance.themeProfiles.deleteProfile'),
        assignedSlots.length > 0
            ? t('settingsAppearance.themeProfiles.deleteAssignedThemeBody', { slots: assignedSlots.join(' · ') })
            : t('settingsAppearance.themeProfiles.deleteProfileSubtitle'),
        { confirmText: t('common.delete'), destructive: true },
    );
}

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
