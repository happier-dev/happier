import { Modal } from '@/modal';
import { t } from '@/text';

/**
 * The one confirmation before a dashboard is deleted, naming it, from the Project menu and the
 * Artifact page alike. The confirmed delete then runs as an already-confirmed Action.
 */
export function confirmDashboardDelete(name: string): Promise<boolean> {
  return Modal.confirm(
    t('projects.dashboard.deleteConfirmTitle', { name }),
    t('projects.dashboard.deleteConfirmBody'),
    {
      confirmText: t('common.delete'),
      destructive: true,
    },
  );
}
