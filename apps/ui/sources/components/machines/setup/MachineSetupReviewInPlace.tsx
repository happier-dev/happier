import * as React from 'react';

import {
  MachineSetupPlanReview,
  MachineSetupPlanReviewHeld,
  MachineSetupReviewFooter,
} from '@/components/settings/machines/managed/MachineSetupPlanReview';
import { AttentionBanner } from '@/components/ui/lists/AttentionBanner';
import { BareSectionContent } from '@/components/ui/lists/BareSectionContent';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { t } from '@/text';

import type { MachineSetupState } from './useMachineSetup';

export function MachineSetupReviewInPlace(
  props: Readonly<{ setup: MachineSetupState; machineId: string; machineName: string }>,
) {
  const { setup } = props;
  const review = setup.review;
  const nameOf = React.useCallback(() => props.machineName, [props.machineName]);
  if (!review) return null;
  const removing = review.intent.kind === 'remove';
  const stopping = review.intent.kind === 'stop' ? review.intent.name : null;
  return (
    <>
      {review.prepared ? (
        <MachineSetupPlanReview
          testID="machine-setup-plan-review"
          prepared={review.prepared}
          nameOf={nameOf}
          previouslyFailedMachineId={review.intent.previousRunFailed ? props.machineId : undefined}
          disabled={setup.pending !== null}
          onChangeRemoval={(_machineId, removeItemKeys) => {
            void setup.prepare(review.intent, removeItemKeys);
          }}
        />
      ) : (
        <MachineSetupPlanReviewHeld testID="machine-setup-review-loading" />
      )}
      {setup.approvalId ? (
        <AttentionBanner
          testID="machine-setup-approval"
          tone="neutral"
          title={t('approvals.title')}
          description={t('approvals.status.open')}
        />
      ) : null}
      <ItemGroup surface="none">
        <BareSectionContent>
          <MachineSetupReviewFooter
            prepared={review.prepared}
            nameOf={nameOf}
            onCancel={setup.cancelReview}
            cancelTestID="machine-setup-review-cancel"
            primary={
              setup.approvalId
                ? undefined
                : {
                    testID: 'machine-setup-apply',
                    label: stopping !== null
                      ? t('machinePresets.setup.tab.stopUsingRun')
                      : removing
                      ? t('machinePresets.setup.tab.removeRun')
                      : t('machinePresets.setup.applyRun', {
                          machine: props.machineName,
                        }),
                    loading: setup.pending !== null,
                    disabled: !review.prepared || setup.pending !== null,
                    onPress: () => {
                      void setup.apply();
                    },
                  }
            }
          />
        </BareSectionContent>
      </ItemGroup>
    </>
  );
}
