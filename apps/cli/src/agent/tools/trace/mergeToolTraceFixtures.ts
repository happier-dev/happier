import type { ToolTraceFixturesV1 } from './extractToolTraceFixtures';

export function mergeToolTraceFixturesV1(params: Readonly<{
  existing: ToolTraceFixturesV1 | null;
  next: ToolTraceFixturesV1;
  allowlistKeys?: ReadonlySet<string> | undefined;
}>): ToolTraceFixturesV1 {
  if (!params.allowlistKeys) return params.next;

  const mergedExamples: ToolTraceFixturesV1['examples'] = {};
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

