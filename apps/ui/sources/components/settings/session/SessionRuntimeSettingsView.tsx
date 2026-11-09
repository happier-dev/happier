import * as React from 'react';

import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { SegmentedChoiceItem } from '@/components/ui/lists/SegmentedChoiceItem';
import { Item } from '@/components/ui/lists/Item';
import { FieldItem } from '@/components/ui/forms/FieldItem';
import { SettingTextInput } from '@/components/settings/shell/SettingTextInput';
import { Switch } from '@/components/ui/forms/Switch';
import { t } from '@/text';
import { useSetting } from '@/sync/domains/state/storage';
import { resolveTerminalHost } from '@/sync/domains/settings/terminalSettings';
import { useSettingActionFeedback } from '@/components/settings/shell/useSettingActionFeedback';
import { SettingsPageHeader } from '@/components/settings/shell/SettingsPageHeader';
import { SettingAnchor, SettingSection } from '@/components/settings/shell/SettingRow';
import { SESSION_RUNTIME_SETTINGS } from '@/components/settings/session/sessionRuntimeSettings';

export const SessionRuntimeSettingsView = React.memo(function SessionRuntimeSettingsView() {
    const useTmux = useSetting('sessionUseTmux');
    const terminalHost = useSetting('sessionTerminalHost');
    const tmuxSessionName = useSetting('sessionTmuxSessionName');
    const tmuxIsolated = useSetting('sessionTmuxIsolated');
    const tmuxTmpDir = useSetting('sessionTmuxTmpDir');
    const { setSetting } = useSettingActionFeedback();
    const selectedTerminalHost = resolveTerminalHost({ settings: {
        sessionUseTmux: useTmux, sessionTerminalHost: terminalHost,
        sessionTmuxByMachineId: {}, sessionTerminalHostByMachineId: {},
    }, machineId: null });

    return (
        <ItemList style={{ paddingTop: 0 }}>
            <SettingsPageHeader description={t('settingsSessionPages.runtime.pageDescription')} />
            <SettingSection section={SESSION_RUNTIME_SETTINGS.sectionRefs.terminal}>
                <ItemGroup title={t('settingsSessionPages.runtime.terminalSection')}>
                    <SettingAnchor setting={SESSION_RUNTIME_SETTINGS.settings.host}>
                        <SegmentedChoiceItem<'none' | 'tmux' | 'zellij' | 'herdr'>
                            testID="settings-session-terminal-host-item"
                            testIDPrefix="settings-session-terminal-host"
                            title={t(SESSION_RUNTIME_SETTINGS.settings.host.titleKey)}
                            options={[
                                { id: 'none', label: t('settingsSessionPages.runtime.terminalHostNone') },
                                { id: 'tmux', label: 'tmux' },
                                { id: 'zellij', label: 'Zellij' },
                                { id: 'herdr', label: 'Herdr' },
                            ]}
                            value={selectedTerminalHost}
                            onChange={(next) => {
                                void setSetting(SESSION_RUNTIME_SETTINGS.settings.host, next);
                            }}
                        />
                    </SettingAnchor>
                    {selectedTerminalHost === 'tmux' && <>
                        <SettingAnchor setting={SESSION_RUNTIME_SETTINGS.settings.sessionName}>
                            <FieldItem label={t('profiles.tmuxSession')} supportingText={t('common.optional')}>
                                <SettingTextInput
                                    testID="settings-session-tmux-name"
                                    accessibilityLabel={t('profiles.tmuxSession')}
                                    placeholder={t('profiles.tmux.sessionNamePlaceholder')}
                                    value={tmuxSessionName}
                                    onCommit={(value) => setSetting(SESSION_RUNTIME_SETTINGS.settings.sessionName, value)}
                                    autoCapitalize="none" monospace
                                />
                            </FieldItem>
                        </SettingAnchor>
                        <SettingAnchor setting={SESSION_RUNTIME_SETTINGS.settings.isolated}>
                            <Item title={t('profiles.tmux.isolatedServerTitle')}
                                subtitle={tmuxIsolated ? t('profiles.tmux.isolatedServerEnabledSubtitle') : t('profiles.tmux.isolatedServerDisabledSubtitle')}
                                showChevron={false}
                                rightElement={<Switch testID="settings-session-tmux-isolated" value={tmuxIsolated}
                                    onValueChange={(value) => { void setSetting(SESSION_RUNTIME_SETTINGS.settings.isolated, value); }} />}
                            />
                        </SettingAnchor>
                        {tmuxIsolated && <SettingAnchor setting={SESSION_RUNTIME_SETTINGS.settings.tmpDir}>
                            <FieldItem label={t('profiles.tmuxTempDir')} supportingText={t('common.optional')}>
                                <SettingTextInput
                                    testID="settings-session-tmux-tmpdir"
                                    accessibilityLabel={t('profiles.tmuxTempDir')}
                                    placeholder={t('profiles.tmux.tempDirPlaceholder')}
                                    value={tmuxTmpDir ?? ''}
                                    normalize={value => value.trim().length > 0 ? value : ''}
                                    onCommit={(value) => setSetting(SESSION_RUNTIME_SETTINGS.settings.tmpDir, value || null)}
                                    autoCapitalize="none" monospace
                                />
                            </FieldItem>
                        </SettingAnchor>}
                    </>}
                </ItemGroup>
            </SettingSection>
        </ItemList>
    );
});

export default SessionRuntimeSettingsView;
