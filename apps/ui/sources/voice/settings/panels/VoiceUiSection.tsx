import * as React from 'react';
import { View } from 'react-native';

import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Switch } from '@/components/ui/forms/Switch';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import type { VoiceSettings } from '@/sync/domains/settings/voiceSettings';
import { t } from '@/text';

export function VoiceUiSection(props: {
  voice: VoiceSettings;
  setVoice: (next: VoiceSettings) => void;
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
          rightElement={
            <Switch value={ui.activityFeedEnabled} onValueChange={(v) => setUi({ activityFeedEnabled: v })} />
          }
        />

        {ui.activityFeedEnabled ? (
          <Item
            title={t('settingsVoice.ui.activityFeedAutoExpandOnStart')}
            subtitle={t('settingsVoice.ui.activityFeedAutoExpandOnStartSubtitle')}
            rightElement={
              <Switch
                value={ui.activityFeedAutoExpandOnStart}
                onValueChange={(v) => setUi({ activityFeedAutoExpandOnStart: v })}
              />
            }
          />
        ) : null}

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
          trigger={({ open, toggle }) => (
            <Item
              title={t('settingsVoice.ui.scopeTitle')}
              subtitle={t('settingsVoice.ui.scopeSubtitle')}
              detail={ui.scopeDefault === 'global' ? t('settingsVoice.ui.scopeGlobal') : t('settingsVoice.ui.scopeSession')}
              rightElement={<Ionicons name={open ? 'chevron-up' : 'chevron-down'} size={20} color={theme.colors.textSecondary} />}
              onPress={toggle}
              showChevron={false}
              selected={false}
            />
          )}
          items={[
            {
              id: 'global',
              title: t('settingsVoice.ui.scopeGlobal'),
              subtitle: t('settingsVoice.ui.scopeGlobalSubtitle'),
              icon: (
                <View style={{ width: 32, height: 32, alignItems: 'center', justifyContent: 'center' }}>
                  <Ionicons name="globe-outline" size={22} color={theme.colors.textSecondary} />
                </View>
              ),
            },
            {
              id: 'session',
              title: t('settingsVoice.ui.scopeSession'),
              subtitle: t('settingsVoice.ui.scopeSessionSubtitle'),
              icon: (
                <View style={{ width: 32, height: 32, alignItems: 'center', justifyContent: 'center' }}>
                  <Ionicons name="document-text-outline" size={22} color={theme.colors.textSecondary} />
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
          trigger={({ open, toggle }) => (
            <Item
              title={t('settingsVoice.ui.surfaceLocationTitle')}
              subtitle={t('settingsVoice.ui.surfaceLocationSubtitle')}
              detail={(() => {
                if (ui.surfaceLocation === 'sidebar') return t('settingsVoice.ui.surfaceLocation.sidebarTitle');
                if (ui.surfaceLocation === 'session') return t('settingsVoice.ui.surfaceLocation.sessionTitle');
                return t('settingsVoice.ui.surfaceLocation.autoTitle');
              })()}
              rightElement={<Ionicons name={open ? 'chevron-up' : 'chevron-down'} size={20} color={theme.colors.textSecondary} />}
              onPress={toggle}
              showChevron={false}
              selected={false}
            />
          )}
          items={[
            {
              id: 'auto',
              title: t('settingsVoice.ui.surfaceLocation.autoTitle'),
              subtitle: t('settingsVoice.ui.surfaceLocation.autoSubtitle'),
              icon: (
                <View style={{ width: 32, height: 32, alignItems: 'center', justifyContent: 'center' }}>
                  <Ionicons name="sparkles-outline" size={22} color={theme.colors.textSecondary} />
                </View>
              ),
            },
            {
              id: 'sidebar',
              title: t('settingsVoice.ui.surfaceLocation.sidebarTitle'),
              subtitle: t('settingsVoice.ui.surfaceLocation.sidebarSubtitle'),
              icon: (
                <View style={{ width: 32, height: 32, alignItems: 'center', justifyContent: 'center' }}>
                  <Ionicons name="albums-outline" size={22} color={theme.colors.textSecondary} />
                </View>
              ),
            },
            {
              id: 'session',
              title: t('settingsVoice.ui.surfaceLocation.sessionTitle'),
              subtitle: t('settingsVoice.ui.surfaceLocation.sessionSubtitle'),
              icon: (
                <View style={{ width: 32, height: 32, alignItems: 'center', justifyContent: 'center' }}>
                  <Ionicons name="chatbubble-ellipses-outline" size={22} color={theme.colors.textSecondary} />
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
          trigger={({ open, toggle }) => (
            <Item
              title={t('settingsVoice.ui.updates.activeSessionTitle')}
              subtitle={t('settingsVoice.ui.updates.activeSessionSubtitle')}
              detail={(() => {
                if (updates.activeSession === 'none') return t('settingsVoice.ui.updates.level.noneTitle');
                if (updates.activeSession === 'activity') return t('settingsVoice.ui.updates.level.activityTitle');
                if (updates.activeSession === 'snippets') return t('settingsVoice.ui.updates.level.snippetsTitle');
                return t('settingsVoice.ui.updates.level.summariesTitle');
              })()}
              rightElement={<Ionicons name={open ? 'chevron-up' : 'chevron-down'} size={20} color={theme.colors.textSecondary} />}
              onPress={toggle}
              showChevron={false}
              selected={false}
            />
          )}
          items={[
            {
              id: 'none',
              title: t('settingsVoice.ui.updates.level.noneTitle'),
              subtitle: t('settingsVoice.ui.updates.level.noneSubtitle'),
              icon: (
                <View style={{ width: 32, height: 32, alignItems: 'center', justifyContent: 'center' }}>
                  <Ionicons name="remove-outline" size={22} color={theme.colors.textSecondary} />
                </View>
              ),
            },
            {
              id: 'activity',
              title: t('settingsVoice.ui.updates.level.activityTitle'),
              subtitle: t('settingsVoice.ui.updates.level.activitySubtitle'),
              icon: (
                <View style={{ width: 32, height: 32, alignItems: 'center', justifyContent: 'center' }}>
                  <Ionicons name="flash-outline" size={22} color={theme.colors.textSecondary} />
                </View>
              ),
            },
            {
              id: 'summaries',
              title: t('settingsVoice.ui.updates.level.summariesTitle'),
              subtitle: t('settingsVoice.ui.updates.level.summariesSubtitle'),
              icon: (
                <View style={{ width: 32, height: 32, alignItems: 'center', justifyContent: 'center' }}>
                  <Ionicons name="document-outline" size={22} color={theme.colors.textSecondary} />
                </View>
              ),
            },
            {
              id: 'snippets',
              title: t('settingsVoice.ui.updates.level.snippetsTitle'),
              subtitle: t('settingsVoice.ui.updates.level.snippetsSubtitle'),
              icon: (
                <View style={{ width: 32, height: 32, alignItems: 'center', justifyContent: 'center' }}>
                  <Ionicons name="code-outline" size={22} color={theme.colors.textSecondary} />
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
          trigger={({ open, toggle }) => (
            <Item
              title={t('settingsVoice.ui.updates.otherSessionsTitle')}
              subtitle={t('settingsVoice.ui.updates.otherSessionsSubtitle')}
              detail={(() => {
                if (updates.otherSessions === 'none') return t('settingsVoice.ui.updates.level.noneTitle');
                if (updates.otherSessions === 'activity') return t('settingsVoice.ui.updates.level.activityTitle');
                if (updates.otherSessions === 'snippets') return t('settingsVoice.ui.updates.level.snippetsTitle');
                return t('settingsVoice.ui.updates.level.summariesTitle');
              })()}
              rightElement={<Ionicons name={open ? 'chevron-up' : 'chevron-down'} size={20} color={theme.colors.textSecondary} />}
              onPress={toggle}
              showChevron={false}
              selected={false}
            />
          )}
          items={[
            {
              id: 'none',
              title: t('settingsVoice.ui.updates.level.noneTitle'),
              subtitle: t('settingsVoice.ui.updates.level.noneSubtitle'),
              icon: (
                <View style={{ width: 32, height: 32, alignItems: 'center', justifyContent: 'center' }}>
                  <Ionicons name="remove-outline" size={22} color={theme.colors.textSecondary} />
                </View>
              ),
            },
            {
              id: 'activity',
              title: t('settingsVoice.ui.updates.level.activityTitle'),
              subtitle: t('settingsVoice.ui.updates.level.activitySubtitle'),
              icon: (
                <View style={{ width: 32, height: 32, alignItems: 'center', justifyContent: 'center' }}>
                  <Ionicons name="flash-outline" size={22} color={theme.colors.textSecondary} />
                </View>
              ),
            },
            {
              id: 'summaries',
              title: t('settingsVoice.ui.updates.level.summariesTitle'),
              subtitle: t('settingsVoice.ui.updates.level.summariesSubtitle'),
              icon: (
                <View style={{ width: 32, height: 32, alignItems: 'center', justifyContent: 'center' }}>
                  <Ionicons name="document-outline" size={22} color={theme.colors.textSecondary} />
                </View>
              ),
            },
            {
              id: 'snippets',
              title: t('settingsVoice.ui.updates.level.snippetsTitle'),
              subtitle: t('settingsVoice.ui.updates.level.snippetsSubtitle'),
              icon: (
                <View style={{ width: 32, height: 32, alignItems: 'center', justifyContent: 'center' }}>
                  <Ionicons name="code-outline" size={22} color={theme.colors.textSecondary} />
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
              trigger={({ open, toggle }) => (
                <Item
                  title={t('settingsVoice.ui.updates.snippetsMaxMessagesTitle')}
                  subtitle={t('settingsVoice.ui.updates.snippetsMaxMessagesSubtitle')}
                  detail={String(updates.snippetsMaxMessages)}
                  rightElement={<Ionicons name={open ? 'chevron-up' : 'chevron-down'} size={20} color={theme.colors.textSecondary} />}
                  onPress={toggle}
                  showChevron={false}
                  selected={false}
                />
              )}
              items={Array.from({ length: 10 }, (_, idx) => {
                const n = idx + 1;
                return {
                  id: String(n),
                  title: String(n),
                  subtitle: undefined,
                  icon: (
                    <View style={{ width: 32, height: 32, alignItems: 'center', justifyContent: 'center' }}>
                      <Ionicons name="list-outline" size={22} color={theme.colors.textSecondary} />
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
              rightElement={
                <Switch
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
              trigger={({ open, toggle }) => (
                <Item
                  title={t('settingsVoice.ui.updates.otherSessionsSnippetsModeTitle')}
                  subtitle={t('settingsVoice.ui.updates.otherSessionsSnippetsModeSubtitle')}
                  detail={(() => {
                    if (updates.otherSessionsSnippetsMode === 'never') return t('settingsVoice.ui.updates.otherSessionsSnippetsMode.neverTitle');
                    if (updates.otherSessionsSnippetsMode === 'auto') return t('settingsVoice.ui.updates.otherSessionsSnippetsMode.autoTitle');
                    return t('settingsVoice.ui.updates.otherSessionsSnippetsMode.onDemandTitle');
                  })()}
                  rightElement={<Ionicons name={open ? 'chevron-up' : 'chevron-down'} size={20} color={theme.colors.textSecondary} />}
                  onPress={toggle}
                  showChevron={false}
                  selected={false}
                />
              )}
              items={[
                {
                  id: 'never',
                  title: t('settingsVoice.ui.updates.otherSessionsSnippetsMode.neverTitle'),
                  subtitle: t('settingsVoice.ui.updates.otherSessionsSnippetsMode.neverSubtitle'),
                  icon: (
                    <View style={{ width: 32, height: 32, alignItems: 'center', justifyContent: 'center' }}>
                      <Ionicons name="remove-outline" size={22} color={theme.colors.textSecondary} />
                    </View>
                  ),
                },
                {
                  id: 'on_demand_only',
                  title: t('settingsVoice.ui.updates.otherSessionsSnippetsMode.onDemandTitle'),
                  subtitle: t('settingsVoice.ui.updates.otherSessionsSnippetsMode.onDemandSubtitle'),
                  icon: (
                    <View style={{ width: 32, height: 32, alignItems: 'center', justifyContent: 'center' }}>
                      <Ionicons name="hand-left-outline" size={22} color={theme.colors.textSecondary} />
                    </View>
                  ),
                },
                {
                  id: 'auto',
                  title: t('settingsVoice.ui.updates.otherSessionsSnippetsMode.autoTitle'),
                  subtitle: t('settingsVoice.ui.updates.otherSessionsSnippetsMode.autoSubtitle'),
                  icon: (
                    <View style={{ width: 32, height: 32, alignItems: 'center', justifyContent: 'center' }}>
                      <Ionicons name="sparkles-outline" size={22} color={theme.colors.textSecondary} />
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
