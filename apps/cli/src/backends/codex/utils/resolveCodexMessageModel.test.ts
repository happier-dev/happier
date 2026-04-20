import { describe, expect, it } from 'vitest';

import { resolveCodexMessageModel } from '../utils/resolveCodexMessageModel';

describe('resolveCodexMessageModel', () => {
  it('prefers explicit message model when provided', () => {
    expect(
      resolveCodexMessageModel({
        currentModelId: 'model-a',
        messageMetaModel: 'model-b',
      }),
    ).toBe('model-b');
  });

  it('uses current model when message does not specify one', () => {
    expect(
      resolveCodexMessageModel({
        currentModelId: 'model-a',
        messageMetaModel: undefined,
      }),
    ).toBe('model-a');
  });

  it('resets when message explicitly sets model null', () => {
    expect(
      resolveCodexMessageModel({
        currentModelId: 'model-a',
        messageMetaModel: null,
      }),
    ).toBeUndefined();
  });

  it('falls back to current model when message model is whitespace', () => {
    expect(
      resolveCodexMessageModel({
        currentModelId: 'model-a',
        messageMetaModel: '   ',
      }),
    ).toBe('model-a');
  });

  it('returns undefined when both message and current model are blank/unsupported', () => {
    expect(
      resolveCodexMessageModel({
        currentModelId: '   ',
        messageMetaModel: { value: 'model-b' },
      }),
    ).toBeUndefined();
  });

  it('trims explicit message model before returning it', () => {
    expect(
      resolveCodexMessageModel({
        currentModelId: 'model-a',
        messageMetaModel: '  model-b  ',
      }),
    ).toBe('model-b');
  });
});
