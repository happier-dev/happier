import { describe, expect, it } from 'vitest';
import { normalizePermissionRequestOptionsForAcp } from '../acpCommonHandlers';

describe('normalizePermissionRequestOptionsForAcp', () => {
  it('copies toolCall into options.input when input is empty', () => {
    const options = normalizePermissionRequestOptionsForAcp({
      toolName: 'write',
      input: {},
      toolCall: {
        kind: 'edit',
        title: 'Writing to .tmp/happy-tool-ux.txt',
        locations: [{ path: '/tmp/happy-tool-ux.txt' }],
        content: [{ type: 'diff', path: 'happy-tool-ux.txt', oldText: 'a', newText: 'b' }],
        status: 'pending',
        toolCallId: 'write_file-1',
      },
    });

    expect(options).toMatchObject({
      input: {
        filepath: '/tmp/happy-tool-ux.txt',
      },
    });
  });

  it('copies toolCall into options.options.input when nested input is empty', () => {
    const options = normalizePermissionRequestOptionsForAcp({
      toolName: 'edit',
      options: {
        input: {},
        toolCall: {
          kind: 'edit',
          title: '.tmp/happy-tool-ux.txt: b => beta',
          rawInput: {
            path: '/tmp/happy-tool-ux.txt',
            oldText: 'b',
            newText: 'beta',
          },
        },
      },
    });

    expect(options).toMatchObject({
      options: {
        input: {
          filepath: '/tmp/happy-tool-ux.txt',
        },
      },
    });
  });

  it('preserves non-empty input', () => {
    const options = normalizePermissionRequestOptionsForAcp({
      toolName: 'read',
      input: { locations: [{ path: '/tmp/x' }] },
      toolCall: { kind: 'read', title: 'ignored' },
    });

    expect((options as any).input).toEqual({ locations: [{ path: '/tmp/x' }] });
  });

  it('backfills input.filepath from toolCall.rawInput without retaining circular references', () => {
    const rawInput: any = { filepath: '/tmp/cycle.txt', diff: 'x' };
    rawInput.self = rawInput;
    const out = normalizePermissionRequestOptionsForAcp({
      input: {},
      toolCall: {
        kind: 'edit',
        rawInput,
      },
    });

    expect(out).toMatchObject({
      input: {
        filepath: '/tmp/cycle.txt',
      },
    });
    expect((out as any).input.self).toBeUndefined();
  });
});
