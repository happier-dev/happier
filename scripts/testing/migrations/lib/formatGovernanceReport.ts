import { type InventoryBucketSummary } from './migrationTypes.ts';

export function formatInventoryBuckets(title: string, buckets: readonly InventoryBucketSummary[]): string {
  const lines = [`# ${title}`, ''];
  if (buckets.length === 0) {
    lines.push('- none');
    return `${lines.join('\n')}\n`;
  }

  for (const bucket of buckets) {
    lines.push(`- ${bucket.ruleId}: ${bucket.count} match(es) in ${bucket.files.join(', ')}`);
  }

  return `${lines.join('\n')}\n`;
}

export function formatSimpleSections(title: string, sections: readonly string[]): string {
  return `# ${title}\n\n${sections.join('\n')}\n`;
}
