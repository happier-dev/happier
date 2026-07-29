import { describe, expect, it } from 'vitest';

import * as protocol from '../index.js';

describe('central Connected Account catalog contraction', () => {
  it('does not expose built-in descriptor decisions or direct credential writers', () => {
    expect(protocol).not.toHaveProperty('CONNECTED_ACCOUNT_DESCRIPTORS');
    expect(protocol).not.toHaveProperty('ConnectedAccountDescriptorSchema');
    expect(protocol).not.toHaveProperty('BITBUCKET_CONNECTED_ACCOUNT_DESCRIPTOR');
    expect(protocol).not.toHaveProperty('getConnectedAccountDescriptor');
    expect(protocol).not.toHaveProperty('getConnectedAccountDescriptorsForTarget');
    expect(protocol).not.toHaveProperty('getConnectedAccountConnectModesForTarget');
    expect(protocol).not.toHaveProperty('requireConnectedAccountDescriptor');
    expect(protocol).not.toHaveProperty('buildConnectedAccountCredentialRecordFromTokenInput');
  });
});
