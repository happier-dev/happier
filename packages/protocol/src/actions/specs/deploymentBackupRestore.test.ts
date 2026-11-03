import { describe, expect, it } from 'vitest';
import { listActionSpecsForSurface } from '../actionSpecs.js';
import { describeApprovalActionFields } from '../actionApprovalPresentation.js';

const actionId = 'deployments.backups.restore';
const common = { serverId: 'home', environmentId: 'production', machineId: 'runtime', installationId: 'installed',
  targetLinkId: 'target', deploymentId: 'capture-receipt', restoreBackupId: 'backup', expectedRevision: 3 };

describe('deployment backup restore Action', () => {
  it.each(['prepare', 'confirm'] as const)('reads a %s approval by what it does, with its routing ids under Technical details', mode => {
    const spec = listActionSpecsForSurface('agent').find(candidate => String(candidate.id) === actionId);
    const input = { ...common, mode, ...(mode === 'confirm' ? { prepareOperationId: 'prepare-operation' } : {}) };
    // The summary says the consequence a person approves: prepare replaces nothing, confirm replaces data, code stays.
    const summary = spec?.approvalPresentation?.summary(input);
    expect(summary).toBeTruthy();
    expect(summary).not.toBe(spec?.approvalPresentation?.summary({ ...common, mode: mode === 'prepare' ? 'confirm' : 'prepare' }));
    const fields = describeApprovalActionFields({ actionId, actionArgs: input });
    const readable = fields.rows.filter(row => !(row.kind === 'value' && row.technical)).map(row => row.path);
    // The runtime Machine is named by the shared reader; every opaque id only correlates the request.
    expect(readable).toEqual(['machineId']);
    for (const path of ['serverId', 'environmentId', 'installationId', 'targetLinkId', 'deploymentId', 'restoreBackupId',
      'expectedRevision', 'mode', ...(mode === 'confirm' ? ['prepareOperationId'] : [])]) {
      expect(fields.rows.find(row => row.path === path)).toMatchObject({ technical: true });
    }
  });
});
