import { executionRunDetailsDescriptor } from './executionRunDetailsDescriptor';
import { toolTranscriptDetailsDescriptor } from './toolTranscriptDetailsDescriptor';
import type { ResolveSessionSubagentDetailsDescriptorParams, SessionSubagentDetailsDescriptor } from './types';

const SESSION_SUBAGENT_DETAILS_DESCRIPTORS: readonly SessionSubagentDetailsDescriptor[] = [
    executionRunDetailsDescriptor,
    toolTranscriptDetailsDescriptor,
];

export function resolveSessionSubagentDetailsDescriptor(
    params: ResolveSessionSubagentDetailsDescriptorParams,
): SessionSubagentDetailsDescriptor {
    if (params.message?.kind === 'tool-call') {
        return toolTranscriptDetailsDescriptor;
    }

    return SESSION_SUBAGENT_DETAILS_DESCRIPTORS.find((descriptor) => descriptor.matches(params.subagent))
        ?? toolTranscriptDetailsDescriptor;
}
