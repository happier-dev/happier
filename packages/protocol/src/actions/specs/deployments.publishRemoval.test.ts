import { describe, expect, it } from 'vitest';
import { ActionIdSchema } from '../actionIds.js';
import { createActionExecutor } from '../actionExecutor.js';
import { listActionSpecsForSurface } from '../actionSpecs.js';

describe('combined Publish withdrawal (owner-approved 2026-11-06)', () => {
  it('omits combined Publish from every catalog while retaining both deployment paths', () => {
    expect(ActionIdSchema.safeParse('deployments.publish').success).toBe(false);
    for (const surface of ['ui', 'cli', 'agent', 'mcp'] as const) {
      const ids = listActionSpecsForSurface(surface).map(spec => String(spec.id));
      expect(ids).not.toContain('deployments.publish');
      expect(ids).toEqual(expect.arrayContaining(['deployments.publish.prepare', 'deployments.templates.instantiate',
        'deployments.environments.create', 'deployments.deploy']));
    }
  });
  it('returns the existing unknown-action result before effects', async () => {
    const executor = createActionExecutor({});
    const unknown = await executor.execute('action.spec.get', { id: 'retired.unknown.action' }, { surface: 'cli' });
    expect(unknown.ok).toBe(false);
    expect(await executor.execute('action.spec.get', { id: 'deployments.publish' }, { surface: 'cli' })).toEqual(unknown);
  });
});
