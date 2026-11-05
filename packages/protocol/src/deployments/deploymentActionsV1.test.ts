import { describe, expect, it } from 'vitest';
import { getActionSpec } from '../actions/actionSpecs.js';

describe('existing deployment restart', () => {
  it('admits authored Domain routing through the same Action while refusing mixed private references', () => {
    const input = { serverId: 'home', environmentId: 'environment', domainId: 'domain', expectedRevision: 1,
      targetLinkId: 'runtime', expectedTargetLinkRevision: 1, requestKey: 'domain-add',
      content: { hostname: 'app.example.test', target: { service: 'web', containerPort: 8080 } } };
    const schema = getActionSpec('deployments.domains.add').inputSchema;
    expect(schema.safeParse(input).success).toBe(true);
    expect(schema.safeParse({ ...input, contentArtifactId: 'private', contentHeaderVersion: 1, contentBodyVersion: 1 }).success).toBe(false);
  });
});
