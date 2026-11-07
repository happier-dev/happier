import * as React from 'react';
import { View } from 'react-native';
import type { DeploymentReadControllerV1 } from '@happier-dev/deployments';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SectionActionButton } from '@/components/ui/lists/SectionActionButton';
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
import { useDeploymentCollection } from './useDeploymentReads';
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
  const collection = useDeploymentCollection(props.controller, { mounted: true, visible: true, focused: true });
  const [destination, setDestination] = React.useState<string | null>(null);
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
  const rows = (collection.snapshot.value?.items ?? []).filter(row => row.environment.id !== props.sourceEnvironmentId
    && row.environment.capabilities.manage && row.environment.capabilities.deploy);
  const busy = press.running || press.reviewPending;
  const confirm = () => {
    if (!destination) return;
    void press.press(() => props.promote({ environmentId: destination, sourceEnvironmentId: props.sourceEnvironmentId,
      sourceDeploymentId: props.sourceDeploymentId, artifact: 'image' }, { confirmed: true }));
  };
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
        <ItemGroup title={t('projects.deployments.promotion.destination')}>
          {rows.map(row => <Item key={row.environment.id} testID={`project-deployments.promote.destination:${row.environment.id}`}
            title={row.title} accessibilityRole="radio" selected={destination === row.environment.id} disabled={busy} showChevron={false}
            onPress={() => setDestination(row.environment.id)} />)}
          {collection.hasPreviousPage ? <SectionActionButton testID="project-deployments.promote.previous"
            icon="caret-left" title={t('common.previous')} disabled={busy} onPress={collection.previousPage} /> : null}
          {collection.hasNextPage ? <SectionActionButton testID="project-deployments.promote.next"
            icon="caret-right" title={t('common.next')} disabled={busy} onPress={collection.nextPage} /> : null}
          {collection.snapshot.status === 'unavailable' ? <SurfaceStateCard testID="project-deployments.promote.loadFailed"
            size="line" kind="error" title={t('projects.deployments.promotion.loadFailed')}
            reason={deploymentActionRefusalRemedy(collection.snapshot.failure?.code ?? 'deployment_unavailable')}
            diagnosticCode={collection.snapshot.failure?.code ?? null}
            {...(collection.snapshot.failure?.retryable ? { action: { label: t('common.retry'), onPress: () => { void collection.refresh(); } } } : {})} />
            : collection.snapshot.status !== 'ready' && rows.length === 0 ? <SurfaceStateCard size="line" kind="loading"
                testID="project-deployments.promote.loading" title={t('projects.deployments.loading')} />
            : rows.length === 0 ? <SurfaceStateCard size="line" kind="empty" testID="project-deployments.promote.empty"
                title={t('projects.deployments.promotion.emptyTitle')} reason={t('projects.deployments.promotion.emptyBody')} /> : null}
        </ItemGroup>
        <ItemGroup header="none">
          <Item title={t('projects.deployments.promotion.image')} subtitle={t('projects.deployments.promotion.imageBody')}
            showChevron={false} />
        </ItemGroup>
        {press.outcome?.kind === 'refused' ? <SurfaceStateCard testID="project-deployments.promote.refused" size="line" kind="error"
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
