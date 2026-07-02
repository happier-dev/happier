import { describe, expect, it } from 'vitest';

import {
  createOpenCodeAttachArgs,
  resolveOpenCodeAttachTarget,
} from './descriptor.js';

const metadata = {
  path: '/repo',
  opencodeSessionId: 'oc-session-1',
  opencodeBackendMode: 'server',
  opencodeServerBaseUrl: 'http://127.0.0.1:4096/',
  opencodeServerBaseUrlExplicit: true,
};

describe('OpenCode attach descriptor', () => {
  it('resolves server-backed attach target metadata and builds provider attach args', () => {
    const target = resolveOpenCodeAttachTarget({ metadata });

    expect(target).toEqual({
      ok: true,
      providerSessionId: 'oc-session-1',
      directory: '/repo',
      baseUrl: 'http://127.0.0.1:4096/',
    });
    if (!target.ok) throw new Error('expected attach target');
    expect(createOpenCodeAttachArgs(target)).toEqual([
      'attach',
      'http://127.0.0.1:4096/',
      '--dir',
      '/repo',
      '--session',
      'oc-session-1',
    ]);
  });
});
