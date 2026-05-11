import * as React from 'react';
import { ScrollView, View, Switch } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';

import type { PromptStackEntryV1, PromptStacksV1 } from '@happier-dev/protocol';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemRowActions } from '@/components/ui/lists/ItemRowActions';
import { layout } from '@/components/ui/layout/layout';
import { Modal } from '@/modal';
import { useArtifacts, useSettingMutable } from '@/sync/domains/state/storage';
import { t } from '@/text';

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    backgroundColor: theme.colors.background.canvas,
  },
  rightControls: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
}));

function moveEntry(entries: PromptStackEntryV1[], id: string, delta: number): PromptStackEntryV1[] {
  const idx = entries.findIndex((e) => e.id === id);
  if (idx < 0) return entries;
  const nextIndex = idx + delta;
  if (nextIndex < 0 || nextIndex >= entries.length) return entries;
  const next = entries.slice();
  const [item] = next.splice(idx, 1);
  if (!item) return entries;
  next.splice(nextIndex, 0, item);
  return next;
}

function updateStacksForSurface(args: Readonly<{
  stacks: PromptStacksV1;
  surface: 'coding' | 'voice' | 'profile';
  profileId?: string | null;
  nextEntries: PromptStackEntryV1[];
}>): PromptStacksV1 {
  if (args.surface === 'coding') {
    return { ...args.stacks, surfaces: { ...args.stacks.surfaces, coding: args.nextEntries } };
  }
  if (args.surface === 'voice') {
    return { ...args.stacks, surfaces: { ...args.stacks.surfaces, voice: args.nextEntries } };
  }
  const profileId = typeof args.profileId === 'string' ? args.profileId.trim() : '';
  const profilesById = { ...(args.stacks.surfaces.profilesById ?? {}) };
  profilesById[profileId] = args.nextEntries;
  return { ...args.stacks, surfaces: { ...args.stacks.surfaces, profilesById } };
}

function readStackEntries(args: Readonly<{ stacks: PromptStacksV1; surface: 'coding' | 'voice' | 'profile'; profileId?: string | null }>): PromptStackEntryV1[] {
  if (args.surface === 'coding') return args.stacks.surfaces.coding ?? [];
  if (args.surface === 'voice') return args.stacks.surfaces.voice ?? [];
  const profileId = typeof args.profileId === 'string' ? args.profileId.trim() : '';
  return (args.stacks.surfaces.profilesById ?? {})[profileId] ?? [];
}

export const PromptStackEditorScreen = React.memo((props: Readonly<{
  surface: 'coding' | 'voice' | 'profile';
  profileId?: string | null;
  title: string;
}>) => {
  const { theme } = useUnistyles();
  const router = useRouter();
  const artifacts = useArtifacts();
  const [promptStacksV1, setPromptStacksV1] = useSettingMutable('promptStacksV1');

  const entries = React.useMemo(
    () => readStackEntries({ stacks: promptStacksV1, surface: props.surface, profileId: props.profileId }),
    [promptStacksV1, props.profileId, props.surface],
  );

  const titleByArtifactId = React.useMemo(() => {
    const map = new Map<string, string>();
    for (const artifact of artifacts) {
      const title = typeof artifact.header?.title === 'string' ? artifact.header.title : artifact.title;
      if (title) map.set(artifact.id, title);
    }
    return map;
  }, [artifacts]);

  const setEntries = React.useCallback((nextEntries: PromptStackEntryV1[]) => {
    setPromptStacksV1(updateStacksForSurface({
      stacks: promptStacksV1,
      surface: props.surface,
      profileId: props.profileId,
      nextEntries,
    }));
  }, [promptStacksV1, props.profileId, props.surface, setPromptStacksV1]);

  const openArtifactEditor = React.useCallback((entry: PromptStackEntryV1) => {
    router.push(entry.ref.kind === 'bundle'
      ? `/settings/prompts/skills/${entry.ref.artifactId}`
      : `/settings/prompts/docs/${entry.ref.artifactId}`);
  }, [router]);

  const onAdd = React.useCallback(() => {
    const params: string[] = [`surface=${encodeURIComponent(props.surface)}`];
    if (props.surface === 'profile' && typeof props.profileId === 'string' && props.profileId.trim().length > 0) {
      params.push(`profileId=${encodeURIComponent(props.profileId)}`);
    }
    const query = params.length > 0 ? `?${params.join('&')}` : '';
    router.push(`/settings/prompts/stacks/pick${query}`);
  }, [props.profileId, props.surface, router]);

  const remove = React.useCallback((entryId: string) => {
    Modal.alert(
      t('promptLibrary.removeFromStack'),
      t('promptLibrary.removeFromStackConfirm'),
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('common.remove'),
          style: 'destructive',
          onPress: () => setEntries(entries.filter((e) => e.id !== entryId)),
        },
      ],
    );
  }, [entries, setEntries]);

  return (
    <View style={styles.container}>
      <ScrollView contentContainerStyle={{ paddingVertical: 12, maxWidth: layout.maxWidth, width: '100%', alignSelf: 'center' }}>
        <ItemGroup title={t('promptLibrary.stackEntries')}>
          {entries.map((entry, index) => {
            const title = titleByArtifactId.get(entry.ref.artifactId) ?? t('promptLibrary.untitledPrompt');
            const subtitle = entry.placement === 'skill_instructions'
              ? t('promptLibrary.stackPlacementSkill')
              : (entry.placement === 'composer_insert' ? t('promptLibrary.stackPlacementComposer') : t('promptLibrary.stackPlacementSystem'));

            return (
              <Item
                key={entry.id}
                testID={`promptStack.entry.${entry.id}`}
                title={title}
                subtitle={subtitle}
                icon={<Ionicons name={entry.ref.kind === 'bundle' ? 'sparkles-outline' : 'document-text-outline'} size={22} color={theme.colors.text.secondary} />}
                onPress={() => openArtifactEditor(entry)}
                rightElement={(
                  <View style={styles.rightControls}>
                    <ItemRowActions
                      title={title}
                      compactActionIds={['edit', 'delete']}
                      actions={[
                        {
                          id: 'edit',
                          title: t('common.edit'),
                          icon: 'pencil-outline',
                          onPress: () => openArtifactEditor(entry),
                        },
                        {
                          id: 'moveUp',
                          title: t('common.moveUp'),
                          icon: 'chevron-up',
                          disabled: index === 0,
                          onPress: () => setEntries(moveEntry(entries, entry.id, -1)),
                        },
                        {
                          id: 'moveDown',
                          title: t('common.moveDown'),
                          icon: 'chevron-down',
                          disabled: index === entries.length - 1,
                          onPress: () => setEntries(moveEntry(entries, entry.id, 1)),
                        },
                        {
                          id: 'delete',
                          title: t('common.delete'),
                          icon: 'trash-outline',
                          destructive: true,
                          onPress: () => remove(entry.id),
                        },
                      ]}
                    />
                    <Switch
                      value={entry.enabled}
                      onValueChange={(enabled) => setEntries(entries.map((e) => (e.id === entry.id ? { ...e, enabled } : e)))}
                    />
                  </View>
                )}
                showChevron={false}
              />
            );
          })}

          {entries.length === 0 ? (
            <Item
              testID="promptStack.empty"
              title={t('promptLibrary.stackEmptyTitle')}
              subtitle={t('promptLibrary.stackEmptySubtitle')}
              icon={<Ionicons name="information-circle-outline" size={22} color={theme.colors.text.secondary} />}
              showChevron={false}
            />
          ) : null}
        </ItemGroup>

        <ItemGroup>
          <Item
            testID="promptStack.add"
            title={t('promptLibrary.addToStack')}
            subtitle={t('promptLibrary.addToStackSubtitle')}
            icon={<Ionicons name="add-circle-outline" size={22} color={theme.colors.accent.blue} />}
            onPress={onAdd}
          />
        </ItemGroup>
      </ScrollView>
    </View>
  );
});

PromptStackEditorScreen.displayName = 'PromptStackEditorScreen';
