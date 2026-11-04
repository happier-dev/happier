import { describe, expect, it } from 'vitest';
import { BrowserInputEventV1Schema, BrowserInteractionStateV1Schema } from './v1.js';
import { MachineLiveStreamControlSidebandV1Schema, machineLiveStreamControlRequiresInputLeaseV1 } from '../../machines/peer/mediation/stream/controlV1.js';

describe('human browser input', () => {
  it('reports optional capability setup failure without accepting unknown reasons', () => {
    const state = { dialog: null, fileChooser: null, downloads: [], unavailable: { download: 'runtime_unavailable' } };
    expect(BrowserInteractionStateV1Schema.safeParse(state).success).toBe(true);
    expect(BrowserInteractionStateV1Schema.safeParse({ ...state, unavailable: { download: 'future' } }).success).toBe(false);
  });
  it('carries browser input under the existing live-view control and refuses unknown kinds', () => {
    const control = { v: 1, kind: 'browser_input', sourceId: 'view', streamId: 'viewer', eventId: 'scroll',
      controlEpoch: 4, event: { kind: 'wheel', target: 'page', sequence: 1, x: 0.5, y: 0.5, deltaX: 0, deltaY: 240 } };
    const parsed = MachineLiveStreamControlSidebandV1Schema.safeParse(control);
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(machineLiveStreamControlRequiresInputLeaseV1(parsed.data)).toBe(true);
    expect(MachineLiveStreamControlSidebandV1Schema.safeParse({ ...control, event: { kind: 'future' } }).success).toBe(false);
  });
  it.each([
    { kind: 'wheel', x: 0.5, y: 0.25, deltaX: -12, deltaY: 240 },
    { kind: 'clipboard', action: 'copy' },
    { kind: 'clipboard', action: 'paste', text: 'pasted text' },
    { kind: 'fileChooser', chooserId: 'chooser', files: [{ name: 'example.txt', dataBase64: 'aGVsbG8=' }] },
    { kind: 'dialog', dialogId: 'dialog', accept: true, promptText: 'answer' },
    { kind: 'download', downloadId: 'download', offset: 0, byteLength: 1024 },
  ])('accepts page-scoped $kind input and rejects browser chrome', event => {
    const input = { ...event, target: 'page', sequence: 1 };
    expect(BrowserInputEventV1Schema.safeParse(input).success).toBe(true);
    expect(BrowserInputEventV1Schema.safeParse({ ...input, target: 'chrome' }).success).toBe(false);
  });

  it('rejects unknown kinds and caller-selected filesystem paths', () => {
    expect(BrowserInputEventV1Schema.safeParse({ kind: 'future', target: 'page', sequence: 1 }).success).toBe(false);
    expect(BrowserInputEventV1Schema.safeParse({ kind: 'fileChooser', target: 'page', sequence: 1,
      chooserId: 'chooser', files: [{ name: 'example.txt', path: '/private/secret' }] }).success).toBe(false);
  });
});
