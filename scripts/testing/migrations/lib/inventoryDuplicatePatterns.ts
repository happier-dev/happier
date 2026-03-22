import { type DuplicatePatternInventoryReport, type InventoryBucketSummary, type InventoryFile, type PatternRule } from './migrationTypes.ts';
import {
  countDirectDetachedSpawnCalls,
  isCanonicalTestSpawnHelperPath,
  isTestPolicyFile,
  stripStringsAndComments,
} from '../../lib/testPolicySurface.ts';

export const DUPLICATE_PATTERN_RULES: readonly PatternRule[] = Object.freeze([
  {
    id: 'raw-detached-background-test-spawn',
    mode: 'report-only',
    scope: 'tests-only',
    kind: 'regex',
    pattern: /\bspawn\s*\([\s\S]{0,240}?detached\s*:\s*true/g,
    rationale: 'Detached background test processes should use canonical test spawn helpers instead of repeated raw child_process.spawn patterns.',
  },
  {
    id: 'direct-console-calls',
    mode: 'report-only',
    scope: 'tests-only',
    kind: 'regex',
    pattern: /\bconsole\.(?:log|warn|error|info)\s*\(/g,
    rationale: 'Test debug logging should move behind shared diagnostics helpers or be removed.',
  },
  {
    id: 'inline-expo-router-mock',
    mode: 'report-only',
    scope: 'tests-only',
    kind: 'substring',
    pattern: "vi.mock('expo-router'",
    rationale: 'Prefer the canonical UI router harness instead of repeated inline mocks.',
  },
  {
    id: 'inline-storage-mock',
    mode: 'report-only',
    scope: 'tests-only',
    kind: 'substring',
    pattern: "vi.mock('@/sync/domains/state/storage'",
    rationale: 'Prefer canonical storage builders over repeated partial storage mocks.',
  },
]);

function countMatches(content: string, rule: PatternRule): number {
  if (rule.kind === 'substring') {
    return content.split(String(rule.pattern)).length - 1;
  }

  const regex = new RegExp(rule.pattern.source, rule.pattern.flags.includes('g') ? rule.pattern.flags : `${rule.pattern.flags}g`);
  return Array.from(content.matchAll(regex)).length;
}

export function collectDuplicatePatternInventory(
  files: readonly InventoryFile[],
  rules: readonly PatternRule[] = DUPLICATE_PATTERN_RULES,
): DuplicatePatternInventoryReport {
  const bucketMap = new Map<string, InventoryBucketSummary>();

  for (const file of files) {
    const codeText = stripStringsAndComments(file.content);

    for (const rule of rules) {
      if (rule.scope === 'tests-only' && !isTestPolicyFile(file.filePath)) {
        continue;
      }

      if (rule.id === 'raw-detached-background-test-spawn' && isCanonicalTestSpawnHelperPath(file.filePath)) {
        continue;
      }

      const count = rule.id === 'raw-detached-background-test-spawn'
        ? countDirectDetachedSpawnCalls(file.filePath, file.content)
        : countMatches(rule.kind === 'regex' ? codeText : file.content, rule);
      if (count === 0) {
        continue;
      }

      const bucket = bucketMap.get(rule.id) ?? {
        ruleId: rule.id,
        count: 0,
        files: [],
      };
      bucket.count += count;
      if (!bucket.files.includes(file.filePath)) {
        bucket.files.push(file.filePath);
      }
      bucketMap.set(rule.id, bucket);
    }
  }

  const buckets = [...bucketMap.values()].sort((left, right) => left.ruleId.localeCompare(right.ruleId));
  return {
    buckets,
    filesScanned: files.length,
    totalMatches: buckets.reduce((sum, bucket) => sum + bucket.count, 0),
  };
}
