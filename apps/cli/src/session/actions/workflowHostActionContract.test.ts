import { describe, expect, it } from 'vitest';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { normalizeWorkflowActionThrownError } from '@happier-dev/protocol/actions/executor/workflowAccountActions';
import { WorkflowActionFailureV1Schema } from '@happier-dev/protocol/workflows/workflowProgressV1';

import { createWorkflowHostActionContractReader } from './workflowHostActionContract';

describe('Workflow host Action contract failures', () => {
  it('retains the host input refusal and repair issue through Run admission', async () => {
    const actionId = 'happier.scm.forge.github/actions/triage/prepare-github-review-workspace';
    // Captured PR4 operand and refusal, produced by the real installed-host Action reader.
    const details = { issues: [{ code: 'unknown_action', path: ['id'] }] };
    const actions = createActionExecutor({});
    const read = createWorkflowHostActionContractReader({ token: 'token',
      credentials: { token: 'token', encryption: null }, serverHttpBaseUrl: 'http://home.test',
    }, async input => actions.execute('action.spec.get', input, { surface: 'cli' }));
    const target = { machineId: 'machine', directory: '/repo' };
    expect(await read('action.spec.get', target)).toMatchObject({ inputSchema: expect.any(Object) });
    let thrown: unknown;
    try { await read(actionId, target); } catch (error) { thrown = error; }
    const result = normalizeWorkflowActionThrownError(thrown, undefined, true, 'workflow.run.start');
    expect(WorkflowActionFailureV1Schema.parse(result)).toMatchObject({ ok: false,
      errorCode: 'invalid_input', failureCause: { errorCode: 'invalid_parameters' }, details: { issues: [{
        code: 'invalid_input', path: '/id', severity: 'error', message: 'unknown_action',
      }] },
    });
    expect(thrown).toMatchObject({ code: 'invalid_parameters', details });
  });
});
