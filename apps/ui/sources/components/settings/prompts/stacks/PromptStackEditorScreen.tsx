import * as React from 'react';
import { View } from 'react-native';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';

import type { PromptArtifactRefV1 } from '@happier-dev/protocol/prompts/library/promptArtifactRefsV1';
import type { PromptStackIntentV1 } from '@happier-dev/protocol/prompts/library/promptStacksV1';

import { AccountMemoryDefaultsSection } from '@/components/settings/prompts/context/AccountMemoryDefaultsSection';
import { ContextMemorySection } from '@/components/settings/prompts/context/ContextMemorySection';
import { SettingsPageHeader } from '@/components/settings/shell/SettingsPageHeader';
import { Icon } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { SectionActionButton } from '@/components/ui/lists/SectionActionButton';
import { SurfaceFreshnessLine } from '@/components/ui/surfaces/SurfaceFreshnessLine';
import { Modal } from '@/modal';
import {
  useActiveServerAccountScope,
} from '@/sync/domains/state/storage';
import { randomUUID } from '@/platform/randomUUID';
import { useAiLaunchProfiles } from '@/sync/store/useAiLaunchProfiles';
import { usePromptLibraryCatalogValue } from '@/sync/store/usePromptLibraryCatalog';
import { t } from '@/text';

import { PromptStackDocumentMenu } from './PromptStackDocumentMenu';
import { PromptStackEntryRow } from './PromptStackEntryRow';
import {
  isMemoryStackEntry,
  promptStackEntryHref,
  promptStackEntryTitle,
  usePromptStackEntryPresentations,
} from './promptStackEntryPresentation';
import { usePromptStackEntries } from './usePromptStackEntries';

/**
 * The stack editor of one layer of Context. `coding` is Settings → Context (lab `c-ctx` A/D; plan 65
 * §2 flow 1): the Account's memory defaults, your memory with its load budget, the documents added
 * to every session, then the Voice and launch-profile stacks as destinations. `voice` and `profile`
 * are those destinations: the same document rows on their own page. Every edit is the layer's one
 * stack writer (`usePromptStackEntries`).
 */
export const PromptStackEditorScreen = React.memo(
  (
    props: Readonly<{
      surface: 'coding' | 'voice' | 'profile';
      profileId?: string | null;
      title: string;
    }>,
  ) => {
    const router = useRouter();
    const scope = useActiveServerAccountScope();
    const stack = usePromptStackEntries(props.surface, props.profileId);
    const entries = stack.entries;
    const account = props.surface === 'coding';

    const presentations = usePromptStackEntryPresentations(entries, scope?.serverId ?? '');
    // Your memory is its own section on the Account page; it is never listed again as a document.
    const memoryEntry = React.useMemo(
      () =>
        account
          ? (entries.find((entry) =>
              isMemoryStackEntry(entry, presentations),
            ) ?? null)
          : null,
      [account, presentations, entries],
    );
    const documents = React.useMemo(
      () =>
        memoryEntry
          ? entries.filter((entry) => entry.id !== memoryEntry.id)
          : entries,
      [entries, memoryEntry],
    );

    // A change that did not save says so on the page, above the list it left as it was, until the
    // next attempt. The cause is ours to word: a thrown message is an internal string, never copy.
    const [updateFailed, setUpdateFailed] = React.useState(false);
    const update = React.useCallback(
      (intent: PromptStackIntentV1) => {
        setUpdateFailed(false);
        void stack.update(intent).catch(() => setUpdateFailed(true));
      },
      [stack.update],
    );

    // "Add document" is the one document menu every Context layer opens (Work and Project too).
    const [adding, setAdding] = React.useState(false);
    const addAnchorRef = React.useRef<View>(null);
    const attachedRefs = React.useMemo(() => entries.map(entry => entry.ref), [entries]);
    const attach = React.useCallback(
      (ref: PromptArtifactRefV1) => {
        setAdding(false);
        update({
          kind: 'attach',
          entry: {
            id: randomUUID(),
            ref,
            enabled: true,
            placement: ref.kind === 'bundle' ? 'skill_instructions' : 'system_append',
          },
        });
      },
      [update],
    );

    const remove = React.useCallback(
      (entryId: string) => {
        Modal.alert(
          t('promptLibrary.removeFromStack'),
          t('promptLibrary.removeFromStackConfirm'),
          [
            { text: t('common.cancel'), style: 'cancel' },
            {
              text: t('common.remove'),
              style: 'destructive',
              onPress: () =>
                update({ kind: 'detach', entryId }),
            },
          ],
        );
      },
      [update],
    );

    const setMemoryBudget = React.useCallback(
      (maxChars: number | null) => {
        if (!memoryEntry) return;
        update({ kind: 'set_budget', entryId: memoryEntry.id, maxChars });
      },
      [memoryEntry, update],
    );

    const description = account
      ? t('contextPages.account.description')
      : props.surface === 'voice'
        ? t('promptLibrary.voiceStackSubtitle')
        : t('promptLibrary.surface.profileStackEditorDescription');

    return (
      <ItemList>
        <SettingsPageHeader title={props.title} description={description} />
        {updateFailed ? (
          <SurfaceFreshnessLine
            testID="promptStack.updateFailed"
            tone="warning"
            reason={t('promptLibrary.stackUpdateFailed')}
          />
        ) : null}
        {account ? <AccountMemoryDefaultsSection /> : null}
        {account && scope ? (
          <ContextMemorySection
            key={`${scope.serverId}:${scope.accountId}`}
            testID="context.accountMemory"
            title={t('contextPages.account.memoryTitle')}
            description={t('contextPages.account.memoryDescription')}
            serverId={scope.serverId}
            entry={memoryEntry}
            scopeTarget={{ scope: 'account' }}
            footer={`${t('memoryContext.memory.accessPrivate')} · ${t('memoryContext.memory.usedWithMemoryOn')}`}
            emptyText={t('contextPages.account.memoryEmpty')}
            onBudgetChange={setMemoryBudget}
            onEnabledChange={memoryEntry ? (enabled) => update({ kind: 'set_enabled', entryId: memoryEntry.id, enabled }) : undefined}
          />
        ) : null}
        <ItemGroup
          title={
            account
              ? t('contextPages.account.stackTitle')
              : t('promptLibrary.stackEntries')
          }
          description={
            account
              ? t('contextPages.stackDescription')
              : t('promptLibrary.surface.stackEntriesDescription')
          }
          action={
            <View ref={addAnchorRef} collapsable={false}>
              <SectionActionButton
                testID="promptStack.add"
                title={
                  account
                    ? t('contextPages.addDocument')
                    : t('promptLibrary.addToStack')
                }
                icon="plus"
                expanded={adding}
                disabled={!scope}
                onPress={() => setAdding(true)}
              />
              {adding && scope ? (
                <PromptStackDocumentMenu
                  testID="promptStack.addMenu"
                  anchorRef={addAnchorRef}
                  serverId={scope.serverId}
                  attachedRefs={attachedRefs}
                  onClose={() => setAdding(false)}
                  onPick={attach}
                />
              ) : null}
            </View>
          }
        >
          {documents.map((entry, index) => (
            <PromptStackEntryRow
              key={entry.id}
              testID={`promptStack.entry.${entry.id}`}
              entry={entry}
              title={promptStackEntryTitle(entry, presentations)}
              unavailable={presentations(entry).kind === 'unknown'}
              onOpen={presentations(entry).kind === 'unknown' ? undefined : () => {
                const href = promptStackEntryHref(entry, presentations(entry).kind, scope?.serverId ?? '');
                if (href) router.push(href as never);
              }}
              onMove={(delta) => {
                const sibling = documents[index + delta];
                if (!sibling) return;
                // Moves are among the listed documents; the memory entry keeps its place in the stack.
                update({ kind: 'reorder', entryId: entry.id, siblingId: sibling.id, position: delta < 0 ? 'before' : 'after' });
              }}
              canMoveUp={index > 0}
              canMoveDown={index < documents.length - 1}
              onRemove={() => remove(entry.id)}
              onEnabledChange={(enabled) =>
                update({ kind: 'set_enabled', entryId: entry.id, enabled })
              }
              onBudgetChange={(maxChars) => update({ kind: 'set_budget', entryId: entry.id, maxChars })}
            />
          ))}

          {documents.length === 0 ? (
            <Item
              testID="promptStack.empty"
              title={
                account
                  ? t('contextPages.account.stackEmpty')
                  : t('promptLibrary.stackEmptyTitle')
              }
              subtitle={
                account ? undefined : t('promptLibrary.stackEmptySubtitle')
              }
              mode="info"
              showChevron={false}
            />
          ) : null}
        </ItemGroup>
        {account ? <OtherSessionStacks /> : null}
      </ItemList>
    );
  },
);

PromptStackEditorScreen.displayName = 'PromptStackEditorScreen';

/** Settings → Context › Other sessions: the Voice and launch-profile stacks, each on its own page. */
const OtherSessionStacks = React.memo(function OtherSessionStacks() {
  const router = useRouter();
  const voice = usePromptLibraryCatalogValue('voice').value;
  const profiles = useAiLaunchProfiles();
  const voiceCount = voice?.entries.length ?? 0;
  const profileCount = profiles.filter(
    (profile) => (profile.promptStack?.length ?? 0) > 0,
  ).length;
  return (
    <ItemGroup title={t('contextPages.account.otherTitle')}>
      <Item
        testID="promptStacks.voice"
        icon={<Icon name="microphone" />}
        title={t('contextPages.account.voiceTitle')}
        subtitle={t('promptLibrary.voiceStackSubtitle')}
        detail={voiceCount > 0 ? String(voiceCount) : undefined}
        onPress={() => router.push('/settings/prompts/stacks/voice')}
      />
      <Item
        testID="promptStacks.profiles"
        icon={<Icon name="sliders-horizontal" />}
        title={t('contextPages.account.profilesTitle')}
        subtitle={t('promptLibrary.surface.profileStacksDescription')}
        detail={
          profileCount > 0
            ? t('contextPages.account.profileCount', { count: profileCount })
            : undefined
        }
        onPress={() => router.push('/settings/prompts/stacks/profiles')}
      />
    </ItemGroup>
  );
});
