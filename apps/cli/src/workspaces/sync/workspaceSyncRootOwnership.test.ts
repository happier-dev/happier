import { describe, expect, it } from 'vitest';
import { tryAcquireWorkspaceRootOwnership } from './workspaceSyncRootOwnership';

describe('workspace root ownership', () => {
  it('rejects both ancestor and descendant overlaps', async () => {
    const root = await tryAcquireWorkspaceRootOwnership({ ownerId: 'one', canonicalRoot: '/tmp/ws-owner', operation: 'sync' });
    expect('kind' in root).toBe(false);
    const descendant = await tryAcquireWorkspaceRootOwnership({ ownerId: 'two', canonicalRoot: '/tmp/ws-owner/child', operation: 'handoff' });
    expect(descendant).toMatchObject({ kind: 'overlap', existing: { ownerId: 'one' } });
    await (root as Exclude<typeof root, { kind: 'overlap' }>).release();
    const parent = await tryAcquireWorkspaceRootOwnership({ ownerId: 'three', canonicalRoot: '/tmp/ws-owner-parent', operation: 'sync' });
    expect('kind' in parent).toBe(false);
    const exact = await tryAcquireWorkspaceRootOwnership({ ownerId: 'four', canonicalRoot: '/tmp/ws-owner-parent', operation: 'bootstrap' });
    expect(exact).toMatchObject({ kind: 'overlap' });
    await (parent as Exclude<typeof parent, { kind: 'overlap' }>).release();
  });
});
