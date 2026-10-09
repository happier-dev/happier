import { buildMemoryRecallGuidanceBlockV1 } from './memoryRecallGuidanceV1.js';
import { buildPromptPlanV1, renderPromptPlanV1, type PromptPlanV1 } from './promptPlanV1.js';
import { buildHappierBaseSystemPromptV1 } from './systemPromptBaseV1.js';

export function buildCodingSessionPromptPlanBaseV1(args: Readonly<{
  settings: Record<string, unknown> | null | undefined;
  base?: string;
  executionRunsFeatureEnabled: boolean;
  memoryRecallGuidanceEnabled?: boolean;
  sessionTitleToolAvailable?: boolean;
  createdAsBot?: boolean;
}>): PromptPlanV1 {
  const settings = args.settings && typeof args.settings === 'object' && !Array.isArray(args.settings)
    ? args.settings
    : null;
  const base = typeof args.base === 'string'
    ? args.base
    : buildHappierBaseSystemPromptV1({
        settings,
        sessionTitleToolAvailable: args.sessionTitleToolAvailable,
        createdAsBot: args.createdAsBot,
      });

  const blocks = [{
    id: 'coding.base',
    scope: 'session' as const,
    text: base.trim(),
  }];

  if (args.memoryRecallGuidanceEnabled === true) {
    blocks.push({
      id: 'coding.memory_recall',
      scope: 'session' as const,
      text: buildMemoryRecallGuidanceBlockV1('generic'),
    });
  }

  return buildPromptPlanV1({ modality: 'coding', blocks });
}

export function buildAppendSystemPromptBaseV1(args: Readonly<{
  settings: Record<string, unknown> | null | undefined;
  base?: string;
  executionRunsFeatureEnabled: boolean;
  memoryRecallGuidanceEnabled?: boolean;
  sessionTitleToolAvailable?: boolean;
  createdAsBot?: boolean;
}>): string {
  return renderPromptPlanV1(buildCodingSessionPromptPlanBaseV1(args));
}
