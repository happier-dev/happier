import * as React from 'react';

import {
  ProjectCommandApprovalFacts,
  readProjectServiceEffectApproval,
} from '@/components/approvals/ProjectCommandApprovalFacts';
import { ApprovalDecisionFooter } from '@/components/tools/shell/approvals/ApprovalDecisionFooter';
import { ApprovalPromptChrome } from '@/components/tools/shell/approvals/ApprovalPromptChrome';
import { t } from '@/text';

import type { LocalServiceEffectReview } from './localServiceActionAdmission';

/**
 * A declared service's current effect, waiting on the person before Start or Restart rejoins its
 * Action with the disclosed digest (plan 22: inspect → review source/effect → start). Drawn through
 * the one approval anatomy and the Project command facts; it decides nothing itself and never
 * echoes a digest the person did not see.
 */
export const LocalServiceEffectReviewCard = React.memo(
  function LocalServiceEffectReviewCard(
    props: Readonly<{
      review: LocalServiceEffectReview;
      serverId: string;
      machineId: string | null;
      onDecide: (accepted: boolean) => void;
      testID: string;
    }>,
  ) {
    const { review, onDecide } = props;
    const restart = review.actionId === 'localServices.actions.restartManaged';
    const service = review.target.title;
    const presentation = React.useMemo(
      () =>
        readProjectServiceEffectApproval({
          serverId: props.serverId,
          sourceMachineId: review.target.machineId ?? props.machineId ?? '',
          reviewedEffect: review.reviewedEffect,
        }),
      [
        props.machineId,
        props.serverId,
        review.reviewedEffect,
        review.target.machineId,
      ],
    );
    return (
      <ApprovalPromptChrome
        testID={props.testID}
        title={
          restart
            ? t('localServices.effectReview.restartTitle', { service })
            : t('localServices.effectReview.startTitle', { service })
        }
        subtitle={t('localServices.effectReview.subtitle')}
        footer={
          <ApprovalDecisionFooter
            testIDPrefix={props.testID}
            requestId={review.reviewedEffectDigest}
            isDeciding={false}
            approveLabel={
              restart
                ? t('localServices.actions.restartTitle')
                : t('localServices.effectReview.start')
            }
            rejectLabel={t('localServices.effectReview.notNow')}
            onApprove={() => onDecide(true)}
            onReject={() => onDecide(false)}
          />
        }
      >
        <ProjectCommandApprovalFacts
          presentation={presentation}
          testID={`${props.testID}-facts`}
        />
      </ApprovalPromptChrome>
    );
  },
);
