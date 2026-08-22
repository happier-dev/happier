import { describe, expect, it } from 'vitest';

import {
  describePluginAuthoringStageReport,
  pluginAuthoringStageFailure,
} from './lifecycleStage';

describe('plugin authoring stage report rendering', () => {
  it('renders an author-actionable source location beneath its diagnostic', () => {
    const lines = describePluginAuthoringStageReport(pluginAuthoringStageFailure({
      stage: 'built',
      diagnostics: [{
        code: 'plugin_author_tool_failed',
        message: "Cannot find module 'left-pad'.",
        source: { file: 'src/daemon.ts', line: 7, column: 19 },
      }],
    }));

    expect(lines).toContain('    at src/daemon.ts:7:19');
  });

  it('renders a file-only source location when no line was reported', () => {
    const lines = describePluginAuthoringStageReport(pluginAuthoringStageFailure({
      stage: 'source_validated',
      diagnostics: [{
        code: 'plugin_author_tool_failed',
        message: 'Entry module is missing.',
        source: { file: 'src/daemon.ts' },
      }],
    }));

    expect(lines).toContain('    at src/daemon.ts');
  });

  it('renders nothing extra for a diagnostic with no source location', () => {
    const lines = describePluginAuthoringStageReport(pluginAuthoringStageFailure({
      stage: 'admitted',
      diagnostics: [{ code: 'plugin_dev_candidate_rejected', message: 'Rejected.' }],
    }));

    expect(lines).toEqual([
      'Stage: admitted (failed)',
      '  plugin_dev_candidate_rejected: Rejected.',
    ]);
  });
});
