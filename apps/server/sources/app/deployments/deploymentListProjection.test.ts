import { afterEach, expect, it, vi } from 'vitest';
import { z } from 'zod/mini';
import { log } from '@/utils/logging/log';
import { projectDeploymentListRow } from './deploymentListProjection';

vi.mock('@/utils/logging/log', () => ({ log: vi.fn() }));
afterEach(() => vi.clearAllMocks());

it('records value-free schema causes when an invalid stored row is omitted', () => {
    const schema = z.object({ revision: z.number() });
    expect(projectDeploymentListRow(() => schema.parse({ revision: 'private-invalid-value' }))).toBeNull();
    expect(vi.mocked(log).mock.calls).toEqual(expect.arrayContaining([[expect.objectContaining({
        module: 'deployments', diagnostic: expect.objectContaining({
            source: 'deployment.list.projection', issues: expect.arrayContaining([{ path: [], code: 'invalid_type' }]),
        }),
    })]]));
    expect(JSON.stringify(vi.mocked(log).mock.calls)).not.toContain('private-invalid-value');
});

it('keeps valid list rows and propagates failures unrelated to stored schema validation', () => {
    const row = { revision: 2 };
    expect(projectDeploymentListRow(() => row)).toBe(row);
    const failure = Object.assign(new Error('storage_failure'), { code: 'ECONNRESET' });
    expect(() => projectDeploymentListRow(() => { throw failure; })).toThrow(failure);
    expect(log).not.toHaveBeenCalled();
});
