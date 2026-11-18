import * as React from 'react';
import { useSettingActionWriter, type SettingActionAddress } from '@/components/settings/catalog/useSettingActionWriter';
import type { SettingValue } from '@/components/settings/catalog/settingDeclarations';
import { presentSettingWriteFailure } from './writeFailure';
import { holdSettingWrite } from '@/sync/store/settingsPreview';
import { readBuiltInSettingUiStorage } from '@/components/settings/catalog/settingDeclarations';

export type DeclaredSettingsWrite = ReturnType<typeof useSettingActionFeedback>['setSetting'];

/** Presentation only: declared-setting admission and custody stay with the canonical writer. */
export function useSettingActionFeedback(options?: Parameters<typeof useSettingActionWriter>[0]) {
    const write = useSettingActionWriter(options);
    const setSetting = React.useCallback(async (setting: SettingActionAddress, value: SettingValue,
        operation?: Parameters<typeof write>[2]): Promise<boolean> => {
        const canPreview = write.isCurrent(setting);
        const binding = canPreview ? readBuiltInSettingUiStorage(setting.anchor) : undefined;
        const withdraw = canPreview
            ? holdSettingWrite(setting, value, binding?.scope === 'account' && 'kind' in binding && binding.kind === 'owner'
                ? current => {
                    const parsed = binding.parse(value);
                    return parsed.success ? binding.mutate(current, parsed.value) : null;
                } : undefined)
            : undefined;
        try {
            const result = await write(setting, value, { ...operation, onApprovalPending: () => {
                withdraw?.(); operation?.onApprovalPending?.();
            } });
            if (!write.isAccountCurrent(setting)) return false;
            if (result.ok) return true;
            presentSettingWriteFailure(result);
        } catch (error) {
            if (!write.isAccountCurrent(setting)) return false;
            presentSettingWriteFailure(error);
        } finally { withdraw?.(); }
        return false;
    }, [write]);
    return { setSetting, isCurrent: write.isCurrent, ready: write.ready, approval: write.approval };
}
