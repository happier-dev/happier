import * as React from 'react';
import { createStore } from 'zustand/vanilla';
import { useStore } from 'zustand';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { SkillInstallPreviewV1 } from '@happier-dev/protocol/prompts/library/skills/skillActionSchemasV1';

import { useAddDialogEdge, type CapabilityAddInputContext } from '@/components/capabilities/add/CapabilityAddModal';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import type { MountedAuthoringActionExecute } from '@/sync/ops/actions/sessionAuthoringActions';
import { describeRegistrySourceStatus } from '@/registries/describeRegistrySourceStatus';
import { t } from '@/text';

import { previewRef, previewSource, previewSourceFacts } from './SkillPreviewRows';
import { previewSkillInstall, type SkillInstallSource } from './skillInstall';
import { SkillFoundAdd, createSkillFoundDraft } from './SkillFoundAdd';

type LinkPreview =
  | Readonly<{ kind: 'idle' }>
  | Readonly<{ kind: 'finding' }>
  | Readonly<{ kind: 'found'; url: string; source: SkillInstallSource; items: readonly SkillInstallPreviewV1[];
      draft: ReturnType<typeof createSkillFoundDraft> }>
  /** `source`: the link is fine, its source refused (a rate limit, a Machine it needs): not the field's fault. */
  | Readonly<{ kind: 'error'; message: string; source?: 'waits' | 'failed' }>;

export function createSkillLinkDraft() {
  return createStore<{ url: string; state: LinkPreview }>(() => ({ url: '', state: { kind: 'idle' } }));
}

const normalizeLink = (url: string) => url.trim().replace(/^npx\s+skills\s+add\s+/, '');

/** The input and its retained receipt describe the same reviewed source, not newly typed link text. */
export function skillLinkMatchesPreview(draft: Readonly<{ url: string; state: LinkPreview }>): boolean {
  return draft.state.kind === 'found' && normalizeLink(draft.url) === draft.state.url;
}

/**
 * From a link (lab sa L): paste a repository or folder in the tools band, look (`skills.install` dry run, nothing
 * written), then the skills found as a checklist in the dialog's list + details: tick several and add them in one
 * call, or open one to see what it installs and choose where it's on.
 */
export function SkillLinkInput(
  props: Readonly<{
    ctx: CapabilityAddInputContext;
    execute: MountedAuthoringActionExecute;
    onAdded: (skillId: string) => void | Promise<void>;
    /** A detail's Add closed the dialog: the page selects that skill. */
    onSelectAdded: (skillId: string) => void | Promise<void>;
    /** Closes the dialog (the footer's Done when everything found is already held). */
    onDone: () => void;
    testID: string;
    draft?: ReturnType<typeof createSkillLinkDraft>;
  }>,
) {
  const { theme } = useUnistyles();
  const edge = useAddDialogEdge();
  const [localDraft] = React.useState(createSkillLinkDraft);
  const draft = props.draft ?? localDraft;
  const { url, state } = useStore(draft);
  const setState = React.useCallback((state: LinkPreview) => draft.setState({ state }), [draft]);

  const find = React.useCallback(async () => {
    const link = normalizeLink(url);
    if (!/^https:\/\/\S+$/.test(link)) {
      setState({ kind: 'error', message: t('capabilities.skillAdd.link.invalid') });
      return;
    }
    props.ctx.openDetail(null);
    const finding = { kind: 'finding' } as const;
    setState(finding);
    const preview = await previewSkillInstall(props.execute, { kind: 'link', url: link });
    if (draft.getState().state !== finding) return;
    if (normalizeLink(draft.getState().url) !== link) {
      setState({ kind: 'idle' });
      return;
    }
    if (!preview.ok) {
      setState({
        kind: 'error',
        message: preview.status ? describeRegistrySourceStatus(preview.status) : t('capabilities.skillAdd.link.failed'),
        // An unreadable link is the field's to fix; any other state is the source's, said in its tone (as Browse does).
        ...(preview.status && preview.status.state !== 'invalid_source' ? { source: preview.status.state === 'rate_limited'
          || preview.status.state === 'needs_machine' ? 'waits' as const : 'failed' as const } : {}),
      });
      return;
    }
    setState({ kind: 'found', url: link, source: preview.source, items: preview.items, draft: createSkillFoundDraft(preview.items) });
    // One skill is the details themselves, as an upload's is: Where it's on, then its one Add.
    if (preview.items.length === 1) props.ctx.openDetail(preview.items[0]!.path);
  }, [draft, props.ctx, props.execute, setState, url]);

  const found = state.kind === 'found' ? state : null;
  const pin = found?.items[0] ? previewRef(found.items[0]) : undefined;
  const field = (
    <View style={styles.fieldRow}>
      <View style={styles.field}>
        <FieldTextInput
          testID={`${props.testID}.url`}
          value={url}
          onChangeText={(next) => {
            draft.setState({ url: next });
            if (state.kind === 'error') setState({ kind: 'idle' });
          }}
          placeholder={t('capabilities.skillAdd.link.placeholder')}
          accessibilityLabel={t('capabilities.skillAdd.link.title')}
          autoCapitalize="none"
          autoFocus
          monospace
          inputMode="url"
          returnKeyType="go"
          onSubmitEditing={() => void find()}
          error={state.kind === 'error' && state.source === undefined ? state.message : null}
        />
        {/* A source's own refusal reads beside the kept link in its state tone, without marking the link invalid. */}
        {state.kind === 'error' && state.source !== undefined ? (
          <Text variant="meta" style={{ color: state.source === 'waits' ? theme.colors.state.warning.textForeground : theme.colors.status.error }}
            testID={`${props.testID}.sourceStatus`}
            accessibilityLiveRegion="polite">
            {state.message}
          </Text>
        ) : null}
      </View>
      <RoundButton
        size="normal"
        display="secondary"
        title={t('capabilities.skillAdd.link.find')}
        loading={state.kind === 'finding'}
        disabled={url.trim() === ''}
        onPress={() => void find()}
        testID={`${props.testID}.find`}
      />
    </View>
  );
  return (
    <SkillFoundAdd
      // A new find is a new set to choose from: its ticks, adds and details start over.
      key={found?.url ?? ''}
      ctx={props.ctx}
      draft={found?.draft}
      execute={props.execute}
      source={found && skillLinkMatchesPreview({ url, state }) ? found.source : null}
      items={found?.items ?? null}
      isCurrentInput={() => draft.getState().state === state && skillLinkMatchesPreview(draft.getState())}
      // One skill leaves nothing to choose: the heading says what the link holds (lab `k:upload`'s "One skill in this upload").
      groupTitle={found?.items.length === 1 ? t('capabilities.skillAdd.link.foundOne') : t('capabilities.skillAdd.link.chooseWhich')}
      field={field}
      empty={
        <View style={[styles.empty, edge]}>
          <Text variant="reading" style={{ color: theme.colors.text.secondary }} testID={`${props.testID}.body`}>
            {found ? t('capabilities.skillAdd.link.none') : t('capabilities.skillAdd.link.body')}
          </Text>
        </View>
      }
      factsSource={previewSource}
      factsExtra={previewSourceFacts}
      note={
        pin ? (
          <>
            <Icon name="push-pin" size={ICON_SIZE.xs} color={theme.colors.text.secondary} />
            <Text variant="meta" numberOfLines={1} style={styles.noteText}>
              {`${t('capabilities.skillAdd.pinnedTo', { ref: pin })}. ${t('capabilities.skillAdd.link.openOne')}`}
            </Text>
          </>
        ) : null
      }
      detailNote={
        pin ? (
          <>
            <Icon name="push-pin" size={ICON_SIZE.xs} color={theme.colors.text.secondary} />
            <Text variant="meta" numberOfLines={1} style={styles.noteText}>
              {t('capabilities.skillAdd.pinnedTo', { ref: pin })}
            </Text>
          </>
        ) : null
      }
      onAdded={props.onAdded}
      onSelectAdded={props.onSelectAdded}
      onDone={props.onDone}
      testID={props.testID}
    />
  );
}

const styles = StyleSheet.create((theme) => ({
  fieldRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: theme.space.s12,
  },
  field: { flex: 1, minWidth: 0 },
  empty: { paddingTop: theme.space.s16, paddingBottom: theme.space.s24 },
  noteText: { flexShrink: 1, color: theme.colors.text.secondary },
}));
