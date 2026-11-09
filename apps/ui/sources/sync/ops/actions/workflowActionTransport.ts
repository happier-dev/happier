import type { WorkflowActionExecute } from '@happier-dev/protocol/actions/executor/types';
import {
    WorkflowActionFailureV1Schema,
} from '@happier-dev/protocol/workflows/workflowProgressV1';

import { createUiAccountActionTransport, type AccountActionTransport } from './accountActionTransport';

export type WorkflowActionTransport = AccountActionTransport;

/** Transport-only Workflow Action leaf shared by production composition and boundary tests. */
export function createUiWorkflowActionTransport(params: Parameters<typeof createUiAccountActionTransport>[0]): WorkflowActionExecute {
    const execute = createUiAccountActionTransport(params);
    return async (args) => {
        const result = await execute(args);
        const failure = WorkflowActionFailureV1Schema.safeParse(result);
        return failure.success ? failure.data : result as Awaited<ReturnType<WorkflowActionExecute>>;
    };
}
