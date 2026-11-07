import { describe, expect, it } from 'vitest';
import { createTriageSourceV1Fixture } from '@happier-dev/triage-protocol/testing/v1';
import { TriageScanResultV1Schema } from '@happier-dev/triage-protocol/v1';

import { scanTriageSelectedScopeUnitsV1 } from './selectedScopes.js';

describe('selected-scope evidence', () => {
  it('retains a typed sub-read denial after a later readable scope completes', async () => {
    const fixture = createTriageSourceV1Fixture();
    const failure = { class: 'permission' as const, code: 'insufficient_scope',
      requiredPermissions: 'vulnerability_alerts=read', detail: 'Reconnect with alert read access.' };
    const scan = async (unitId: string | null) => TriageScanResultV1Schema.parse({
      kind: 'complete', observations: [], evidence: unitId === 'denied'
        ? { kind: 'partial', reason: 'alerts-permission', failure, omittedItemCount: 1 }
        : { kind: 'walkFinished' },
    });
    const input = { instance: fixture.configuredInstance,
      selection: { kind: 'selected' as const, unitIds: ['denied', 'readable'] }, scan };
    const first = await scanTriageSelectedScopeUnitsV1({ ...input, page: { kind: 'initial', limit: 64 } });
    if (first.kind !== 'page') throw new Error('Second scope remains');
    const completed = TriageScanResultV1Schema.parse(await scanTriageSelectedScopeUnitsV1({ ...input,
      page: { kind: 'continuation', continuation: first.continuation } }));
    expect(completed).toMatchObject({ kind: 'complete', evidence: { kind: 'partial',
      reason: 'alerts-permission', failure } });
    if (completed.kind === 'complete') expect(completed.evidence).not.toHaveProperty('omittedItemCount');
  });
});
