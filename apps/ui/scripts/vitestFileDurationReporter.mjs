// Records each finished test file's full cost (environment, prepare, collect,
// setup and tests) as one JSON line in HAPPIER_UI_VITEST_DURATIONS_OUTPUT.
// Small O_APPEND writes keep concurrent shard processes' lines intact.
import fs from 'node:fs';
import { vitestDurationKey } from './vitestUnitDurations.mjs';

export default class VitestFileDurationReporter {
  onTestModuleEnd(testModule) {
    const output = process.env.HAPPIER_UI_VITEST_DURATIONS_OUTPUT;
    if (!output) return;
    const d = testModule.diagnostic();
    const ms = d.environmentSetupDuration + d.prepareDuration + d.collectDuration + d.setupDuration + d.duration;
    fs.appendFileSync(output, `${JSON.stringify({ file: vitestDurationKey(testModule.moduleId), seconds: ms / 1000 })}\n`);
  }
}
