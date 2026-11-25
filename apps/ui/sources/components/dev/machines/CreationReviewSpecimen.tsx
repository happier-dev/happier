import * as React from 'react';

import { showManagedCreationReview } from '@/components/settings/machines/managed/ManagedCreationReview';
import { Icon } from '@/components/ui/icons/Icon';
import { t } from '@/text';

/**
 * Dev-only: the managed Create review (lab `q/review`) opened through its real opener with a Preset's setup script,
 * the server it creates and the account sign-in line the Create's selection records. Nothing is created.
 */
export function CreationReviewSpecimen() {
  React.useEffect(() => {
    showManagedCreationReview({
      name: 'Build box',
      server: { title: 'Local VM', spec: '4 CPU · 8 GB · Ubuntu 24.04', mark: <Icon name="desktop" size={20} /> },
      preset: { name: 'Build box', revision: 3 },
      setup: { scripts: [{ body: 'corepack enable\npnpm install --frozen-lockfile' }] },
      scope: null,
      projection: null,
      onEditSetup: () => {},
      accountSignIn: t('machineSignIn.consequence'),
      confirmLabel: t('managedMachines.creationReview.confirm'),
      onConfirm: () => {},
    });
  }, []);
  return null;
}
