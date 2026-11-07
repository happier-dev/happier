import * as React from 'react';
import { resolveAnchoredListMoveV1 } from '@happier-dev/protocol/actions/anchoredListOrderV1';
import type { EntityDragScopeV1 } from '@happier-dev/protocol/plugins/ui';

import {
  confirmSessionSectionRemoval,
  presentSessionSectionArchiveOutcome,
  requestSessionSectionName,
} from '@/components/sessions/organization/sessionSectionEditing';
import {
  entityReorderPreview,
  entityReorderRefused,
  useEntityReorderAction,
  type EntityFlatReorderBinding,
} from '@/components/ui/treeDragDrop/ui/EntityFlatReorder';
import { Modal } from '@/modal';
import { buildSessionOrganizationServerKey } from '@/sync/domains/session/organization/keys';
import {
  resolveSessionSectionDisplayTitle,
  type SessionSection,
} from '@/sync/domains/session/organization/sections';
import { useSessionSectionChoiceLabels } from '@/sync/domains/session/organization/useSessionSectionChoiceLabels';
import { buildSessionOrganizationListViewState } from '@/sync/domains/session/organization/viewState';
import {
  archiveSessionSection,
  writeSessionSectionDefinition,
} from '@/sync/ops/sessionOrganization/sessionOrganizationMutationOwner';
import { requireSessionOrganizationMutationScope } from '@/sync/ops/sessionOrganization/requireSessionOrganizationMutationScope';
import {
  useActiveServerAccountScope,
  useSessionOrganizationProjection,
} from '@/sync/store/hooks';
import { t } from '@/text';
import { HappyError } from '@/utils/errors/errors';

export type SessionSectionsOrganizerRow = Readonly<{
  sectionId: string;
  /** The chooser's label: plain, or with its legacy context where two sections share a name. */
  title: string;
  icon: string | null;
  locked: boolean;
  /** Complete membership only; omitted while unproven (unknown is not zero). */
  memberCount?: number;
}>;

const EMPTY_ROWS: readonly SessionSectionsOrganizerRow[] = Object.freeze([]);

/** The selected Home's Account sections in their order, as Settings names them. Read only. */
export function useSessionSectionRows() {
  const scope = useActiveServerAccountScope();
  const serverId = scope?.serverId ?? null;
  const projection = useSessionOrganizationProjection(serverId);
  const viewState = React.useMemo(
    () =>
      buildSessionOrganizationListViewState({
        serverId: serverId ?? '',
        projection,
      }),
    [projection, serverId],
  );
  const sections = viewState.sections;
  const labels = useSessionSectionChoiceLabels(
    sections,
    serverId ?? '',
    t('common.unavailable'),
  );
  const membershipComplete = serverId
    ? viewState.sectionMembershipCompleteByServerId[serverId] === true
    : false;
  const rows = React.useMemo(
    (): readonly SessionSectionsOrganizerRow[] =>
      !serverId
        ? EMPTY_ROWS
        : sections.map((section) => {
            const members =
              viewState.sectionMemberSessionKeysBySectionKey[
                buildSessionOrganizationServerKey(
                  serverId,
                  section.address.sectionId,
                )
              ];
            return {
              sectionId: section.address.sectionId,
              title:
                labels.get(section.address.sectionId) ??
                resolveSessionSectionDisplayTitle(section.display),
              icon:
                section.display.status === 'available'
                  ? section.display.value.icon
                  : null,
              locked: section.display.status !== 'available',
              ...(membershipComplete
                ? { memberCount: members?.length ?? 0 }
                : {}),
            };
          }),
    [
      labels,
      membershipComplete,
      sections,
      serverId,
      viewState.sectionMemberSessionKeysBySectionKey,
    ],
  );

  return { scope, serverId, sections, rows };
}

/**
 * Settings → Sessions → Sections: the rows above and every section Action a person can take on a
 * definition (create, rename, icon, reorder, archive all, remove). Each write is the same section
 * Action the list and agents use; this owns no section state of its own.
 */
export function useSessionSectionsOrganizer() {
  const { scope, serverId, sections, rows } = useSessionSectionRows();
  const latest = React.useRef({ serverId, rows, sections });
  latest.current = { serverId, rows, sections };
  const run = React.useCallback(
    async (mutation: (serverId: string) => Promise<void>) => {
      const current = latest.current.serverId;
      if (!current) return;
      try {
        await mutation(current);
      } catch (error) {
        Modal.alert(
          t('common.error'),
          error instanceof HappyError
            ? error.message
            : t('errors.unknownError'),
        );
      }
    },
    [],
  );
  const write = React.useCallback(
    async (
      serverIdForWrite: string,
      actionId: Parameters<typeof writeSessionSectionDefinition>[0]['actionId'],
      input: Readonly<Record<string, unknown>>,
    ) => {
      await writeSessionSectionDefinition({
        scope: await requireSessionOrganizationMutationScope(serverIdForWrite),
        actionId,
        input,
      });
    },
    [],
  );
  const create = React.useCallback(
    () =>
      run(async (home) => {
        const name = await requestSessionSectionName(null);
        if (name) await write(home, 'session.sections.create', { name });
      }),
    [run, write],
  );
  const rename = React.useCallback(
    (sectionId: string) =>
      run(async (home) => {
        const row = latest.current.rows.find(candidate => candidate.sectionId === sectionId);
        if (!row || row.locked) return;
        const name = await requestSessionSectionName(row.title);
        if (name)
          await write(home, 'session.sections.update', { sectionId, name });
      }),
    [run, write],
  );
  const changeIcon = React.useCallback(
    (sectionId: string, icon: string) =>
      run(async (home) => {
        await write(home, 'session.sections.update', { sectionId, icon });
      }),
    [run, write],
  );
  const remove = React.useCallback(
    (sectionId: string) =>
      run(async (home) => {
        const row = latest.current.rows.find(candidate => candidate.sectionId === sectionId);
        if (!row) return;
        const section: SessionSection | undefined =
          latest.current.sections.find(
            (candidate) => candidate.address.sectionId === sectionId,
          );
        if (!(await confirmSessionSectionRemoval(row.title, section))) return;
        await write(home, 'session.sections.delete', { sectionId });
      }),
    [run, write],
  );
  const archive = React.useCallback(
    (sectionId: string) =>
      run(async (home) => {
        presentSessionSectionArchiveOutcome(
          await archiveSessionSection({
            scope: await requireSessionOrganizationMutationScope(home),
            sectionId,
          }),
        );
      }),
    [run],
  );

  const dragScope = React.useMemo(
    (): EntityDragScopeV1 | null =>
      scope ? { serverId: scope.serverId, accountId: scope.accountId } : null,
    [scope?.accountId, scope?.serverId],
  );
  const executeReorder = useEntityReorderAction(dragScope);
  const reorder = React.useMemo((): EntityFlatReorderBinding => {
    const items = rows.map((row) => ({ id: row.sectionId, title: row.title }));
    const ids = items.map((item) => item.id);
    return {
      scope: dragScope,
      kind: 'session-folder',
      items,
      getItem: (id) =>
        dragScope && ids.includes(id)
          ? { kind: 'session-folder', scope: dragScope, folderId: id }
          : null,
      getSourceId: (item) =>
        item.kind === 'session-folder' ? item.folderId : null,
      resolve: (sectionId, position) => {
        const moved = resolveAnchoredListMoveV1(ids, sectionId, position);
        if (!moved || moved.every((id, index) => id === ids[index])) {
          return entityReorderRefused(
            ids.includes(sectionId) ? 'same-position' : 'reorder_target_gone',
          );
        }
        return {
          status: 'allowed',
          effect: {
            actionId: 'session.sections.reorder',
            input: {
              sectionId,
              beforeSectionId: moved[moved.indexOf(sectionId) + 1] ?? null,
            },
            preview: entityReorderPreview(position, items),
          },
        };
      },
      execute: executeReorder,
    };
  }, [dragScope, executeReorder, rows]);

  return {
    serverId,
    sections: rows,
    reorder,
    create,
    rename,
    changeIcon,
    remove,
    archive,
  };
}
