import { describe, expect, it } from 'vitest';

import { parseClaudeSdkFlagOverridesFromArgs } from './sdkFlagOverrides';

describe('parseClaudeSdkFlagOverridesFromArgs', () => {
  it('extracts supported scalar options', () => {
    const parsed = parseClaudeSdkFlagOverridesFromArgs([
      '--max-turns',
      '7',
      '--strict-mcp-config',
      '--append-system-prompt',
      'append me',
      '--system-prompt',
      'system me',
      '--model',
      'model-a',
      '--fallback-model',
      'model-b',
    ]);

    expect(parsed).toMatchObject({
      maxTurns: 7,
      strictMcpConfig: true,
      appendSystemPrompt: 'append me',
      customSystemPrompt: 'system me',
      model: 'model-a',
      fallbackModel: 'model-b',
    });
  });

  it('extracts tool arrays and ignores empty values', () => {
    const parsed = parseClaudeSdkFlagOverridesFromArgs([
      '--allowedTools',
      'read, write,',
      '--disallowedTools',
      ' edit ,',
    ]);

    expect(parsed.allowedTools).toEqual(['read', 'write']);
    expect(parsed.disallowedTools).toEqual(['edit']);
  });

  it('ignores invalid max-turns values', () => {
    const parsed = parseClaudeSdkFlagOverridesFromArgs([
      '--max-turns',
      '-1',
    ]);

    expect(parsed.maxTurns).toBeUndefined();
  });
});
