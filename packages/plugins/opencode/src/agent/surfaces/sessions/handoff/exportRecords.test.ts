import { describe, expect, it } from 'vitest';

import * as exportRecords from './exportRecords.js';

const {
  normalizeOpenCodeSessionExportForHandoffComparison,
  parseOpenCodeSessionExportRecords,
} = exportRecords;

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

  it('normalizes vendor exports for create-or-identical comparison without treating the target project id as session content', () => {
    const source = JSON.stringify({
      info: {
        title: 'Imported session',
        projectID: 'source-project',
        id: 'oc-session-1',
      },
      messages: [{
        parts: [{
          text: 'hello',
          id: 'part-1',
          messageID: 'message-1',
          sessionID: 'oc-session-1',
        }],
        info: { sessionID: 'oc-session-1', id: 'message-1' },
      }],
    });
    const existingTarget = JSON.stringify({
      messages: [{
        info: { id: 'message-1', sessionID: 'oc-session-1' },
        parts: [{
          id: 'part-1',
          text: 'hello',
          sessionID: 'oc-session-1',
          messageID: 'message-1',
        }],
      }],
      info: {
        id: 'oc-session-1',
        projectID: 'target-project',
        title: 'Imported session',
      },
    });

    expect(normalizeOpenCodeSessionExportForHandoffComparison(source, 'oc-session-1'))
      .toBe(normalizeOpenCodeSessionExportForHandoffComparison(existingTarget, 'oc-session-1'));
  });

  it('keeps divergent vendor records distinct and rejects an export for another native identity', () => {
    const source = JSON.stringify({
      info: { id: 'oc-session-1', projectID: 'source-project' },
      messages: [{
        info: { id: 'message-1', sessionID: 'oc-session-1' },
        parts: [{
          id: 'part-1',
          text: 'source',
          sessionID: 'oc-session-1',
          messageID: 'message-1',
        }],
      }],
    });
    const divergent = JSON.stringify({
      info: { id: 'oc-session-1', projectID: 'target-project' },
      messages: [{
        info: { id: 'message-1', sessionID: 'oc-session-1' },
        parts: [{
          id: 'part-1',
          text: 'target',
          sessionID: 'oc-session-1',
          messageID: 'message-1',
        }],
      }],
    });

    expect(normalizeOpenCodeSessionExportForHandoffComparison(source, 'oc-session-1'))
      .not.toBe(normalizeOpenCodeSessionExportForHandoffComparison(divergent, 'oc-session-1'));
    expect(normalizeOpenCodeSessionExportForHandoffComparison(source, 'oc-session-other')).toBeNull();
  });

  it('extracts records from OpenCode handoff Agent bundles', () => {
    const exportJsonBase64 = Buffer.from(JSON.stringify({
      id: 'oc-session-1',
      messages: [
        { id: 'message-1' },
      ],
    }), 'utf8').toString('base64');
    const extract = (exportRecords as Record<string, unknown>).extractOpenCodeSessionHandoffAgentBundleRecords;

    expect(extract).toBeTypeOf('function');
    if (typeof extract !== 'function') return;

    expect(extract({
      agentId: 'opencode',
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
