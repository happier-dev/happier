import { describe, expect, it } from 'vitest';
import { readSessionCapabilityNoticeV1 } from './sessionCapabilityNoticeV1.js';
import { TranscriptRawRecordV1Schema } from './transcriptRawRecordV1.js';

const read = readSessionCapabilityNoticeV1;

describe('session capability notice sidecar', () => {
  const notice = { v: 1, items: [{ kind: 'mcp_server', name: 'linear', code: 'missing_value_ref', detail: 'env:LINEAR_API_KEY' }] };
  it('reads a valid notice only on the existing message arm', () => {
    expect(read({ type: 'message', message: 'linear could not start', capabilityNoticeV1: notice })).toEqual(notice);
    expect(read({ type: 'ready', capabilityNoticeV1: notice })).toBeNull();
  });
  it('reads an optional prompt-library failure through the existing message and transcript contract', () => {
    const prompt = { v: 1, items: [{ kind: 'prompt_library', name: 'Prompt library',
      code: 'prompt_library_unavailable', detail: 'unavailable' }] };
    const event = { type: 'message', message: 'Prompt library could not load', capabilityNoticeV1: prompt };
    const record = TranscriptRawRecordV1Schema.parse({ role: 'agent', content: { type: 'event', id: 'prompt', data: event } });
    expect(read(record.content.type === 'event' ? record.content.data : null)).toEqual(prompt);
  });
  it('ignores malformed and future sidecars while preserving the fallback message', () => {
    for (const sidecar of [null, { ...notice, v: 2 }, { v: 1, items: [{ kind: 'mcp_server', name: '', code: 'bad' }] }]) {
      expect(read({ type: 'message', message: 'Still visible', capabilityNoticeV1: sidecar })).toBeNull();
    }
  });
  it('drops unknown stored fields but validates every known field', () => {
    expect(read({ type: 'message', capabilityNoticeV1: { ...notice, extra: true,
      items: [{ ...notice.items[0], extra: true }],
    } })).toEqual(notice);
    expect(read({ type: 'message', capabilityNoticeV1: { ...notice,
      items: [{ ...notice.items[0], detail: 123 }],
    } })).toBeNull();
  });
  it('preserves the sidecar through the stored transcript reader without requiring it to be valid', () => {
    const correlated = { ...notice, items: [{ ...notice.items[0], requestId: '8888511a-7215-4f28-a706-ce09732d4194' }] };
    for (const capabilityNoticeV1 of [notice, correlated, { ...notice, v: 2 }]) {
      const record = { role: 'agent', content: { type: 'event', id: 'notice', data: {
        type: 'message', message: 'Still visible', capabilityNoticeV1,
      } } };
      const parsed = TranscriptRawRecordV1Schema.parse(record);
      expect(parsed).toEqual(record);
      expect(read(record.content.data)).toEqual(capabilityNoticeV1.v === 1 ? capabilityNoticeV1 : null);
    }
  });
});
