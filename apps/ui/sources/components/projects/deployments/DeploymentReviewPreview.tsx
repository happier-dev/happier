import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';
import type { DeploymentReadControllerV1, DeploymentReadDemandV1 } from '@happier-dev/deployments';

import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { t } from '@/text';
import { requestOpenExternalUrl } from '@/utils/url/requestOpenExternalUrl';

import { formatDeploymentLiveAddress, resolveDeploymentLiveAddress } from './deploymentLiveAddressFacts';
import { deploymentHealthFact } from './deploymentPresentation';
import { useDeploymentEnvironmentDomains, useDeploymentEnvironmentHealthRecord, useDeploymentReceipt } from './useDeploymentReads';
import { useDeploymentPresentationDemand } from './useDeploymentPresentationDemand';
import { useDeploymentAccountController } from './useDeploymentProject';

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
  const serving = useDeploymentReceipt(props.controller, preview ? props.environmentId : null, activeId, props.demand);
  const domains = useDeploymentEnvironmentDomains(props.controller, preview ? props.environmentId : null, props.demand);
  if (!preview) return null;
  const active = serving.snapshot.value;
  const address = active ? resolveDeploymentLiveAddress(active, domains.result.items, true) : null;
  const health = deploymentHealthFact(detail.healthAggregate ?? undefined, active?.deployment.state);
  const toneColor = health.tone === 'danger' ? theme.colors.state.danger.foreground
    : health.tone === 'attention' ? theme.colors.state.warning.foreground : undefined;
  const url = address?.url ?? null;
  return (
    <ItemGroup testID="project-deployments.review.preview" title={t('projects.deployments.review.previewTitle')}
      description={t('projects.deployments.review.previewDescription')}>
      <Item
        testID="project-deployments.review.preview.address"
        icon={<Icon name="globe" size={ICON_SIZE.sm} color={theme.colors.text.secondary} />}
        title={url ? formatDeploymentLiveAddress(url) : t('projects.deployments.review.previewNotLive')}
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

/** The draft's Review (Deploy an app opened from a build preview): the same rows, on the Account's read owner. */
export function DeploymentReviewPreviewForAccount(props: Readonly<{
  lifetime: ServerAccountScopeLifetime;
  environmentId: string;
}>) {
  const demand = useDeploymentPresentationDemand(true);
  const controller = useDeploymentAccountController(props.lifetime, true, demand);
  const { serverId, accountId } = props.lifetime.scope;
  const openAddress = React.useCallback((url: string) => {
    void requestOpenExternalUrl(url, { serverId, expectedAccountId: accountId });
  }, [accountId, serverId]);
  return <DeploymentReviewPreview controller={controller} environmentId={props.environmentId} demand={demand}
    onOpenAddress={openAddress} />;
}
