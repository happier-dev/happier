import * as React from 'react';
import { useSettingActionFeedback } from '@/components/settings/shell/useSettingActionFeedback';
import type { SettingValue } from '@/components/settings/catalog/settingDeclarations';
import { AGENT_SETTINGS } from './agentsSettings';

/** The target-keyed Agent preferences; a `null` value resets that one target's entry. */
export type AgentPreferenceSetting = 'defaultPermission' | 'enabled' | 'executableSource'
    | 'idleCompaction' | 'idleCompaction.minContextTokens' | 'idleCompaction.cacheWindowOverrideMs';

/** Thin UI adapter; Action admission, approval, feedback and keyed mutation remain canonical. */
export function useAgentPreferenceWriter() {
    const { setSetting } = useSettingActionFeedback();
    return React.useCallback(async (setting: AgentPreferenceSetting, agentTargetKey: string, value: SettingValue) => {
        await setSetting(AGENT_SETTINGS.settings[setting], { agentTargetKey, value });
    }, [setSetting]);
}
