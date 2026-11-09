import * as React from 'react';
import { View } from 'react-native';
import type { DeploymentReadControllerV1 } from '@happier-dev/deployments';
import type { DeploymentEnvironmentCollectionV1 } from '@happier-dev/deployment-protocol/v1';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ListPresentationProvider } from '@/components/ui/lists/listPresentation';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Text } from '@/components/ui/text/Text';
import { ModalCardFooterActions } from '@/modal/components/card/ModalCardFooterActions';
import type { CustomModalInjectedProps } from '@/modal/types';
import { t } from '@/text';

import type { createDeploymentActions } from './deploymentActions';
import { useDeploymentPress } from './deploymentActionOutcome';
import { deploymentActionRefusalRemedy } from './deploymentPresentation';
import { deploymentSheetStyles, showDeploymentSheet } from './deploymentSheet';
import { DeploymentEnvironmentChooser } from './DeploymentEnvironmentCollection';
import type { DeploymentReviewHandle } from './DeploymentEnvironmentDetail';

export type DeploymentPromotionSheetInput = Readonly<{
  controller: DeploymentReadControllerV1;
  sourceEnvironmentId: string;
  sourceDeploymentId: string;
  name: string;
  version: string;
  promote: ReturnType<typeof createDeploymentActions>['promote'];
  review: DeploymentReviewHandle;
  onOpenReceipt: (environmentId: string, deploymentId: string) => void;
}>;

/** Only this opened chooser demands a destination collection page. */
function DeploymentPromotionSheet(props: DeploymentPromotionSheetInput & CustomModalInjectedProps) {
  const [destination, setDestination] = React.useState<string | null>(null);
  const selectDestination = React.useCallback((row: DeploymentEnvironmentCollectionV1['items'][number]) => {
    setDestination(row.environment.id);
  }, []);
  const { onClose, review, onOpenReceipt } = props;
  const press = useDeploymentPress({ pendingId: review.pendingId, request: (artifactId) => {
    onClose();
    review.request(artifactId);
  } }, (deploymentId) => {
    if (destination) {
      onClose();
      onOpenReceipt(destination, deploymentId);
    }
  });
  const isDestination = (row: DeploymentEnvironmentCollectionV1['items'][number]) => row.environment.id !== props.sourceEnvironmentId
    && row.environment.capabilities.manage && row.environment.capabilities.deploy;
  const busy = press.running || press.reviewPending;
  // Promote runs the exact images. Only when they cannot reach the destination does it offer a separately reviewed
  // rebuild of the same version (P40 promotion rule); a rebuild is never the first choice or a silent fallback.
  const [artifact, setArtifact] = React.useState<'image' | 'rebuild'>('image');
  const request = (choice: 'image' | 'rebuild') => {
    if (!destination) return;
    setArtifact(choice);
    void press.press(() => props.promote({ environmentId: destination, sourceEnvironmentId: props.sourceEnvironmentId,
      sourceDeploymentId: props.sourceDeploymentId, artifact: choice }, { confirmed: true }));
  };
  const confirm = () => request('image');
  const exactImageUnavailable = artifact === 'image' && press.outcome?.kind === 'refused'
    && press.outcome.code === 'rollback_image_unavailable';
  const footer = (
    <ModalCardFooterActions cancel={{ onPress: onClose, testID: 'project-deployments.promote.cancel', disabled: busy }}>
      <RoundButton testID="project-deployments.promote.confirm" title={t('projects.deployments.promotion.review')}
        disabled={busy || destination === null} loading={press.running} onPress={confirm} />
    </ModalCardFooterActions>
  );
  const { setChrome } = props;
  React.useEffect(() => { setChrome?.({ kind: 'card', footer }); });
  React.useEffect(() => () => setChrome?.(null), [setChrome]);
  return (
    <ListPresentationProvider value="page" pageInsets="contained">
      <View testID="project-deployments.promote" style={deploymentSheetStyles.body}>
        <Text style={deploymentSheetStyles.lead}>{t('projects.deployments.promotion.lead', { name: props.name, version: props.version })}</Text>
        <DeploymentEnvironmentChooser controller={props.controller} testID="project-deployments.promote.destination"
          title={t('projects.deployments.promotion.destination')} eligible={isDestination}
          selectedId={destination} onSelect={selectDestination} disabled={busy}
          loadFailedTitle={t('projects.deployments.promotion.loadFailed')}
          emptyTitle={t('projects.deployments.promotion.emptyTitle')} emptyBody={t('projects.deployments.promotion.emptyBody')} />
        <ItemGroup header="none">
          <Item title={t('projects.deployments.promotion.image')} subtitle={t('projects.deployments.promotion.imageBody')}
            showChevron={false} />
        </ItemGroup>
        {exactImageUnavailable ? <SurfaceStateCard testID="project-deployments.promote.rebuild" size="line" kind="error"
          title={t('projects.deployments.receipt.rebuildTitle')} reason={t('projects.deployments.receipt.rebuildBody')}
          action={{ label: t('projects.deployments.receipt.rebuildAction'), testID: 'project-deployments.promote.rebuild.confirm',
            onPress: () => request('rebuild') }} />
          : press.outcome?.kind === 'refused' ? <SurfaceStateCard testID="project-deployments.promote.refused" size="line" kind="error"
          title={t('projects.deployments.promotion.refused')} diagnosticCode={press.outcome.code}
          reason={deploymentActionRefusalRemedy(press.outcome.code)} /> : null}
        {press.outcome?.kind === 'started' ? <SurfaceStateCard size="line" kind="empty"
          title={t('projects.deployments.deployStartedTitle')} reason={t('projects.deployments.deployStartedBody')} /> : null}
        {setChrome ? null : footer}
      </View>
    </ListPresentationProvider>
  );
}

export function showDeploymentPromotionSheet(input: DeploymentPromotionSheetInput): void {
  showDeploymentSheet({ component: DeploymentPromotionSheet, props: input,
    title: t('projects.deployments.promotion.title'), testID: 'project-deployments.promote.modal', closeOnBackdrop: false });
}
