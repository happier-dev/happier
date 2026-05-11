import * as React from 'react';
import { ScrollView, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';

import type { PromptStackEntryV1, PromptStacksV1 } from '@happier-dev/protocol';

import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Item } from '@/components/ui/lists/Item';
import { ItemRowActions } from '@/components/ui/lists/ItemRowActions';
import { layout } from '@/components/ui/layout/layout';
import { Modal } from '@/modal';
import { randomUUID } from '@/platform/randomUUID';
import { useArtifacts, useSettingMutable } from '@/sync/domains/state/storage';
import { t } from '@/text';

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    backgroundColor: theme.colors.background.canvas,
  },
}));

function readStackEntries(args: Readonly<{ stacks: PromptStacksV1; surface: 'coding' | 'voice' | 'profile'; profileId?: string | null }>): PromptStackEntryV1[] {
  if (args.surface === 'coding') return args.stacks.surfaces.coding ?? [];
  if (args.surface === 'voice') return args.stacks.surfaces.voice ?? [];
  const profileId = typeof args.profileId === 'string' ? args.profileId.trim() : '';
  return (args.stacks.surfaces.profilesById ?? {})[profileId] ?? [];
}

function writeStackEntries(args: Readonly<{
  stacks: PromptStacksV1;
  surface: 'coding' | 'voice' | 'profile';
  profileId?: string | null;
  entries: PromptStackEntryV1[];
}>): PromptStacksV1 {
  if (args.surface === 'coding') return { ...args.stacks, surfaces: { ...args.stacks.surfaces, coding: args.entries } };
  if (args.surface === 'voice') return { ...args.stacks, surfaces: { ...args.stacks.surfaces, voice: args.entries } };
  const profileId = typeof args.profileId === 'string' ? args.profileId.trim() : '';
  const profilesById = { ...(args.stacks.surfaces.profilesById ?? {}) };
  profilesById[profileId] = args.entries;
  return { ...args.stacks, surfaces: { ...args.stacks.surfaces, profilesById } };
}

export const PromptStackPromptPickerScreen = React.memo((props: Readonly<{
  surface: 'coding' | 'voice' | 'profile';
  profileId?: string | null;
}>) => {
  const { theme } = useUnistyles();
  const router = useRouter();
  const artifacts = useArtifacts();
  const [promptStacksV1, setPromptStacksV1] = useSettingMutable('promptStacksV1');

  const promptDocs = React.useMemo(
    () => artifacts.filter((a) => a.header?.kind === 'prompt_doc.v2'),
    [artifacts],
  );
  const bundles = React.useMemo(
    () => artifacts.filter((a) => a.header?.kind === 'prompt_bundle.v2'),
    [artifacts],
  );

  const add = React.useCallback((ref: { kind: 'doc' | 'bundle'; artifactId: string }) => {
    const entries = readStackEntries({ stacks: promptStacksV1, surface: props.surface, profileId: props.profileId });
    if (entries.some((e) => e.ref.kind === ref.kind && e.ref.artifactId === ref.artifactId)) {
      Modal.alert(t('common.error'), t('promptLibrary.stackAlreadyContainsPrompt'));
      return;
    }

    const next: PromptStackEntryV1 = {
      id: randomUUID(),
      ref,
      enabled: true,
      placement: ref.kind === 'bundle' ? 'skill_instructions' : 'system_append',
      editPolicy: 'user_only',
    };

    const nextStacks = writeStackEntries({
      stacks: promptStacksV1,
      surface: props.surface,
      profileId: props.profileId,
      entries: [...entries, next],
    });

    setPromptStacksV1(nextStacks);
    router.back();
  }, [promptStacksV1, props.profileId, props.surface, router, setPromptStacksV1]);

  const openArtifactEditor = React.useCallback((ref: { kind: 'doc' | 'bundle'; artifactId: string }) => {
    router.push(ref.kind === 'bundle'
      ? `/settings/prompts/skills/${ref.artifactId}`
      : `/settings/prompts/docs/${ref.artifactId}`);
  }, [router]);

  return (
    <View style={styles.container}>
      <ScrollView
        contentContainerStyle={{
          paddingVertical: 12,
          maxWidth: layout.maxWidth,
          width: '100%',
          alignSelf: 'center',
        }}
      >
        <ItemGroup title={t('promptLibrary.prompts')}>
          {promptDocs.map((doc) => (
            <Item
              key={doc.id}
              testID={`promptStackPicker.doc.${doc.id}`}
              title={doc.header?.title ?? doc.title ?? t('promptLibrary.untitledPrompt')}
              icon={<Ionicons name="document-text-outline" size={22} color={theme.colors.text.secondary} />}
              onPress={() => add({ kind: 'doc', artifactId: doc.id })}
              rightElement={(
                <ItemRowActions
                  title={doc.header?.title ?? doc.title ?? t('promptLibrary.untitledPrompt')}
                  compactActionIds={['edit']}
                  actions={[
                    {
                      id: 'edit',
                      title: t('common.edit'),
                      icon: 'pencil-outline',
                      onPress: () => openArtifactEditor({ kind: 'doc', artifactId: doc.id }),
                    },
                  ]}
                />
              )}
            />
          ))}
          {promptDocs.length === 0 ? (
            <Item
              testID="promptStackPicker.emptyPrompts"
              title={t('promptLibrary.stackPickerNoPrompts')}
              icon={<Ionicons name="information-circle-outline" size={22} color={theme.colors.text.secondary} />}
              showChevron={false}
            />
          ) : null}
        </ItemGroup>

        <ItemGroup title={t('promptLibrary.skills')}>
          {bundles.map((bundle) => (
            <Item
              key={bundle.id}
              testID={`promptStackPicker.bundle.${bundle.id}`}
              title={bundle.header?.title ?? bundle.title ?? t('promptLibrary.untitledSkill')}
              icon={<Ionicons name="sparkles-outline" size={22} color={theme.colors.text.secondary} />}
              onPress={() => add({ kind: 'bundle', artifactId: bundle.id })}
              rightElement={(
                <ItemRowActions
                  title={bundle.header?.title ?? bundle.title ?? t('promptLibrary.untitledSkill')}
                  compactActionIds={['edit']}
                  actions={[
                    {
                      id: 'edit',
                      title: t('common.edit'),
                      icon: 'pencil-outline',
                      onPress: () => openArtifactEditor({ kind: 'bundle', artifactId: bundle.id }),
                    },
                  ]}
                />
              )}
            />
          ))}
          {bundles.length === 0 ? (
            <Item
              testID="promptStackPicker.emptySkills"
              title={t('promptLibrary.stackPickerNoSkills')}
              icon={<Ionicons name="information-circle-outline" size={22} color={theme.colors.text.secondary} />}
              showChevron={false}
            />
          ) : null}
        </ItemGroup>

        <ItemGroup>
          <Item
            testID="promptStackPicker.addPrompt"
            title={t('promptLibrary.addPrompt')}
            subtitle={t('promptLibrary.addPromptSubtitle')}
            icon={<Ionicons name="add-circle-outline" size={22} color={theme.colors.accent.blue} />}
            onPress={() => router.push('/settings/prompts/docs/new')}
          />
          <Item
            testID="promptStackPicker.addSkill"
            title={t('promptLibrary.addSkill')}
            subtitle={t('promptLibrary.addSkillSubtitle')}
            icon={<Ionicons name="add-circle-outline" size={22} color={theme.colors.accent.indigo} />}
            onPress={() => router.push('/settings/prompts/skills/new')}
          />
        </ItemGroup>
      </ScrollView>
    </View>
  );
});

PromptStackPromptPickerScreen.displayName = 'PromptStackPromptPickerScreen';
