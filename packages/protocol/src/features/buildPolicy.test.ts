import { describe, expect, it } from 'vitest';

import { evaluateFeatureBuildPolicy, parseFeatureBuildPolicy } from './buildPolicy.js';

describe('feature build policy', () => {
  it('parses allow and deny lists', () => {
    const parsed = parseFeatureBuildPolicy({
      allowRaw: 'automations,voice,unknown-id',
      denyRaw: 'voice,bugReports',
    });

    expect(parsed.allow).toEqual(['automations', 'voice']);
    expect(parsed.deny).toEqual(['voice', 'bugReports']);
  });

  it('applies deny over allow', () => {
    const parsed = parseFeatureBuildPolicy({
      allowRaw: 'automations,voice',
      denyRaw: 'voice',
    });

    expect(evaluateFeatureBuildPolicy(parsed, 'automations')).toBe('allow');
    expect(evaluateFeatureBuildPolicy(parsed, 'voice')).toBe('deny');
    expect(evaluateFeatureBuildPolicy(parsed, 'bugReports')).toBe('deny');
  });

  it('treats missing allow entries as neutral when allowlist is empty', () => {
    const parsed = parseFeatureBuildPolicy({
      allowRaw: '',
      denyRaw: 'voice',
    });

    expect(evaluateFeatureBuildPolicy(parsed, 'automations')).toBe('neutral');
    expect(evaluateFeatureBuildPolicy(parsed, 'voice')).toBe('deny');
  });
});
