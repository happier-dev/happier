import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';
import type { DeploymentReadControllerV1, DeploymentReadDemandV1 } from '@happier-dev/deployments';

import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { t } from '@/text';

import { deploymentAddressExpected, deploymentLiveAddressDemand, formatDeploymentLiveAddress, resolveDeploymentLiveAddress } from './deploymentLiveAddressFacts';
import { deploymentHealthFact } from './deploymentPresentation';
import { useDeploymentEnvironmentDomains, useDeploymentEnvironmentHealthRecord, useReceiptRead } from './useDeploymentReads';

/**
 * The build preview a person checks before Production (deploy auto-mode U9): its address and health, read from the
 * Environment's own owners (the live-address owner, the health aggregate and its word). Shown only when the
 * Environment is a preview; it decides nothing itself.
 */
export const DeploymentReviewPreview = React.memo(function DeploymentReviewPreview(props: Readonly<{
  controller: DeploymentReadControllerV1 | null;
  environmentId: string;
  demand: DeploymentReadDemandV1;
  onOpenAddress: (url: string) => void;
}>) {
  const { theme } = useUnistyles();
  const record = useDeploymentEnvironmentHealthRecord(props.controller, props.environmentId, props.demand);
  const detail = record.snapshot.value;
  const preview = detail?.environment.purpose === 'preview';
  const activeId = preview ? detail.runtimeTargetLink?.activeDeploymentId ?? null : null;
  const serving = useReceiptRead(props.controller, preview ? props.environmentId : null, activeId, props.demand);
  const value = serving.snapshot.value;
  const active = value?.content ? value : null;
  const needsDomains = deploymentLiveAddressDemand(active, preview);
  const domains = useDeploymentEnvironmentDomains(needsDomains ? props.controller : null,
    needsDomains ? props.environmentId : null, props.demand);
  if (!preview) return null;
  const address = active ? resolveDeploymentLiveAddress(active, domains.result.items, true) : null;
  const health = deploymentHealthFact(detail.healthAggregate);
  const toneColor = health.tone === 'danger' ? theme.colors.state.danger.textForeground
    : health.tone === 'attention' ? theme.colors.state.warning.textForeground : undefined;
  const url = address?.url ?? null;
  const noAddress = !url && active && needsDomains
    && (domains.result.status === 'empty' || domains.result.status === 'ready')
    && !deploymentAddressExpected(active, domains.result.items, true);
  const addressTitle = url ? formatDeploymentLiveAddress(url)
    : t(noAddress ? 'projects.sources.noAddress' : 'projects.deployments.review.previewNotLive');
  return (
    <ItemGroup testID="project-deployments.review.preview" title={t('projects.deployments.review.previewTitle')}
      description={t('projects.deployments.review.previewDescription')}>
      <Item
        testID="project-deployments.review.preview.address"
        icon={<Icon name="globe" size={ICON_SIZE.sm} color={theme.colors.text.secondary} />}
        title={addressTitle}
        subtitle={t('projects.deployments.review.previewAddressNote')}
        showChevron={false}
        {...(url ? { onPress: () => props.onOpenAddress(url) } : {})}
      />
      <Item
        testID="project-deployments.review.preview.health"
        icon={<Icon name="pulse" size={ICON_SIZE.sm} color={theme.colors.text.secondary} />}
        title={health.value}
        {...(toneColor ? { titleStyle: { color: toneColor } } : {})}
        subtitle={t('projects.deployments.review.previewHealthNote')}
        showChevron={false}
      />
    </ItemGroup>
  );
});
