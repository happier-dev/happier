import * as React from 'react';

import { SettingRow, SettingSection } from '@/components/settings/shell/SettingRow';
import { Switch } from '@/components/ui/forms/Switch';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { useSetting } from '@/sync/domains/state/storage';
import { useSettingActionWriter } from '@/components/settings/catalog/useSettingActionWriter';
import type { SettingRef } from '@/components/settings/catalog/settingDeclarations';
import { Modal } from '@/modal';
import { t } from '@/text';

import { PROMPTS_CONTEXT_SETTINGS } from './promptsContextSettings';

/**
 * Settings → Context › Use memory in new sessions (lab `c-ctx D`; D45, D47): whether a new session
 * and a new bot start with memory, and whether a new bot gets its weekly memory-upkeep habit. The
 * section title carries the question, so its two rows are just "Sessions" and "Bots" (Search still
 * finds each by its full declared name). Each row says the consequence of its current state. They
 * are Account preferences read once, when something is created; changing one never changes an
 * existing session or bot.
 */
export const AccountMemoryDefaultsSection = React.memo(function AccountMemoryDefaultsSection() {
    const sessions = useSetting('memoryUseInNewSessions');
    const bots = useSetting('memoryUseInNewBots');
    const upkeep = useSetting('memoryUpkeepInNewBots');
    const writeSetting = useSettingActionWriter();
    const write = async (setting: SettingRef, value: boolean) => {
        try {
            const result = await writeSetting(setting, value);
            if (!result.ok || result.result && typeof result.result === 'object' && 'ok' in result.result && result.result.ok === false) {
                Modal.alert(t('common.error'), t('common.saveError'));
            }
        } catch { Modal.alert(t('common.error'), t('common.saveError')); }
    };
    const settings = PROMPTS_CONTEXT_SETTINGS.settings;
    return (
        <SettingSection section={PROMPTS_CONTEXT_SETTINGS.sectionRefs.memoryDefaults}>
            <ItemGroup title={t('promptLibrary.memoryUseInNewSessionsTitle')} description={t('contextPages.account.defaultsDescription')}>
                <SettingRow
                    testID="context.memoryDefaults.sessions"
                    setting={{ ...settings.memoryUseInNewSessions, title: t('tabs.sessions') }}
                    subtitle={sessions ? t('contextPages.account.sessionsOn') : t('contextPages.account.sessionsOff')}
                    showChevron={false}
                    rightElement={<Switch testID="context.memoryDefaults.sessions.switch" value={sessions === true} onValueChange={value => write(settings.memoryUseInNewSessions, value)} />}
                />
                <SettingRow
                    testID="context.memoryDefaults.bots"
                    setting={{ ...settings.memoryUseInNewBots, title: t('bots.title') }}
                    subtitle={bots ? t('contextPages.account.botsOn') : t('contextPages.account.botsOff')}
                    showChevron={false}
                    rightElement={<Switch testID="context.memoryDefaults.bots.switch" value={bots === true} onValueChange={value => write(settings.memoryUseInNewBots, value)} />}
                />
                <SettingRow
                    testID="context.memoryDefaults.upkeep"
                    setting={settings.memoryUpkeepInNewBots}
                    subtitle={upkeep ? t('contextPages.account.upkeepOn') : t('contextPages.account.upkeepOff')}
                    showChevron={false}
                    rightElement={<Switch testID="context.memoryDefaults.upkeep.switch" value={upkeep === true} onValueChange={value => write(settings.memoryUpkeepInNewBots, value)} />}
                />
            </ItemGroup>
        </SettingSection>
    );
});
