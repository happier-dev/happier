import { expect, it } from 'vitest';
import { settleActionOutput } from './resultProjection.js';
import { getActionSpec } from '../actionSpecs.js';

it('logs sanitized terminal output issues and thrown causes privately', () => {
  const diagnostics: unknown[] = [];
  const record = (diagnostic: unknown) => { diagnostics.push(diagnostic); };
  const schema = getActionSpec('action.operations.list').outputSchema!;
  const result = settleActionOutput('action.operations.list', { ok: true, result: { items: 'secret-rejected', nextCursor: null } },
    'diagnostic-request', schema, record);
  expect(result).toMatchObject({ ok: false, errorCode: 'invalid_action_output' });
  expect(result).not.toHaveProperty('details');
  expect(diagnostics).toMatchObject([{ issues: expect.arrayContaining([{ path: ['items'], code: 'invalid_type', expected: 'array' }]) }]);
  settleActionOutput('action.operations.list', { ok: true, result: {} }, undefined,
    { safeParse() { throw new TypeError('secret-thrown'); } }, record);
  expect(diagnostics[1]).toMatchObject({ failureCause: { errorClass: 'TypeError' } });
  expect(JSON.stringify([result, diagnostics])).not.toContain('secret-');
});
