import * as React from 'react';
import { View } from 'react-native';

import { useUnistyles } from 'react-native-unistyles';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Switch } from '@/components/ui/forms/Switch';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import type { VoiceSettings } from '@/sync/domains/settings/voiceSettings';
import { t } from '@/text';
import { Icon } from '@/components/ui/icons/Icon';

/**
 * Presentational only.
 *
 * `voice`/`setVoice` carry the **synced** Voice settings; `voiceOrbEnabled`/`setVoiceOrbEnabled`
 * carry a **device-local** preference. The section renders both and owns neither — the Voice
 * settings route reads MMKV through `useLocalSettingMutable` and hands the pair down. Reading
 * storage here would put a second owner behind the same switch.
 */
export function VoiceUiSection(props: {
  voice: VoiceSettings;
  setVoice: (next: VoiceSettings) => void;
  voiceOrbEnabled: boolean;
  setVoiceOrbEnabled: (next: boolean) => void;
  popoverBoundaryRef?: React.RefObject<any> | null;
}) {
  const { theme } = useUnistyles();
  const ui = props.voice.ui;
  const [openMenu, setOpenMenu] = React.useState<
    | null
    | 'scopeDefault'
    | 'surfaceLocation'
    | 'updatesActiveSession'
    | 'updatesOtherSessions'
    | 'snippetsMaxMessages'
    | 'otherSessionsSnippetsMode'
  >(null);

  const setUi = (patch: Partial<typeof ui>) => {
    props.setVoice({ ...props.voice, ui: { ...ui, ...patch } });
  };

  const updates = ui.updates;
  const showSnippetsOptions = updates.activeSession === 'snippets' || updates.otherSessions === 'snippets';
  const showOtherSessionsSnippetMode = updates.otherSessions === 'snippets';

  const setUpdatePatch = (patch: Partial<typeof updates>) => {
    setUi({ updates: { ...updates, ...patch } });
  };

  return (
    <>
      <ItemGroup title={t('settingsVoice.ui.title')} footer={t('settingsVoice.ui.footer')}>
        <Item
          title={t('settingsVoice.ui.activityFeedEnabled')}
          subtitle={t('settingsVoice.ui.activityFeedEnabledSubtitle')}
          subtitleLines={0}
          rightElement={
            <Switch
              testID="settings.voice.ui.activityFeedEnabled"
              accessibilityLabel={t('settingsVoice.ui.activityFeedEnabled')}
              value={ui.activityFeedEnabled}
              onValueChange={(v) => setUi({ activityFeedEnabled: v })}
            />
          }
        />

        {ui.activityFeedEnabled ? (
          <Item
            title={t('settingsVoice.ui.activityFeedAutoExpandOnStart')}
            subtitle={t('settingsVoice.ui.activityFeedAutoExpandOnStartSubtitle')}
            subtitleLines={0}
            rightElement={
              <Switch
                accessibilityLabel={t('settingsVoice.ui.activityFeedAutoExpandOnStart')}
                value={ui.activityFeedAutoExpandOnStart}
                onValueChange={(v) => setUi({ activityFeedAutoExpandOnStart: v })}
              />
            }
          />
        ) : null}

        <Item
          title={t('settingsVoice.ui.orbEnabled')}
          subtitle={t('settingsVoice.ui.orbEnabledSubtitle')}
          subtitleLines={0}
          rightElement={
            <Switch
              testID="settings.voice.ui.orbEnabled"
              accessibilityLabel={t('settingsVoice.ui.orbEnabled')}
              value={props.voiceOrbEnabled}
              onValueChange={props.setVoiceOrbEnabled}
            />
          }
        />

        <DropdownMenu
          open={openMenu === 'scopeDefault'}
          onOpenChange={(next) => setOpenMenu(next ? 'scopeDefault' : null)}
          variant="selectable"
          search={false}
          selectedId={ui.scopeDefault}
          showCategoryTitles={false}
          matchTriggerWidth={true}
          connectToTrigger={true}
          rowKind="item"
          popoverBoundaryRef={props.popoverBoundaryRef}
          itemTrigger={{
            title: t('settingsVoice.ui.scopeTitle'),
            subtitle: t('settingsVoice.ui.scopeSubtitle'),
            showSelectedSubtitle: false,
            itemProps: { subtitleLines: 0 },
          }}
          items={[
            {
              id: 'global',
              title: t('settingsVoice.ui.scopeGlobal'),
              subtitle: t('settingsVoice.ui.scopeGlobalSubtitle'),
              icon: (
                <View style={{ width: 32, height: 32, alignItems: 'center', justifyContent: 'center' }}>
                  <Icon name="globe" size={20} color={theme.colors.text.secondary} />
                </View>
              ),
            },
            {
              id: 'session',
              title: t('settingsVoice.ui.scopeSession'),
              subtitle: t('settingsVoice.ui.scopeSessionSubtitle'),
              icon: (
                <View style={{ width: 32, height: 32, alignItems: 'center', justifyContent: 'center' }}>
                  <Icon name="file-text" size={20} color={theme.colors.text.secondary} />
                </View>
              ),
            },
          ]}
          onSelect={(id) => {
            setUi({ scopeDefault: id as any });
            setOpenMenu(null);
          }}
        />

        <DropdownMenu
          testID="settings.voice.ui.surfaceLocation"
          open={openMenu === 'surfaceLocation'}
          onOpenChange={(next) => setOpenMenu(next ? 'surfaceLocation' : null)}
          variant="selectable"
          search={false}
          selectedId={ui.surfaceLocation}
          showCategoryTitles={false}
          matchTriggerWidth={true}
          connectToTrigger={true}
          rowKind="item"
          popoverBoundaryRef={props.popoverBoundaryRef}
          itemTrigger={{
            title: t('settingsVoice.ui.surfaceLocationTitle'),
            subtitle: t('settingsVoice.ui.surfaceLocationSubtitle'),
            showSelectedSubtitle: false,
            itemProps: { subtitleLines: 0 },
          }}
          items={[
            {
              id: 'auto',
              testID: 'settings.voice.ui.surfaceLocation.auto',
              title: t('settingsVoice.ui.surfaceLocation.autoTitle'),
              subtitle: t('settingsVoice.ui.surfaceLocation.autoSubtitle'),
              icon: (
                <View style={{ width: 32, height: 32, alignItems: 'center', justifyContent: 'center' }}>
                  <Icon name="sparkle" size={20} color={theme.colors.text.secondary} />
                </View>
              ),
            },
            {
              id: 'sidebar',
              testID: 'settings.voice.ui.surfaceLocation.sidebar',
              title: t('settingsVoice.ui.surfaceLocation.sidebarTitle'),
              subtitle: t('settingsVoice.ui.surfaceLocation.sidebarSubtitle'),
              icon: (
                <View style={{ width: 32, height: 32, alignItems: 'center', justifyContent: 'center' }}>
                  <Icon name="stack" size={20} color={theme.colors.text.secondary} />
                </View>
              ),
            },
            {
              id: 'session',
              testID: 'settings.voice.ui.surfaceLocation.session',
              title: t('settingsVoice.ui.surfaceLocation.sessionTitle'),
              subtitle: t('settingsVoice.ui.surfaceLocation.sessionSubtitle'),
              icon: (
                <View style={{ width: 32, height: 32, alignItems: 'center', justifyContent: 'center' }}>
                  <Icon name="chat-circle-dots" size={20} color={theme.colors.text.secondary} />
                </View>
              ),
            },
          ]}
          onSelect={(id) => {
            setUi({ surfaceLocation: id as any });
            setOpenMenu(null);
          }}
        />
      </ItemGroup>

      <ItemGroup title={t('settingsVoice.ui.updates.title')} footer={t('settingsVoice.ui.updates.footer')}>
        <DropdownMenu
          open={openMenu === 'updatesActiveSession'}
          onOpenChange={(next) => setOpenMenu(next ? 'updatesActiveSession' : null)}
          variant="selectable"
          search={false}
          selectedId={updates.activeSession}
          showCategoryTitles={false}
          matchTriggerWidth={true}
          connectToTrigger={true}
          rowKind="item"
          popoverBoundaryRef={props.popoverBoundaryRef}
          itemTrigger={{
            title: t('settingsVoice.ui.updates.activeSessionTitle'),
            subtitle: t('settingsVoice.ui.updates.activeSessionSubtitle'),
            showSelectedSubtitle: false,
            itemProps: { subtitleLines: 0 },
          }}
          items={[
            {
              id: 'none',
              title: t('settingsVoice.ui.updates.level.noneTitle'),
              subtitle: t('settingsVoice.ui.updates.level.noneSubtitle'),
              icon: (
                <View style={{ width: 32, height: 32, alignItems: 'center', justifyContent: 'center' }}>
                  <Icon name="minus" size={20} color={theme.colors.text.secondary} />
                </View>
              ),
            },
            {
              id: 'activity',
              title: t('settingsVoice.ui.updates.level.activityTitle'),
              subtitle: t('settingsVoice.ui.updates.level.activitySubtitle'),
              icon: (
                <View style={{ width: 32, height: 32, alignItems: 'center', justifyContent: 'center' }}>
                  <Icon name="lightning" size={20} color={theme.colors.text.secondary} />
                </View>
              ),
            },
            {
              id: 'summaries',
              title: t('settingsVoice.ui.updates.level.summariesTitle'),
              subtitle: t('settingsVoice.ui.updates.level.summariesSubtitle'),
              icon: (
                <View style={{ width: 32, height: 32, alignItems: 'center', justifyContent: 'center' }}>
                  <Icon name="file" size={20} color={theme.colors.text.secondary} />
                </View>
              ),
            },
            {
              id: 'snippets',
              title: t('settingsVoice.ui.updates.level.snippetsTitle'),
              subtitle: t('settingsVoice.ui.updates.level.snippetsSubtitle'),
              icon: (
                <View style={{ width: 32, height: 32, alignItems: 'center', justifyContent: 'center' }}>
                  <Icon name="code" size={20} color={theme.colors.text.secondary} />
                </View>
              ),
            },
          ]}
          onSelect={(id) => {
            setUpdatePatch({ activeSession: id as any });
            setOpenMenu(null);
          }}
        />

        <DropdownMenu
          open={openMenu === 'updatesOtherSessions'}
          onOpenChange={(next) => setOpenMenu(next ? 'updatesOtherSessions' : null)}
          variant="selectable"
          search={false}
          selectedId={updates.otherSessions}
          showCategoryTitles={false}
          matchTriggerWidth={true}
          connectToTrigger={true}
          rowKind="item"
          popoverBoundaryRef={props.popoverBoundaryRef}
          itemTrigger={{
            title: t('settingsVoice.ui.updates.otherSessionsTitle'),
            subtitle: t('settingsVoice.ui.updates.otherSessionsSubtitle'),
            showSelectedSubtitle: false,
            itemProps: { subtitleLines: 0 },
          }}
          items={[
            {
              id: 'none',
              title: t('settingsVoice.ui.updates.level.noneTitle'),
              subtitle: t('settingsVoice.ui.updates.level.noneSubtitle'),
              icon: (
                <View style={{ width: 32, height: 32, alignItems: 'center', justifyContent: 'center' }}>
                  <Icon name="minus" size={20} color={theme.colors.text.secondary} />
                </View>
              ),
            },
            {
              id: 'activity',
              title: t('settingsVoice.ui.updates.level.activityTitle'),
              subtitle: t('settingsVoice.ui.updates.level.activitySubtitle'),
              icon: (
                <View style={{ width: 32, height: 32, alignItems: 'center', justifyContent: 'center' }}>
                  <Icon name="lightning" size={20} color={theme.colors.text.secondary} />
                </View>
              ),
            },
            {
              id: 'summaries',
              title: t('settingsVoice.ui.updates.level.summariesTitle'),
              subtitle: t('settingsVoice.ui.updates.level.summariesSubtitle'),
              icon: (
                <View style={{ width: 32, height: 32, alignItems: 'center', justifyContent: 'center' }}>
                  <Icon name="file" size={20} color={theme.colors.text.secondary} />
                </View>
              ),
            },
            {
              id: 'snippets',
              title: t('settingsVoice.ui.updates.level.snippetsTitle'),
              subtitle: t('settingsVoice.ui.updates.level.snippetsSubtitle'),
              icon: (
                <View style={{ width: 32, height: 32, alignItems: 'center', justifyContent: 'center' }}>
                  <Icon name="code" size={20} color={theme.colors.text.secondary} />
                </View>
              ),
            },
          ]}
          onSelect={(id) => {
            setUpdatePatch({ otherSessions: id as any });
            setOpenMenu(null);
          }}
        />

        {showSnippetsOptions ? (
          <>
            <DropdownMenu
              open={openMenu === 'snippetsMaxMessages'}
              onOpenChange={(next) => setOpenMenu(next ? 'snippetsMaxMessages' : null)}
              variant="selectable"
              search={false}
              selectedId={String(updates.snippetsMaxMessages)}
              showCategoryTitles={false}
              matchTriggerWidth={true}
              connectToTrigger={true}
              rowKind="item"
              popoverBoundaryRef={props.popoverBoundaryRef}
              itemTrigger={{
                title: t('settingsVoice.ui.updates.snippetsMaxMessagesTitle'),
                subtitle: t('settingsVoice.ui.updates.snippetsMaxMessagesSubtitle'),
                showSelectedSubtitle: false,
                itemProps: { subtitleLines: 0 },
              }}
              items={Array.from({ length: 10 }, (_, idx) => {
                const n = idx + 1;
                return {
                  id: String(n),
                  title: String(n),
                  subtitle: undefined,
                  icon: (
                    <View style={{ width: 32, height: 32, alignItems: 'center', justifyContent: 'center' }}>
                      <Icon name="list" size={20} color={theme.colors.text.secondary} />
                    </View>
                  ),
                };
              })}
              onSelect={(id) => {
                const n = Number(id);
                if (!Number.isFinite(n)) return;
                setUpdatePatch({ snippetsMaxMessages: Math.max(1, Math.min(10, Math.floor(n))) });
                setOpenMenu(null);
              }}
            />

            <Item
              title={t('settingsVoice.ui.updates.includeUserMessagesInSnippetsTitle')}
              subtitle={t('settingsVoice.ui.updates.includeUserMessagesInSnippetsSubtitle')}
              subtitleLines={0}
              rightElement={
                <Switch
                  accessibilityLabel={t('settingsVoice.ui.updates.includeUserMessagesInSnippetsTitle')}
                  value={updates.includeUserMessagesInSnippets}
                  onValueChange={(v) => setUpdatePatch({ includeUserMessagesInSnippets: v })}
                />
              }
            />
          </>
        ) : null}

        {showOtherSessionsSnippetMode ? (
          <>
            <DropdownMenu
              open={openMenu === 'otherSessionsSnippetsMode'}
              onOpenChange={(next) => setOpenMenu(next ? 'otherSessionsSnippetsMode' : null)}
              variant="selectable"
              search={false}
              selectedId={updates.otherSessionsSnippetsMode}
              showCategoryTitles={false}
              matchTriggerWidth={true}
              connectToTrigger={true}
              rowKind="item"
              popoverBoundaryRef={props.popoverBoundaryRef}
              itemTrigger={{
                title: t('settingsVoice.ui.updates.otherSessionsSnippetsModeTitle'),
                subtitle: t('settingsVoice.ui.updates.otherSessionsSnippetsModeSubtitle'),
                showSelectedSubtitle: false,
                itemProps: { subtitleLines: 0 },
              }}
              items={[
                {
                  id: 'never',
                  title: t('settingsVoice.ui.updates.otherSessionsSnippetsMode.neverTitle'),
                  subtitle: t('settingsVoice.ui.updates.otherSessionsSnippetsMode.neverSubtitle'),
                  icon: (
                    <View style={{ width: 32, height: 32, alignItems: 'center', justifyContent: 'center' }}>
                      <Icon name="minus" size={20} color={theme.colors.text.secondary} />
                    </View>
                  ),
                },
                {
                  id: 'on_demand_only',
                  title: t('settingsVoice.ui.updates.otherSessionsSnippetsMode.onDemandTitle'),
                  subtitle: t('settingsVoice.ui.updates.otherSessionsSnippetsMode.onDemandSubtitle'),
                  icon: (
                    <View style={{ width: 32, height: 32, alignItems: 'center', justifyContent: 'center' }}>
                      <Icon name="hand" size={20} color={theme.colors.text.secondary} />
                    </View>
                  ),
                },
                {
                  id: 'auto',
                  title: t('settingsVoice.ui.updates.otherSessionsSnippetsMode.autoTitle'),
                  subtitle: t('settingsVoice.ui.updates.otherSessionsSnippetsMode.autoSubtitle'),
                  icon: (
                    <View style={{ width: 32, height: 32, alignItems: 'center', justifyContent: 'center' }}>
                      <Icon name="sparkle" size={20} color={theme.colors.text.secondary} />
                    </View>
                  ),
                },
              ]}
              onSelect={(id) => {
                setUpdatePatch({ otherSessionsSnippetsMode: id as any });
                setOpenMenu(null);
              }}
            />
          </>
        ) : null}
      </ItemGroup>
    </>
  );
}
