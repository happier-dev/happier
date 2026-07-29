import { describe, expect, it } from 'vitest';

import { resolveDeepSecProfileMode } from './profileMode.js';

describe('resolveDeepSecProfileMode', () => {
  it('maps only the canonical qualified security-audit profile identity', () => {
    expect(resolveDeepSecProfileMode('happier.review.deepsec/repository-security-audit')).toBe('repository_security_audit');
    expect(resolveDeepSecProfileMode('happier.review.deepsec/review')).toBe('current_diff');
    expect(resolveDeepSecProfileMode('deepsec.securityReview')).toBe('current_diff');
  });
});
