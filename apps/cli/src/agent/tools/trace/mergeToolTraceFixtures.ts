import type { ToolTraceFixturesV1, ToolTraceFixturesV2 } from './extractToolTraceFixtures';

export function mergeToolTraceFixturesV1(params: Readonly<{
  existing: ToolTraceFixturesV1 | ToolTraceFixturesV2 | null;
  next: ToolTraceFixturesV2;
  allowlistKeys?: ReadonlySet<string> | undefined;
}>): ToolTraceFixturesV2 {
  if (!params.allowlistKeys) return params.next;

  const mergedExamples: ToolTraceFixturesV2['examples'] = {};
  for (const key of params.allowlistKeys) {
    const fromNext = params.next.examples[key];
    if (fromNext) {
      mergedExamples[key] = fromNext;
      continue;
    }
    const fromExisting = params.existing?.examples[key];
    if (fromExisting) {
      mergedExamples[key] = fromExisting;
    }
  }

  return {
    ...params.next,
    examples: mergedExamples,
  };
}
