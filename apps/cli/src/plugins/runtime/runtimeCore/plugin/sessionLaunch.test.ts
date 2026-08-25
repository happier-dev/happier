import { describe, expect, it } from 'vitest';

import type { StoredCredentials } from '@/persistence';

import {
  buildPluginHostSessionRuntimeOptions,
  buildPluginSessionLaunchParams,
  buildPluginSessionBindingInput,
} from './sessionLaunch';

const credentials = {
  token: 'test-token',
  encryption: {
    type: 'legacy' as const,
    secret: new Uint8Array([1, 2, 3]),
  },
} satisfies StoredCredentials;

describe('plugin session launch binding', () => {
  it('preserves an initial title through the host runtime options', () => {
    const input = buildPluginSessionBindingInput({
      credentials,
      initialTitle: ' CLI live QA ',
    });
    const options = buildPluginHostSessionRuntimeOptions(input);

    expect(options).toMatchObject({ initialTitle: 'CLI live QA' });
    expect(buildPluginSessionLaunchParams({
      backend: { id: 'acme.backend' } as never,
      agent: { id: 'acme.agent' } as never,
      input,
      runtime: {
        sessionId: 'session-1',
        directory: '/workspace',
        metadata: {},
      },
    })).not.toHaveProperty('initialTitle');
  });
});
