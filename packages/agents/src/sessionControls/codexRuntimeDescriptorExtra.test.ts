import { describe, expect, it } from 'vitest';

import {
  buildCodexRuntimeDescriptorProviderExtra,
  readCodexRuntimeDescriptorProviderExtra,
} from './codexRuntimeDescriptorExtra.js';

describe('codexRuntimeDescriptorExtra', () => {
  it('builds and reads canonical codex provider extra payloads', () => {
    const built = buildCodexRuntimeDescriptorProviderExtra({
      backendMode: 'appServer',
      vendorSessionId: 'thread_1',
      home: 'connectedService',
      connectedServiceId: 'openai-codex',
      connectedServiceProfileId: 'work',
      homePath: '/tmp/codex-home',
    });

    expect(readCodexRuntimeDescriptorProviderExtra(built)).toEqual({
      backendMode: 'appServer',
      vendorSessionId: 'thread_1',
      home: 'connectedService',
      connectedServiceId: 'openai-codex',
      connectedServiceProfileId: 'work',
      homePath: '/tmp/codex-home',
    });
  });

  it('drops connected-service fields when the home is not connectedService', () => {
    expect(readCodexRuntimeDescriptorProviderExtra({
      v: 1,
      runtimeAffinity: {
        home: 'user',
        connectedServiceId: 'openai-codex',
        connectedServiceProfileId: 'work',
        homePath: '/tmp/codex-home',
      },
    })).toEqual({
      backendMode: null,
      vendorSessionId: null,
      home: 'user',
      connectedServiceId: null,
      connectedServiceProfileId: null,
      homePath: '/tmp/codex-home',
    });
  });
});
