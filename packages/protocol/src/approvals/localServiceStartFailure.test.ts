import { expect, it } from 'vitest';
import { projectActionFailureCauseV1 } from '../actions/actionExecutionResult.js';
import { restorePluginErrorFromWire } from '../plugins/errors.js';

import { projectApprovalRequestForPublicRead } from '../actions/actionApprovalPresentation.js';
import { buildActionExecuteResultFromRecordedApprovalExecution, projectSettledApprovalExecution } from '../actions/executor/approvalResults.js';
import { DaemonLocalServiceLauncherStartResponseV1Schema } from '../local/services/launcher/v1.js';
import { ApprovalRequestPublicReadSchema } from './approvalRequestPublicRead.js';
import { ApprovalRequestV2Schema, StoredApprovalRequestSchema } from './approvalRequestV1.js';

it('carries the native bind cause from Start into the approved caller result', () => {
  const actionId = 'localServices.launcher.start';
  const machineId = 'machine';
  const targetId = 'project-service:web';
  const request = ApprovalRequestV2Schema.parse({ v: 2, status: 'executing', createdAtMs: 1, updatedAtMs: 2,
    createdBy: { surface: 'cli' }, requestedSurface: 'cli', actionId, summary: 'Start web',
    actionArgs: { machineId, targetId },
    executionOriginV1: { v: 1, authority: 'present_user', surface: 'cli', caller: { kind: 'host' },
      serverId: 'home', accountId: 'account', machineId, actionId, requestId: 'request' },
    decision: { kind: 'approve', decidedAtMs: 2, authority: 'present_user' } });
  const errorCode = 'plugin_managed_service_establishment_failed';
  const failureCause = projectActionFailureCauseV1(restorePluginErrorFromWire({ name: 'PluginError', code: 'terminal_unavailable', message: 'Terminal unavailable' }), 'managed_service.establishment');
  const establishmentFailure = { cause: 'port_in_use', port: 51437, lastStderrLine: 'EADDRINUSE' };
  const result = DaemonLocalServiceLauncherStartResponseV1Schema.parse({ protocolVersion: 1, machineId, targetId,
    status: 'denied', reasonCode: errorCode, establishmentFailure, failureCause,
    snapshot: { v: 1, machineId, updatedAt: 3, targets: [] } });
  const settled = projectSettledApprovalExecution({ request, actionId, exec: { ok: true, result },
    dispatchEffectAttempted: true, executedAtMs: 3 });
  const receipt = StoredApprovalRequestSchema.parse(settled.request);
  const callerResult = ApprovalRequestPublicReadSchema.parse(projectApprovalRequestForPublicRead(receipt));
  expect(buildActionExecuteResultFromRecordedApprovalExecution(callerResult)).toMatchObject({
    ok: false, errorCode, failureCause, details: { establishmentFailure },
  });
});
