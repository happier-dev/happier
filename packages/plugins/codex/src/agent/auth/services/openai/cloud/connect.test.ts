import { describe, expect, it } from 'vitest';

import { codexCloudConnectDescriptor } from './connect.js';

describe('Codex cloud connect descriptor', () => {
  it('declares the OpenAI Codex cloud connection target facts', () => {
    expect(codexCloudConnectDescriptor).toMatchObject({
      id: 'codex',
      displayName: 'Codex',
      vendorDisplayName: 'OpenAI Codex',
      vendorKey: 'openai',
      status: 'wired',
    });
    expect(codexCloudConnectDescriptor.customAuthenticator?.authenticate).toBeTypeOf('function');
  });
});
