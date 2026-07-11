import { describe, expect, it } from 'vitest';

import { resolveElevenLabsLanguageCode } from './resolveElevenLabsLanguageCode.js';

describe('resolveElevenLabsLanguageCode', () => {
  it('projects supported locale preferences and leaves unsupported languages on provider auto-detect', () => {
    expect(resolveElevenLabsLanguageCode('fr-FR')).toBe('fr');
    expect(resolveElevenLabsLanguageCode('pt-BR')).toBe('pt-br');
    expect(resolveElevenLabsLanguageCode('pt-PT')).toBe('pt');
    expect(resolveElevenLabsLanguageCode('he-IL')).toBeNull();
    expect(resolveElevenLabsLanguageCode(null)).toBeNull();
  });
});
