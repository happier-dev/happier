import { describe, expect, it } from 'vitest';

import { parseBugReportArgs } from './bugReportCommandArgs';

describe('parseBugReportArgs', () => {
  it('treats -h as missing value for --provider-url instead of consuming it', () => {
    expect(() => parseBugReportArgs(['--provider-url', '-h'])).toThrow(/Missing value for --provider-url/);
  });

  it('allows free-text values starting with a dash when they are provided as a single argument', () => {
    const parsed = parseBugReportArgs(['--summary', '- bullet style summary']);
    expect(parsed.summary).toBe('- bullet style summary');
  });
});
