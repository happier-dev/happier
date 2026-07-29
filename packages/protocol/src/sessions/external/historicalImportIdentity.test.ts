import { describe, expect, it } from 'vitest';

import { makeExternalSessionHistoricalImportLocalId } from './historicalImportIdentity.js';

describe('makeExternalSessionHistoricalImportLocalId', () => {
  it('derives one stable identity shared by live Agent and imported server rows', () => {
    expect(makeExternalSessionHistoricalImportLocalId({
      agentId: 'opencode',
      remoteSessionId: 'remote-1',
      directItemId: 'item-7',
    })).toBe('direct-import:v1:opencode:b203ba1eb5dad52e461385bc');
  });
});
