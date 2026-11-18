import * as React from 'react';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { SettingTextInput } from '@/components/settings/shell/SettingTextInput';
import { SettingRow } from '@/components/settings/shell/SettingRow';
import { useSettingActionFeedback } from '@/components/settings/shell/useSettingActionFeedback';
import { Text } from '@/components/ui/text/Text';
import { useSetting } from '@/sync/domains/state/storage';
import { t } from '@/text';
import { TRANSCRIPT_SETTINGS } from './transcriptSettings';

export function TranscriptTemplateSetting(props: Readonly<{ tipStyle: React.ComponentProps<typeof Text>['style'] }>) {
    const { theme } = useUnistyles();
    const value = useSetting('transcriptMessageSendToSessionTemplate');
    const { setSetting } = useSettingActionFeedback();
    return <SettingRow testID="settings-session-transcript-message-send-template-field"
        setting={TRANSCRIPT_SETTINGS.settings.sendToSessionTemplate}
        subtitle={t('settingsSession.transcript.messageActions.template.subtitle')} subtitleLines={0}
        accessoryLayout="stacked" showChevron={false}
        rightElement={<View style={{ gap: theme.space.s6 }}>
            <SettingTextInput testID="settings-session-transcript-message-send-template-input"
                accessibilityLabel={t('settingsSession.transcript.messageActions.template.title')}
                value={typeof value === 'string' ? value : '{{MESSAGES}}'}
                onCommit={next => setSetting(TRANSCRIPT_SETTINGS.settings.sendToSessionTemplate, next)}
                placeholder={t('settingsSession.transcript.messageActions.template.placeholder')} multiline monospace
                supportingContent={draft => !draft.includes('{{MESSAGES}}') ? <Text style={[props.tipStyle, { color: theme.colors.state.warning.textForeground }]}>
                    {t('settingsSession.transcript.messageActions.template.warningMissingPlaceholder')}
                </Text> : null} />
        </View>} />;
}
