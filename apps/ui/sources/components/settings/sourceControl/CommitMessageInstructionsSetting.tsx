import * as React from 'react';

import { SettingTextInput } from '@/components/settings/shell/SettingTextInput';
import { SettingRow } from '@/components/settings/shell/SettingRow';
import { useSettingActionFeedback } from '@/components/settings/shell/useSettingActionFeedback';
import { useSetting } from '@/sync/domains/state/storage';
import { t } from '@/text';
import { SOURCE_CONTROL_SETTINGS } from './sourceControlSettings';

export function CommitMessageInstructionsSetting() {
    const value = useSetting('scmCommitMessageGeneratorInstructions');
    const { setSetting } = useSettingActionFeedback();
    const setting = SOURCE_CONTROL_SETTINGS.settings.commitMessageInstructions;
    return <SettingRow subtitleLines={0} setting={setting} accessoryLayout="stacked" showChevron={false}
        rightElement={<SettingTextInput testID="settings.sourceControl.commitMessageInstructions"
            accessibilityLabel={t(setting.titleKey)}
            placeholder={t('settingsSourceControl.commitMessageGenerator.instructionsPlaceholder')}
            value={typeof value === 'string' ? value : ''} multiline autoCapitalize="sentences"
            onCommit={next => setSetting(setting, next)} />} />;
}
