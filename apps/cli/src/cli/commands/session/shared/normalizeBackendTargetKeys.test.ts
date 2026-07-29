import { describe, expect, it } from 'vitest';

import {
  normalizeBackendTargetKeysFromCsv,
  parseSingleBackendTargetFromFlag,
} from './normalizeBackendTargetKeys';

describe('normalizeBackendTargetKeysFromCsv', () => {
  it('keeps ordinary provider shorthands on legacy agent keys', () => {
    expect(normalizeBackendTargetKeysFromCsv('codex')).toEqual(['agent:codex']);
  });

  it('routes provider shorthands with a settings backend to the concrete configured backend target', () => {
    expect(normalizeBackendTargetKeysFromCsv('antigravity')).toEqual([
      'backend:antigravity:configured:antigravity',
    ]);
    expect(parseSingleBackendTargetFromFlag('antigravity')).toEqual({
      kind: 'configuredAcpBackend',
      backendId: 'antigravity',
    });
  });

  it('preserves explicit V2 backend target keys', () => {
    expect(normalizeBackendTargetKeysFromCsv('backend:opencode')).toEqual(['backend:opencode']);
    expect(normalizeBackendTargetKeysFromCsv('backend:plugin-review-bot')).toEqual(['backend:plugin-review-bot']);
  });
});
