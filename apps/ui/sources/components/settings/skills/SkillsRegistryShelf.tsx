import * as React from 'react';
import { RegistryShelf, RegistryShelfAddControl, registryShelfCardKey, registryShelfProjection } from '@/components/capabilities/add/RegistryShelf';
import type { RegistryItemSummaryV1 } from '@happier-dev/protocol/registries';
import { findHeldSkillV1, type SkillListItemV1 } from '@happier-dev/protocol/prompts/library/skills/skillLibraryItemV1';

import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { useRegistrySources } from '@/registries/useRegistrySources';
import type { SkillsLibrary } from '@/sync/domains/skills/useSkillsLibrary';
import { installSkills, retrySkillInstall, describeSkillInstallIncomplete, type SkillInstallAcknowledgment } from './add/skillInstall';
import { useOpenSkillAddModal } from './add/useOpenSkillAddModal';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { skillHref } from './skillsCollectionModel';
import { runGuardedNavigation } from '@/utils/navigation/runGuardedNavigation';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { t } from '@/text';

const SHELF_SIZE = 3;

type ShelfCard = RegistryItemSummaryV1;
type AddState = Readonly<{ status: 'adding' | 'added' | 'failed' | 'partial'; outcome?: SkillInstallAcknowledgment }>;

const cardKey = registryShelfCardKey;

function repositoryLabel(url: string | undefined): string | null {
  if (!url) return null;
  const match = /github\.com[/:]([^/]+\/[^/#?]+)/.exec(url);
  return match ? match[1]!.replace(/\.git$/, '') : null;
}

function inLibrary(
  items: readonly SkillListItemV1[],
  card: ShelfCard,
): boolean {
  return findHeldSkillV1(items, { registry: card }) !== null;
}

/**
 * "From your registries" (P6 §4.2, IR-79): P4's one suggestions rule (Happier picks of the kind, else the
 * first page of the first built-in source this host reads directly) as three cards with Add. No items, no
 * shelf: never an empty one.
 */
export const SkillsRegistryShelf = React.memo(function SkillsRegistryShelf(
  props: Readonly<{
    library: SkillsLibrary;
    shelf: Readonly<{
      items: readonly ShelfCard[];
      sourceId: string | null;
      loading: boolean;
    }>;
    brandNew: boolean;
  }>,
) {
  const { library, shelf } = props;
  const sources = useRegistrySources('skill');
  const { execute } = useMountedActionExecution(
    library.scope?.serverId ?? null,
  );
  const [adds, setAdds] = React.useState<ReadonlyMap<string, AddState>>(
    new Map(),
  );
  const cards = React.useMemo(
    () => shelf.items.slice(0, SHELF_SIZE),
    [shelf.items],
  );
  const sourceTitle =
    sources.sources.find((source) => source.id === shelf.sourceId)?.title ??
    null;
  const { retry } = library;
  // "Browse all" opens the same Add modal on Browse, on the registry these cards came from.
  const openAdd = useOpenSkillAddModal();
  const router = useRouter();
  const open = React.useCallback((card: ShelfCard) => {
    const held = findHeldSkillV1(library.items, { registry: card });
    if (!held) {
      openAdd({ modeKey: 'browse', sourceId: card.sourceId, query: card.title });
      return;
    }
    const result = runGuardedNavigation(() => router.push(skillHref(held.skillId) as never));
    if (result !== true) fireAndForget(result, { tag: 'SkillsRegistryShelf.open' });
  }, [library.items, openAdd, router]);

  const add = React.useCallback(
    async (card: ShelfCard) => {
      const key = cardKey(card);
      const previous = adds.get(key);
      if (previous?.status === 'adding') return;
      if (previous?.outcome) {
        setAdds((states) => new Map(states).set(key, { ...previous, status: 'adding' }));
        const outcome = await retrySkillInstall(execute, previous.outcome);
        setAdds((states) => new Map(states).set(key, { outcome, status: !outcome.ok || outcome.incomplete.length > 0 ? 'partial' : 'added' }));
        retry();
        return;
      }
      setAdds((previous) => new Map(previous).set(key, { status: 'adding' }));
      // The row's Add reads the item first and installs exactly that pinned version, with no Where (P6 §4.4).
      const read = await execute('registries.items.read', { kind: 'skill', sourceId: card.sourceId, itemId: card.itemId })
        .catch(() => null);
      const version = read?.ok ? (read.result as { item?: { summary?: { version?: string } } } | undefined)?.item?.summary?.version : undefined;
      const result = version
        ? await installSkills(execute, { source: { kind: 'registry', sourceId: card.sourceId, itemId: card.itemId, version } })
          .catch(() => null)
        : null;
      setAdds((previous) =>
        new Map(previous).set(key, result && (result.ok || result.skillIds.length > 0)
          ? { outcome: result, status: !result.ok || result.incomplete.length > 0 ? 'partial' : 'added' }
          : { status: 'failed' }),
      );
      if (result && result.skillIds.length > 0) retry();
    },
    [adds, execute, retry],
  );

  const where = React.useCallback(
    (card: ShelfCard) =>
      card.publisher?.name ??
      repositoryLabel(card.links?.repository) ??
      sourceTitle ??
      card.sourceId,
    [sourceTitle],
  );
  const action = React.useCallback(
    (card: ShelfCard) => {
      const state = adds.get(cardKey(card));
      if (state?.outcome && (!state.outcome.ok || state.outcome.incomplete.length > 0)) return (
        <SurfaceStateCard testID={`skills.home.shelf.${card.itemId}.partial`} kind="error" size="line"
          title={describeSkillInstallIncomplete(state.outcome)}
          action={{ label: t('capabilities.skillAdd.partial.tryAgain'), onPress: () => add(card), busy: state.status === 'adding' }} />
      );
      return (
        <RegistryShelfAddControl
          testID={`skills.home.shelf.${card.itemId}`}
          state={state?.status === 'added' || inLibrary(library.items, card) ? 'added'
            : state?.status === 'adding' ? 'adding' : state?.status === 'failed' ? 'failed' : 'available'}
          title={card.title}
          addLabel={t('capabilities.skillsUpdates.shelf.add')}
          addedLabel={t('capabilities.skillsUpdates.shelf.inLibrary')}
          failedLabel={t('capabilities.skillsUpdates.shelf.addFailed')}
          onAdd={() => void add(card)}
        />
      );
    },
    [add, adds, library.items],
  );

  return (
    <RegistryShelf
      projection={registryShelfProjection}
      testID="skills.home.shelf"
      title={
        props.brandNew
          ? t('capabilities.skillsUpdates.shelf.titleNew')
          : t('capabilities.skillsUpdates.shelf.title')
      }
      {...(sourceTitle
        ? {
            description: t('capabilities.skillsUpdates.shelf.fromSource', {
              source: sourceTitle,
            }),
          }
        : {})}
      items={cards}
      loading={shelf.loading}
      where={where}
      action={action}
      onOpen={open}
      columnTitle={t('capabilities.skills.title')}
      browseAll={{ label: t('capabilities.skillsUpdates.shelf.browseAll'), onPress: () => openAdd({ modeKey: 'browse', ...(shelf.sourceId ? { sourceId: shelf.sourceId } : {}) }) }}
    />
  );
});
