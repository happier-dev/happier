import { findDeprecatedImportMatches } from './deprecatedImportRules.ts';
import { type DeprecatedImportInventoryReport, type InventoryBucketSummary, type InventoryFile } from './migrationTypes.ts';

export function collectDeprecatedImportInventory(files: readonly InventoryFile[]): DeprecatedImportInventoryReport {
  const bucketMap = new Map<string, InventoryBucketSummary>();

  for (const file of files) {
    for (const match of findDeprecatedImportMatches(file.filePath, file.content)) {
      const bucket = bucketMap.get(match.rule.id) ?? {
        ruleId: match.rule.id,
        count: 0,
        files: [],
      };
      bucket.count += 1;
      if (!bucket.files.includes(file.filePath)) {
        bucket.files.push(file.filePath);
      }
      bucketMap.set(match.rule.id, bucket);
    }
  }

  const buckets = [...bucketMap.values()].sort((left, right) => left.ruleId.localeCompare(right.ruleId));
  return {
    buckets,
    filesScanned: files.length,
    totalMatches: buckets.reduce((sum, bucket) => sum + bucket.count, 0),
  };
}
