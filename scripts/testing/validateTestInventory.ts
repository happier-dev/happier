import { pathToFileURL } from 'node:url';

import { discoverTestFiles } from './lib/discoverTestFiles.ts';
import { LANE_ROOT_SCRIPTS } from './lib/testLaneMap.ts';
import { collectWiringReport, loadDefaultParityInput } from './validateTestWiring.ts';

export async function main(): Promise<void> {
  const report = collectWiringReport(discoverTestFiles(), loadDefaultParityInput() ?? {});

  console.log('Test inventory summary:');
  for (const [lane, count] of Object.entries(report.laneCounts)) {
    const rootScript = LANE_ROOT_SCRIPTS[lane as keyof typeof LANE_ROOT_SCRIPTS];
    console.log(`- ${lane}: ${count}${rootScript ? ` (${rootScript})` : ' (package-local only)'}`);
  }

  console.log(`Feature-tagged tests: ${report.featureTaggedFiles}`);
  if (report.packageLocalOnlyLaneIds.length > 0) {
    console.log(`Package-local-only lanes: ${report.packageLocalOnlyLaneIds.join(', ')}`);
  }
  console.log(`Wiring issues currently detected: ${report.issues.length}`);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  void main();
}
