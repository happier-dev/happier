import type { SessionSubagentDetailsDescriptor } from './types';

export const executionRunDetailsDescriptor: SessionSubagentDetailsDescriptor = {
    id: 'execution_run',
    matches: (subagent) => subagent.kind === 'execution_run' && typeof subagent.runRef?.runId === 'string' && subagent.runRef.runId.trim().length > 0,
    requiresToolCallMessage: false,
};
