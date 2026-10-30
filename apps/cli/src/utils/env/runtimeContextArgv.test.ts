import { describe, expect, it } from 'vitest';

import { createRuntimeContextPrefixArgs, parseRuntimeContextPrefixArgs } from './runtimeContextArgv';

const invalidContexts: Readonly<Record<string, string>>[] = [
    { HAPPIER_SERVER_URL: 'https://sentinel-user:sentinel-password@server.example.test' },
    { HAPPIER_WEBAPP_URL: 'https://sentinel-user:sentinel-password@web.example.test' },
    { HAPPIER_HOME_DIR: 'sentinel\0home' },
    { PRIVATE_SENTINEL_SECRET: 'private-sentinel-value' },
];

describe('runtime context strict boundary', () => {
  it.each(invalidContexts)('rejects unsafe producer and consumer data with a sanitized diagnostic', (context) => {
    const payload = Buffer.from(JSON.stringify(context)).toString('base64url');
    for (const invoke of [
      () => createRuntimeContextPrefixArgs(context),
      () => parseRuntimeContextPrefixArgs(['--runtime-context', payload, 'resume', 'session-sentinel']),
    ]) {
      let failure: unknown;
      try {
        invoke();
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(Error);
      expect(String(failure)).toBe('Error: Invalid --runtime-context payload');
      expect(String(failure)).not.toContain(payload);
    }
  });
});
