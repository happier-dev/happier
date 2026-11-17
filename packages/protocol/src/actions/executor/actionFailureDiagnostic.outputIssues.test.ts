import { expect, it } from 'vitest';
import { z } from 'zod/mini';
import { invalidActionOutputFailure, readActionOutputDiagnostic, withActionFailureCauseDiagnostic } from './actionFailureDiagnostic.js';

it('carries only Zod issue paths and codes on closed output failures including nested union issues', () => {
  const parsed = z.object({ items: z.array(z.union([z.number(), z.boolean()])) }).safeParse({ items: ['PRIVATE_VALUE'] });
  if (parsed.success) throw new Error('Expected invalid producer output');
  const publicFailure = { ok: false, errorCode: 'invalid_action_output', error: 'invalid_action_output' };
  for (const failure of [withActionFailureCauseDiagnostic(publicFailure, parsed.error, 'action.output'),
    invalidActionOutputFailure(parsed.error)]) {
    expect(Object.keys(failure)).toEqual(Object.keys(publicFailure));
    expect(JSON.stringify(failure)).toBe(JSON.stringify(publicFailure));
    const diagnostic = readActionOutputDiagnostic(failure);
    expect(diagnostic?.issues).toEqual([
      { path: ['items', 0], code: 'invalid_union' },
      { path: ['items', 0], code: 'invalid_type' },
      { path: ['items', 0], code: 'invalid_type' },
    ]);
    expect(JSON.stringify(diagnostic)).not.toContain('PRIVATE_VALUE');
    expect(diagnostic).not.toHaveProperty('exception');
  }
});

it('keeps invalid-value codes without rejected values or schema literals', () => {
  const parsed = z.object({ status: z.literal('PRIVATE_ALLOWED') }).safeParse({ status: 'PRIVATE_VALUE' });
  if (parsed.success) throw new Error('Expected invalid producer output');
  const failure = invalidActionOutputFailure(parsed.error);
  expect(readActionOutputDiagnostic(failure)?.issues).toEqual([{ path: ['status'], code: 'invalid_value' }]);
  expect(JSON.stringify(readActionOutputDiagnostic(failure))).not.toContain('PRIVATE_');
});
