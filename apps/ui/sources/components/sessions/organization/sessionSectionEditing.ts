import { Modal } from '@/modal';
import { t } from '@/text';
import type { SessionSection } from '@/sync/domains/session/organization/sections';
import { resolveSessionSectionArchiveOutcome } from './sessionSectionArchiveOutcome';

/**
 * The person's answers for a section's definition writes, shared by the list's group menu and the
 * Settings organizer. Each caller writes the answer through the section Actions on its own Home.
 */

/** New (no current name) or rename. Null when the person cancels, clears the name or keeps it. */
export async function requestSessionSectionName(
  currentName: string | null,
): Promise<string | null> {
  const renaming = currentName !== null;
  const name = await Modal.prompt(
    renaming ? t('common.rename') : t('sessionsList.newSection'),
    undefined,
    {
      ...(renaming ? { defaultValue: currentName } : {}),
      placeholder: t('sessionsList.sectionNamePlaceholder'),
      confirmText: renaming ? t('common.rename') : t('common.create'),
    },
  );
  const trimmed = name?.trim();
  return trimmed && trimmed !== currentName ? trimmed : null;
}

/** Remove asks once (P5 F4): its sessions move to the parent section, or back to their projects. */
export async function confirmSessionSectionRemoval(
  title: string,
  section: SessionSection | undefined,
): Promise<boolean> {
  const parent = section?.legacyContext?.ancestors.at(-1);
  const parentName =
    parent?.display?.status === 'available' ? parent.display.value.name : null;
  return await Modal.confirm(
    t('sessionsList.removeSectionConfirmTitle', {
      name: title || t('common.unavailable'),
    }),
    parentName
      ? t('sessionsList.removeNestedSectionConfirmDescription', {
          parent: parentName,
        })
      : t('sessionsList.removeSectionConfirmDescription'),
    {
      confirmText: t('sessionsList.removeSectionConfirm'),
      cancelText: t('common.cancel'),
    },
  );
}

/** Archive all does not confirm (archive is reversible); it speaks only when some members stayed (P5 §7). */
export function presentSessionSectionArchiveOutcome(result: unknown): void {
  const outcome = resolveSessionSectionArchiveOutcome(result);
  if (!outcome) return;
  Modal.alert(
    t('sessionsList.sectionArchivePartialTitle'),
    outcome.total === null
      ? t('sessionsList.sectionArchiveUnknown')
      : outcome.recovery === 'stop_sessions'
        ? t('sessionsList.sectionArchiveNeedsStop', {
            archived: outcome.archived,
            total: outcome.total,
          })
        : t('sessionsList.sectionArchivePartial', {
            archived: outcome.archived,
            total: outcome.total,
          }),
  );
}
