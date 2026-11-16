import { expect, it } from 'vitest';
import { z } from '../zodRuntimePolicy.js';
import { deploymentTargetFitFieldsV1 } from './deployShapeV1.js';

it('admits declared source routes and rejects malformed source capability facts', () => {
    const schema = z.strictObject(deploymentTargetFitFieldsV1());
    const sources = { gitIntegration: ['github', 'gitlab'], upload: true };
    expect(schema.parse({ sources })).toEqual({ sources });
    expect(schema.safeParse({ sources: { ...sources, upload: 'yes' } }).success).toBe(false);
    expect(schema.safeParse({ sources: { ...sources, fallback: true } }).success).toBe(false);
    expect(schema.parse({})).toEqual({});
});
