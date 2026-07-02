export type MemoryContentPolicy = Readonly<{
  includeUserMessages?: boolean;
  includeAssistantMessages?: boolean;
  includeReasoning?: boolean;
  includeToolSummaries?: boolean;
  includeToolOutputs?: boolean;
}>;

export const DEFAULT_MEMORY_CONTENT_POLICY: Required<MemoryContentPolicy> = {
  includeUserMessages: true,
  includeAssistantMessages: true,
  includeReasoning: false,
  includeToolSummaries: false,
  includeToolOutputs: false,
};

export function normalizeMemoryContentPolicy(policy?: MemoryContentPolicy | null): Required<MemoryContentPolicy> {
  return {
    includeUserMessages: policy?.includeUserMessages !== false,
    includeAssistantMessages: policy?.includeAssistantMessages !== false,
    includeReasoning: policy?.includeReasoning === true,
    includeToolSummaries: policy?.includeToolSummaries === true,
    includeToolOutputs: policy?.includeToolOutputs === true,
  };
}
