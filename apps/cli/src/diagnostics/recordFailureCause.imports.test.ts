import './recordFailureCause';
import { createProjectReadinessActionForHost } from '@/deployments/actions/projectReadiness';
import { readActionOutputDiagnostic } from '@happier-dev/protocol/actions/executor/actionFailureDiagnostic';
import { describe, expect, it } from 'vitest';

describe('cold diagnostics before Project readiness', () => {
  it('preserves a readiness refusal through the real failure projection', async () => {
    const error = Object.assign(new Error('private native output'), { code: 'ECONNRESET' });
    const read = createProjectReadinessActionForHost({
      readEnvironment: async () => { throw error; },
      readHealthAndAlerts: async () => [],
    });
    const result = await read({ serverId: 'home', projectId: 'project',
      environments: [{ environmentId: 'environment', expectedRevision: 1 }] }, { surface: 'cli' });
    expect(result).toMatchObject({ ok: false, errorCode: 'ECONNRESET' });
    expect(readActionOutputDiagnostic(result)).toMatchObject({
      phase: 'deployment.project.readiness', failureCause: { errorCode: 'ECONNRESET' },
    });
    expect(JSON.stringify(result)).not.toContain('private native output');
  });
});
