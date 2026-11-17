import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { HappierPageHeader } from '@happier-dev/plugin-ui/presentation';
import type { WorkspaceAddressV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import type { ProjectManifestV1 } from '@happier-dev/protocol/workspaces/projectSetup/projectManifestV1';

import { useProjectPageBack } from '@/components/projects/detail/projectPageBack';
import { ItemList } from '@/components/ui/lists/ItemList';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { renderPageHeaderText } from '@/components/ui/layout/PageHeader';
import { PagePinnedBar } from '@/components/ui/layout/PagePinnedBar';
import { useNativeBackLayerBackHandler } from '@/components/ui/overlays/NativeBackLayerBoundary';
import { t } from '@/text';

import {
  ProjectSetupReviewActions,
  ProjectSetupReviewBody,
  type ProjectSetupScope,
  DEFAULT_PROJECT_SETUP_SCOPE,
} from './ProjectSetupReview';
import type { useProjectSetupRun } from './projectScriptRuns';
import type { ProjectScriptsController } from './useProjectScriptsController';
import { useProjectSetupMachine } from './useProjectSetupMachine';

/**
 * The held setup review and the one way to decide it. The Setup card (any host) and the phone's pushed
 * page read it here, so a decision made on either completes the same operation.
 */
export function useProjectSetupReviewDecision(
  workspace: WorkspaceAddressV1,
  controller: ProjectScriptsController,
  operation: ReturnType<typeof useProjectSetupRun>,
) {
  const consent = controller.consent;
  const held = operation?.snapshot.setupReview;
  const target = consent?.operation?.snapshot.domainRef ?? operation?.snapshot.domainRef;
  const machine = useProjectSetupMachine(
    target?.kind === 'projectCommand' ? target.serverId : workspace.serverId,
    target?.kind === 'projectCommand' ? target.machineId : workspace.machineId,
  );
  const { prepare } = controller;
  const digest = consent?.reviewedEffectDigest ?? held?.reviewedEffectDigest;
  const run = React.useCallback((scope: ProjectSetupScope) => { void prepare(digest, scope); }, [digest, prepare]);
  return {
    reviewing: consent !== null || Boolean(held),
    machine,
    pending: controller.pendingKeys.setup === true,
    reviewedEffect: consent?.reviewedEffect ?? held?.reviewedEffect,
    // What the person picked, else what the review was held with: the card and the page read one choice.
    scope: controller.reviewScope ?? consent?.consentScope ?? held?.consentScope ?? DEFAULT_PROJECT_SETUP_SCOPE,
    setScope: controller.setReviewScope,
    run,
    dismiss: controller.dismissConsent,
  };
}

/**
 * The phone's "Review setup" page (lab `s-scripts` SETUPp): the same review body as the Setup card on a
 * page of its own, with Run setup / Not now pinned below it. The Project bar's Back leaves it with the
 * choice kept; the host drops it once the review is decided.
 */
export function ProjectSetupReviewPage(
  props: Readonly<{
    testID: string;
    manifest: ProjectManifestV1;
    review: ReturnType<typeof useProjectSetupReviewDecision>;
    onBack: () => void;
    onViewFile: (() => void) | null;
    /** Each effect line's layer when the project's setup has more than the repository file (lab L6 reviewp). */
    layerOf?: ((path: readonly string[]) => string | null) | null;
  }>,
) {
  const { review, onBack } = props;
  useProjectPageBack(true, onBack);
  useNativeBackLayerBackHandler(true, React.useCallback(() => { onBack(); return true; }, [onBack]));
  const { scope } = review;
  return (
    <View testID={props.testID} style={styles.page}>
      <ItemList testID={`${props.testID}.scroll`}>
        <HappierPageHeader
          title={t('projects.scripts.setup.review')}
          testID={`${props.testID}.title`}
          showTitle
          renderText={renderPageHeaderText}
        />
        <ItemGroup surface="none">
          <View style={styles.body}>
            <ProjectSetupReviewBody
              testID={props.testID}
              manifest={props.manifest}
              machineName={review.machine.machineName}
              sharedRunAs={review.machine.sharedRunAs}
              sharedTrustDetail={review.machine.sharedTrustDetail}
              reviewedEffect={review.reviewedEffect}
              layerOf={props.layerOf ?? null}
              framed
              scope={scope}
              onScopeChange={review.setScope}
              onViewFile={() => props.onViewFile?.()}
            />
          </View>
        </ItemGroup>
      </ItemList>
      <PagePinnedBar testID={`${props.testID}.actions`}>
        <ProjectSetupReviewActions
          fill
          testID={props.testID}
          scope={scope}
          machineName={review.machine.machineName}
          sharedRunAs={review.machine.sharedRunAs}
          pending={review.pending}
          onRun={review.run}
          onNotNow={review.dismiss}
        />
      </PagePinnedBar>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  page: { flex: 1, minHeight: 0 },
  body: { gap: theme.space.s16 },
}));
