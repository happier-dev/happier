import { describe, expect, it } from 'vitest';

import {
  ActionInputPathSchema,
  ActionInputPredicateSchema,
  evaluateActionInputPredicate,
} from './actionInputPredicates.js';

describe('evaluateActionInputPredicate', () => {
  it.each([
    { label: 'rejects U+0085 at a nested segment start', path: 'auth.\u0085token', accepted: false },
    { label: 'rejects U+0085 at a segment end', path: 'auth.token\u0085', accepted: false },
    { label: 'accepts ordinary non-whitespace Unicode within a segment', path: 'auth.\u043a\u043b\u044e\u0447', accepted: true },
  ])('$label', ({ path, accepted }) => {
    expect(ActionInputPathSchema.safeParse(path).success).toBe(accepted);
  });

  it('does not coerce structured multiselect entries into predicate strings', () => {
    expect(evaluateActionInputPredicate({
      op: 'includes',
      path: 'credentialRefs',
      value: '[object Object]',
    }, {
      credentialRefs: [{
        service: { pluginId: 'com.acme.accounts', localId: 'service' },
        accountId: 'account-1',
      }],
    })).toBe(false);
  });

  it('retains string multiselect matching', () => {
    expect(evaluateActionInputPredicate({
      op: 'includes',
      path: 'targets',
      value: 'codex',
    }, { targets: ['codex', 'claude'] })).toBe(true);
  });

  it('rejects predicate operators outside the canonical grammar', () => {
    expect(ActionInputPredicateSchema.safeParse({ op: 'bogus' }).success).toBe(false);
  });
});
