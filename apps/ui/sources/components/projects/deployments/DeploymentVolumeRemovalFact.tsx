import type { DeploymentPlatformProvenanceV1 } from '@happier-dev/protocol/deployments/deploymentReceiptContentV1';
import type { DeploymentRemovalReviewV1 } from '@happier-dev/protocol/deployments/deploymentReviewV1';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { t } from '@/text';
import { requestOpenExternalUrl } from '@/utils/url/requestOpenExternalUrl';

type VolumeRemovalFactProps = Readonly<{
  serverId: string | null;
  accountId?: string;
  testID: string;
}> & (
  | Readonly<{ phase: 'review'; volumeRemoval: DeploymentRemovalReviewV1['volumeRemoval'] }>
  | Readonly<{ phase: 'receipt'; volumeRemoval: DeploymentPlatformProvenanceV1['observation']['volumeRemoval'] }>
);

/** Present the provider's storage consequence before approval and its observed outcome on the receipt. */
export function DeploymentVolumeRemovalFact({ phase, volumeRemoval, serverId, accountId, testID }: VolumeRemovalFactProps) {
  if (!volumeRemoval) return null;
  const review = phase === 'review';
  let title: string;
  switch (volumeRemoval.kind) {
    case 'removed':
      title = review ? t('projects.deployments.review.railwayVolumeWillRemove')
        : volumeRemoval.volume ? t('projects.deployments.review.namedVolumeRemoved', volumeRemoval.volume)
          : t('projects.deployments.review.railwayVolumeRemoved');
      break;
    case 'kept':
      title = t(review ? 'projects.deployments.review.railwayVolumeWillKeep' : 'projects.deployments.review.railwayVolumeKept',
        { count: volumeRemoval.otherEnvironments });
      break;
    case 'unchecked':
      title = t('projects.deployments.review.railwayVolumeUnchecked');
      break;
    case 'kept-unchecked':
      title = t('projects.deployments.review.railwayVolumeKeptUnchecked');
      break;
  }
  const open = volumeRemoval.kind === 'kept' ? () => requestOpenExternalUrl(volumeRemoval.url, {
    serverId: serverId ?? undefined, expectedAccountId: accountId,
  }) : undefined;
  return <ItemGroup title={t('projects.deployments.factData')}>
    <Item title={title} titleLines={0} mode={open ? undefined : 'info'}
      testID={open ? `${testID}.open` : testID} onPress={open}
      subtitle={open ? t('projects.deployments.review.railwayVolumeOpen') : undefined} />
  </ItemGroup>;
}
