import * as React from 'react';

import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { ApprovalTechnicalDetails } from '@/components/approvals/ActionApprovalFieldsCard';
import { presentActionFailureTechnicalDetails } from '@/components/tools/shell/approvals/approvalFailureOutcome';
import { t } from '@/text';

import type { DeploymentEnvironmentTabResult } from './useDeploymentReads';

/**
 * The one line an Environment tab section shows while its read is not ready: loading, refused, unavailable
 * (with Retry when the read says a retry can help) or empty. Ready draws nothing; an unavailable read that still
 * holds items draws the line under them, so last-known rows stay.
 */
export function DeploymentTabState(
  props: Readonly<{
    result: DeploymentEnvironmentTabResult<unknown>;
    testID: string;
    errorTitle: string;
    emptyTitle: string;
  }>,
) {
  const { result, testID } = props;
  switch (result.status) {
    case 'ready':
      return null;
    case 'loading':
      // Last-known rows stay while a refresh runs; only a first read shows the line.
      return result.items.length > 0 ? null : (
        <SurfaceStateCard
          testID={`${testID}.loading`}
          size="line"
          kind="loading"
          title={t('projects.deployments.loading')}
        />
      );
    case 'empty':
      return (
        <SurfaceStateCard
          testID={`${testID}.empty`}
          size="line"
          kind="empty"
          title={props.emptyTitle}
        />
      );
    case 'denied':
      return (
        <SurfaceStateCard
          testID={`${testID}.denied`}
          size="line"
          kind="denied"
          title={t('projects.deployments.sectionDenied')}
        />
      );
    case 'unavailable':
      return <>
        <SurfaceStateCard
          testID={`${testID}.error`}
          size="line"
          kind="error"
          title={props.errorTitle}
          {...(result.retryable
            ? {
                action: {
                  label: t('common.retry'),
                  testID: `${testID}.error.retry`,
                  onPress: () => {
                    void result.retry();
                  },
                },
              }
            : {})}
        />
        <ApprovalTechnicalDetails lines={presentActionFailureTechnicalDetails({
          errorCode: result.reason, error: result.reason,
        }, 'deployment')} />
      </>;
  }
}
