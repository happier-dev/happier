import { expect, it } from 'vitest';
import { forgeCiJobKeyV1, forgeCiSelectionKeyV1, readForgeCiSelectionRunV1 } from './identity.js';

it('keys exact native attempts and jobs independently of display or optional attempt numbers', () => {
  const run = { v: 1, repository: { kind: 'github', deployment: 'https://github.com', repository: 'owner/repository' }, runId: '1' } as const;
  const first = { kind: 'attempt', attempt: { run, attemptId: '1', number: 1 } } as const;
  const second = { kind: 'attempt', attempt: { run, attemptId: '2', number: 2 } } as const;
  expect(forgeCiSelectionKeyV1(first)).not.toBe(forgeCiSelectionKeyV1(second));
  expect(forgeCiSelectionKeyV1(first)).toBe(forgeCiSelectionKeyV1({ ...first, attempt: { run, attemptId: '1' } }));
  expect(forgeCiJobKeyV1({ selection: first, jobId: '1' })).not.toBe(forgeCiJobKeyV1({ selection: second, jobId: '1' }));
  expect(forgeCiJobKeyV1({ selection: first, jobId: '1' })).not.toBe(forgeCiJobKeyV1({ selection: first, jobId: '2' }));
  expect(readForgeCiSelectionRunV1(first)).toBe(run);
});
