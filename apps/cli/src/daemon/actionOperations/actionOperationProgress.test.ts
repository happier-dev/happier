import { expect, it } from 'vitest';
import { parseActionOperationProgressUpdate } from './actionOperationProgress';

it('carries owner-reported steps and observed times through the real progress boundary', () => {
  const update = { phase: 'build-image', label: 'Build image', steps: [
    { id: 'prepare-inputs', label: 'Prepare build inputs', state: 'succeeded' as const, startedAt: 1, settledAt: 2 },
    { id: 'build-image', label: 'Build image', state: 'running' as const, startedAt: 2 },
    { id: 'save-image', label: 'Save prepared image', state: 'pending' as const },
  ] };
  expect(parseActionOperationProgressUpdate(update)).toEqual({ kind: 'phase', ...update });
});
