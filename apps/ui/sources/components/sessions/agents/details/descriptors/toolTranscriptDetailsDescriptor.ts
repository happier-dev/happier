import type { SessionSubagentDetailsDescriptor } from './types';

export const toolTranscriptDetailsDescriptor: SessionSubagentDetailsDescriptor = {
    id: 'tool_transcript',
    matches: () => true,
    requiresToolCallMessage: true,
};
