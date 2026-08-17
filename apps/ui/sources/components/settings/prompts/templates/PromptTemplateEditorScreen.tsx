import * as React from 'react';
import { View, Switch } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useRouter } from 'expo-router';

import {
  PromptInvocationEntryV1Schema,
  normalizePromptInvocationTokenV1,
  listActionSpecs,
} from '@happier-dev/protocol';

import { SETTINGS_TEXT_INPUT_METRICS } from '@/components/ui/forms/settingsTextInputMetrics';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { useLayoutMaxWidthStyle } from '@/components/ui/layout/layout';
import { SettingsActionFooter } from '@/components/ui/settingsSurface/SettingsActionFooter';
import { Text, TextInput } from '@/components/ui/text/Text';
import { Modal } from '@/modal';
import { randomUUID } from '@/platform/randomUUID';
import { useArtifacts, useSettingMutable } from '@/sync/domains/state/storage';
import { t } from '@/text';
import { PromptDocSelectionGroup } from '@/components/settings/prompts/shared/PromptDocSelectionGroup';
import { usePromptEditorDraftField } from '@/components/settings/prompts/shared/usePromptEditorDraftField';
import { Icon } from '@/components/ui/icons/Icon';

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    backgroundColor: theme.colors.background.canvas,
  },
  content: {
    padding: 16,
    paddingBottom: 64,
    width: '100%',
    alignSelf: 'center',
  },
  input: {
    backgroundColor: theme.colors.input.background,
    color: theme.colors.input.text,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    ...SETTINGS_TEXT_INPUT_METRICS,
    marginBottom: 12,
  },
  fieldLabel: {
    color: theme.colors.text.secondary,
    fontSize: 14,
    marginBottom: 8,
  },
}));

const RESERVED_TOKENS: ReadonlySet<string> = new Set(['/clear', '/compact']);

function isActionTokenCollision(token: string): boolean {
  const normalized = normalizePromptInvocationTokenV1(token);
  for (const spec of listActionSpecs()) {
    if (spec.surfaces.ui !== true) continue;
    const tokens = spec.slash?.tokens ?? [];
    for (const t of tokens) {
      if (typeof t !== 'string') continue;
      if (!t.startsWith('/')) continue;
      if (normalizePromptInvocationTokenV1(t) === normalized) return true;
    }
  }
  return false;
}

export const PromptTemplateEditorScreen = React.memo((props: Readonly<{ invocationId: string | null }>) => {
  // Composed at render time: the module-scope stylesheet evaluates once, so a
  // baked-in `layout.maxWidth` would freeze the user's content-width preference.
  const contentMaxWidthStyle = useLayoutMaxWidthStyle();
  const contentStyle = React.useMemo(() => [styles.content, contentMaxWidthStyle], [contentMaxWidthStyle]);
  const { theme } = useUnistyles();
  const router = useRouter();
  const artifacts = useArtifacts();
  const [invocations, setInvocations] = useSettingMutable('promptInvocationsV1');

  const existingEntry = React.useMemo(() => {
    if (!props.invocationId) return null;
    return invocations.entries.find((e) => e.id === props.invocationId) ?? null;
  }, [invocations.entries, props.invocationId]);

  const promptDocs = React.useMemo(
    () => artifacts
      .filter((a) => a.header?.kind === 'prompt_doc.v2')
      .map((artifact) => ({
        id: artifact.id,
        title: typeof artifact.header?.title === 'string'
          ? artifact.header.title
          : artifact.title ?? t('promptLibrary.untitledPrompt'),
      })),
    [artifacts],
  );

  const {
    value: title,
    setValue: setTitle,
    setPristineValue: setPristineTitle,
    applyExternalValue: applyExternalTitle,
  } = usePromptEditorDraftField('');
  const {
    value: token,
    setValue: setToken,
    setPristineValue: setPristineToken,
    applyExternalValue: applyExternalToken,
  } = usePromptEditorDraftField('');
  const {
    value: targetArtifactId,
    setValue: setTargetArtifactId,
    setPristineValue: setPristineTargetArtifactId,
    applyExternalValue: applyExternalTargetArtifactId,
  } = usePromptEditorDraftField<string>('');
  const {
    value: behavior,
    setValue: setBehavior,
    setPristineValue: setPristineBehavior,
    applyExternalValue: applyExternalBehavior,
  } = usePromptEditorDraftField<'insert' | 'insert_on_send' | 'insert_and_send'>('insert');
  const {
    value: allowArgs,
    setValue: setAllowArgs,
    setPristineValue: setPristineAllowArgs,
    applyExternalValue: applyExternalAllowArgs,
  } = usePromptEditorDraftField<boolean>(false);
  const [saving, setSaving] = React.useState(false);
  const [targetMenuOpen, setTargetMenuOpen] = React.useState(false);
  const loadedInvocationIdRef = React.useRef<string | null>(null);

  React.useEffect(() => {
    if (!existingEntry) {
      loadedInvocationIdRef.current = null;
      setPristineTitle('');
      setPristineToken('');
      setPristineTargetArtifactId('');
      setPristineBehavior('insert');
      setPristineAllowArgs(false);
      return;
    }

    const preserveDirty = loadedInvocationIdRef.current === existingEntry.id;
    const applyOptions = { preserveDirty };
    applyExternalTitle(existingEntry.title, applyOptions);
    applyExternalToken(existingEntry.token, applyOptions);
    applyExternalTargetArtifactId(existingEntry.target.artifactId, applyOptions);
    applyExternalBehavior(existingEntry.behavior, applyOptions);
    applyExternalAllowArgs(existingEntry.allowArgs, applyOptions);
    loadedInvocationIdRef.current = existingEntry.id;
  }, [
    applyExternalAllowArgs,
    applyExternalBehavior,
    applyExternalTargetArtifactId,
    applyExternalTitle,
    applyExternalToken,
    existingEntry?.allowArgs,
    existingEntry?.behavior,
    existingEntry?.id,
    existingEntry?.target.artifactId,
    existingEntry?.title,
    existingEntry?.token,
    setPristineAllowArgs,
    setPristineBehavior,
    setPristineTargetArtifactId,
    setPristineTitle,
    setPristineToken,
  ]);

  const canSave = title.trim().length > 0 && token.trim().length > 0 && targetArtifactId.trim().length > 0 && !saving;

  const save = React.useCallback(async () => {
    if (!canSave) return;

    try {
      setSaving(true);

      const rawToken = token.trim().startsWith('/') ? token.trim() : `/${token.trim()}`;
      const normalized = normalizePromptInvocationTokenV1(rawToken);

      if (RESERVED_TOKENS.has(normalized)) {
        Modal.alert(t('common.error'), t('promptLibrary.templateTokenReserved'));
        return;
      }

      if (isActionTokenCollision(rawToken)) {
        Modal.alert(t('common.error'), t('promptLibrary.templateTokenConflictsWithAction'));
        return;
      }

      const other = invocations.entries.find((e) => e.id !== props.invocationId && normalizePromptInvocationTokenV1(e.token) === normalized);
      if (other) {
        Modal.alert(t('common.error'), t('promptLibrary.templateTokenDuplicate'));
        return;
      }

      const id = props.invocationId ?? randomUUID();
      const entry = PromptInvocationEntryV1Schema.parse({
        id,
        token: rawToken,
        title: title.trim(),
        target: { kind: 'doc', artifactId: targetArtifactId.trim() },
        behavior,
        allowArgs,
        availableIn: 'global',
      });

      const nextEntries = props.invocationId
        ? invocations.entries.map((e) => (e.id === props.invocationId ? entry : e))
        : [...invocations.entries, entry];

      setInvocations({ ...invocations, entries: nextEntries });
      router.back();
    } catch (err) {
      Modal.alert(t('common.error'), t('promptLibrary.saveError'));
    } finally {
      setSaving(false);
    }
  }, [allowArgs, behavior, canSave, invocations, props.invocationId, router, setInvocations, targetArtifactId, title, token]);

  const remove = React.useCallback(() => {
    if (!props.invocationId) return;

    Modal.alert(
      t('promptLibrary.deleteTemplate'),
      t('promptLibrary.deleteTemplateConfirm'),
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('common.delete'),
          style: 'destructive',
          onPress: () => {
            setInvocations({ ...invocations, entries: invocations.entries.filter((e) => e.id !== props.invocationId) });
            router.back();
          },
        },
      ],
    );
  }, [invocations, props.invocationId, router, setInvocations]);

  return (
    <View style={styles.container}>
      <ItemList containerStyle={contentStyle} keyboardShouldPersistTaps="handled">
        <ItemGroup title={t('promptLibrary.general')}>
          <View style={{ paddingHorizontal: 16, paddingTop: 12 }}>
            <Text style={styles.fieldLabel}>{t('promptLibrary.templateNameLabel')}</Text>
            <TextInput
              testID="promptTemplate.title"
              placeholder={t('promptLibrary.titlePlaceholder')}
              placeholderTextColor={theme.colors.input.placeholder}
              value={title}
              onChangeText={setTitle}
              style={styles.input}
            />

            <Text style={styles.fieldLabel}>{t('promptLibrary.templateTokenLabel')}</Text>
            <TextInput
              testID="promptTemplate.token"
              placeholder={t('promptLibrary.tokenPlaceholder')}
              placeholderTextColor={theme.colors.input.placeholder}
              value={token}
              onChangeText={setToken}
              style={styles.input}
              autoCapitalize="none"
              autoCorrect={false}
            />
          </View>
        </ItemGroup>

        <PromptDocSelectionGroup
          promptDocs={promptDocs}
          selectedArtifactId={targetArtifactId}
          onSelect={setTargetArtifactId}
          menuOpen={targetMenuOpen}
          onMenuOpenChange={setTargetMenuOpen}
        />

        <ItemGroup title={t('promptLibrary.templateBehavior')}>
          <Item
            testID="promptTemplate.behavior.insert"
            title={t('promptLibrary.templateBehaviorInsert')}
            selected={behavior === 'insert'}
            rightElement={behavior === 'insert' ? <Icon name="check" size={16} color={theme.colors.accent.blue} /> : undefined}
            onPress={() => setBehavior('insert')}
          />
          <Item
            testID="promptTemplate.behavior.insert_on_send"
            title={t('promptLibrary.templateBehaviorInsertOnSend')}
            selected={behavior === 'insert_on_send'}
            rightElement={behavior === 'insert_on_send' ? <Icon name="check" size={16} color={theme.colors.accent.blue} /> : undefined}
            onPress={() => setBehavior('insert_on_send')}
          />
          <Item
            testID="promptTemplate.behavior.insert_and_send"
            title={t('promptLibrary.templateBehaviorInsertAndSend')}
            selected={behavior === 'insert_and_send'}
            rightElement={behavior === 'insert_and_send' ? <Icon name="check" size={16} color={theme.colors.accent.blue} /> : undefined}
            onPress={() => setBehavior('insert_and_send')}
          />
          <Item
            testID="promptTemplate.allowArgs"
            title={t('promptLibrary.templateAllowArgs')}
            subtitle={t('promptLibrary.templateAllowArgsSubtitle')}
            rightElement={<Switch value={allowArgs} onValueChange={setAllowArgs} />}
            showChevron={false}
          />
        </ItemGroup>

        {props.invocationId ? (
          <ItemGroup title={t('common.actions')}>
            <Item
              testID="promptTemplate.delete"
              title={t('common.delete')}
              destructive
              icon={<Icon name="trash" size={20} color={theme.colors.state.danger.foreground} />}
              onPress={remove}
            />
          </ItemGroup>
        ) : null}

        <SettingsActionFooter
          primaryLabel={t('common.save')}
          onPrimaryPress={() => { void save(); }}
          primaryDisabled={!canSave}
          primaryTestID="promptTemplate.save"
          secondaryLabel={t('common.cancel')}
          onSecondaryPress={() => router.back()}
          secondaryTestID="promptTemplate.cancel"
        />
      </ItemList>
    </View>
  );
});

PromptTemplateEditorScreen.displayName = 'PromptTemplateEditorScreen';
