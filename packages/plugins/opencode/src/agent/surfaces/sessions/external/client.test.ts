import { describe, expect, it } from 'vitest';

import { validateOpenCodeExternalSessionsSource } from './client.js';

describe('validateOpenCodeExternalSessionsSource', () => {
  it('rejects malformed OpenCode source payload fields at the plugin boundary', () => {
    expect(validateOpenCodeExternalSessionsSource({
      source: { kind: 'opencodeServer', baseUrl: 42 },
    }).ok).toBe(false);

    expect(validateOpenCodeExternalSessionsSource({
      source: { kind: 'opencodeServer', directory: 42 },
    }).ok).toBe(false);

    expect(validateOpenCodeExternalSessionsSource({
      source: { kind: 'opencodeServer', directory: 'x'.repeat(10_001) },
    }).ok).toBe(false);
  });

  it('normalizes configured base URL while preserving a valid directory', () => {
    expect(validateOpenCodeExternalSessionsSource({
      source: {
        kind: 'opencodeServer',
        directory: ' /tmp/repo ',
      },
      env: {
        HAPPIER_OPENCODE_SERVER_URL: ' http://127.0.0.1:4096/?ignored=true#hash ',
      },
    })).toEqual({
      ok: true,
      source: {
        kind: 'opencodeServer',
        baseUrl: 'http://127.0.0.1:4096',
        directory: '/tmp/repo',
      },
    });
  });
});
