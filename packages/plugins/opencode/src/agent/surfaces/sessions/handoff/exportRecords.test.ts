import { describe, expect, it } from 'vitest';

import * as exportRecords from './exportRecords.js';

const { parseOpenCodeSessionExportRecords } = exportRecords;

describe('parseOpenCodeSessionExportRecords', () => {
  it('includes the root export object and nested messages from OpenCode handoff JSON', () => {
    expect(parseOpenCodeSessionExportRecords(JSON.stringify({
      id: 'oc-session-1',
      messages: [
        { id: 'message-1' },
        { id: 'message-2' },
      ],
    }))).toEqual([
      {
        id: 'oc-session-1',
        messages: [
          { id: 'message-1' },
          { id: 'message-2' },
        ],
      },
      { id: 'message-1' },
      { id: 'message-2' },
    ]);
  });

  it('returns arrays directly and fails closed for malformed payloads', () => {
    expect(parseOpenCodeSessionExportRecords(JSON.stringify([{ id: 'message-1' }]))).toEqual([{ id: 'message-1' }]);
    expect(parseOpenCodeSessionExportRecords('not json')).toEqual([]);
  });

  it('extracts records from OpenCode handoff provider bundles', () => {
    const exportJsonBase64 = Buffer.from(JSON.stringify({
      id: 'oc-session-1',
      messages: [
        { id: 'message-1' },
      ],
    }), 'utf8').toString('base64');
    const extract = (exportRecords as Record<string, unknown>).extractOpenCodeSessionHandoffProviderBundleRecords;

    expect(extract).toBeTypeOf('function');
    if (typeof extract !== 'function') return;

    expect(extract({
      providerId: 'opencode',
      remoteSessionId: 'oc-session-1',
      exportJsonBase64,
    })).toEqual([
      {
        id: 'oc-session-1',
        messages: [
          { id: 'message-1' },
        ],
      },
      { id: 'message-1' },
    ]);
  });
});
