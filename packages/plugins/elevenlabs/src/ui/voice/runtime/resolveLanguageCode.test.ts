import { describe, expect, it } from 'vitest';

import { resolveElevenLabsLanguageCode } from './resolveLanguageCode.js';

describe('resolveElevenLabsLanguageCode', () => {
  it('projects supported locale preferences and leaves unsupported languages on the service default', () => {
    expect(resolveElevenLabsLanguageCode('fr-FR')).toBe('fr');
    expect(resolveElevenLabsLanguageCode('pt-BR')).toBe('pt-br');
    expect(resolveElevenLabsLanguageCode('pt-PT')).toBe('pt');
    expect(resolveElevenLabsLanguageCode('he-IL')).toBeNull();
    expect(resolveElevenLabsLanguageCode(' PT-br ')).toBe('pt-br');
    expect(resolveElevenLabsLanguageCode('pt_BR')).toBe('pt');
    expect(resolveElevenLabsLanguageCode('fr_CA')).toBe('fr');
    expect(resolveElevenLabsLanguageCode('pt-br-extra')).toBe('pt');
    expect(resolveElevenLabsLanguageCode(null)).toBeNull();
  });
});
