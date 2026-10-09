import * as React from 'react';

import { SettingRow, SettingSection } from '@/components/settings/shell/SettingRow';
import { Switch } from '@/components/ui/forms/Switch';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { useSettingMutable } from '@/sync/domains/state/storage';
import { t } from '@/text';

import { PROMPTS_CONTEXT_SETTINGS } from './promptsContextSettings';

/**
 * Settings → Context › Memory defaults (lab `c-ctx D`; D45, D47): whether a new session and a new bot
 * start with memory, and whether a new bot gets its weekly memory-upkeep habit. Each row says the
 * consequence of its current state. They are Account preferences read once, when something is
 * created; changing one never changes an existing session or bot.
 */
export const AccountMemoryDefaultsSection = React.memo(function AccountMemoryDefaultsSection() {
    const [sessions, setSessions] = useSettingMutable('memoryUseInNewSessions');
    const [bots, setBots] = useSettingMutable('memoryUseInNewBots');
    const [upkeep, setUpkeep] = useSettingMutable('memoryUpkeepInNewBots');
    const settings = PROMPTS_CONTEXT_SETTINGS.settings;
    return (
        <SettingSection section={PROMPTS_CONTEXT_SETTINGS.sectionRefs.memoryDefaults}>
            <ItemGroup title={t('promptLibrary.memoryDefaultsTitle')} description={t('contextPages.account.defaultsDescription')}>
                <SettingRow
                    testID="context.memoryDefaults.sessions"
                    setting={settings.memoryUseInNewSessions}
                    subtitle={sessions ? t('contextPages.account.sessionsOn') : t('contextPages.account.sessionsOff')}
                    showChevron={false}
                    rightElement={<Switch testID="context.memoryDefaults.sessions.switch" value={sessions === true} onValueChange={setSessions} />}
                />
                <SettingRow
                    testID="context.memoryDefaults.bots"
                    setting={settings.memoryUseInNewBots}
                    subtitle={bots ? t('contextPages.account.botsOn') : t('contextPages.account.botsOff')}
                    showChevron={false}
                    rightElement={<Switch testID="context.memoryDefaults.bots.switch" value={bots === true} onValueChange={setBots} />}
                />
                <SettingRow
                    testID="context.memoryDefaults.upkeep"
                    setting={settings.memoryUpkeepInNewBots}
                    subtitle={upkeep ? t('contextPages.account.upkeepOn') : t('contextPages.account.upkeepOff')}
                    showChevron={false}
                    rightElement={<Switch testID="context.memoryDefaults.upkeep.switch" value={upkeep === true} onValueChange={setUpkeep} />}
                />
            </ItemGroup>
        </SettingSection>
    );
});
