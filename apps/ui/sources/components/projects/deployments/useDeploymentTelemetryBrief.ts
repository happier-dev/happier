import * as React from 'react';
import { SESSION_INPUT_HANDOFF_ACTION_ID_V1 } from '@happier-dev/protocol/actions/actionIds';
import { buildDatabaseFindingBriefV1, createDatabaseBriefHandoffControl } from '@happier-dev/plugins-database-workbench/finding-brief';
import { SessionInputHandoffResultV1Schema } from '@happier-dev/plugin-sdk/sessions';
import { randomUUID } from '@/platform/randomUUID';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { createFrontDoorUiActionExecutor } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { t } from '@/text';
import { alertActionFailure } from '@/utils/errors/alertActionFailure';
import { telemetryCaptureFailureCode } from './telemetryCaptureReads';

type Finding = Parameters<typeof buildDatabaseFindingBriefV1>[0];

export function useDeploymentTelemetryBrief(lifetime: ServerAccountScopeLifetime | null, context: object | null) {
  const [openingBrief, setOpeningBrief] = React.useState(false);
  const inFlight = React.useRef<AbortController | null>(null);
  React.useEffect(() => () => inFlight.current?.abort(), [lifetime, context]);
  const openBrief = React.useCallback(async (load: (signal: AbortSignal) => Finding | undefined | Promise<Finding | undefined>) => {
    if (!context || !lifetime?.isCurrent() || inFlight.current) return;
    const abort = new AbortController();
    inFlight.current = abort;
    const retirement = lifetime.onRetire(() => abort.abort());
    const { signal } = abort;
    setOpeningBrief(true);
    try {
      const finding = await load(signal);
      if (signal.aborted) return;
      if (!finding) {
        alertActionFailure({ reason: t('deploymentTelemetry.request.investigateFailed'), code: 'telemetry_unavailable' });
        return;
      }
      const control = createDatabaseBriefHandoffControl(() => buildDatabaseFindingBriefV1(finding), {
        handoff: { v: 1, sessionChoice: { kind: 'new' }, delivery: 'compose', newSession: { kind: 'new', seed: {} } },
        idempotencyKey: randomUUID,
      });
      const prepared = await control.controller.prepare({ signal });
      if (prepared && !signal.aborted) {
        const { serverId, accountId } = lifetime.scope;
        const outcome = await createFrontDoorUiActionExecutor(undefined, { serverId, expectedAccountId: accountId })(
          SESSION_INPUT_HANDOFF_ACTION_ID_V1, prepared.input, { signal },
        );
        const result = SessionInputHandoffResultV1Schema.parse(outcome);
        if (signal.aborted) return;
        const code = result.kind === 'unavailable' ? result.reason
          : result.kind === 'failed' ? result.failure.errorCode
          : result.kind === 'authoringResult' && result.result.kind !== 'opened' ? result.result.reason
          : null;
        if (code) alertActionFailure({ reason: t('deploymentTelemetry.request.investigateFailed'), code });
        else return result.kind === 'authoringResult' && result.result.kind === 'opened';
      }
    } catch (error) {
      if (!signal.aborted) {
        alertActionFailure({ reason: t('deploymentTelemetry.request.investigateFailed'), code: telemetryCaptureFailureCode(error) });
      }
    } finally {
      retirement.dispose();
      inFlight.current = null;
      setOpeningBrief(false);
    }
  }, [context, lifetime]);
  return { openingBrief, openBrief };
}
