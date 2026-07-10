import { describe, expect, it } from 'vitest';

import { getSessionHandoffAgentBundleRecordExtractor } from './catalogHooks';

describe('handoff provider-bundle catalog hooks', () => {
  it('loads provider-bundle record extractors from handoff ownership', async () => {
    await expect(getSessionHandoffAgentBundleRecordExtractor('opencode')).resolves.toBeTypeOf('function');
    await expect(getSessionHandoffAgentBundleRecordExtractor('ohMyPi')).resolves.toBeNull();
  });
});
