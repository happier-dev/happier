import { describe, expect, it } from 'vitest';
import { getActionSpec } from '../../actionSpecs.js';
import { describeApprovalActionFields, projectApprovalReviewInput } from '../../actionApprovalPresentation.js';

describe('Agent isolation approval reading', () => {
  it.each([undefined, 'linuxUsersV1'] as const)('separates the old policy from the requested change (%s)', memberProvisioning => {
    const spec = getActionSpec('machines.agentIsolation.set');
    const input = spec.inputSchema.parse({ machineId: 'machine', enabled: true, expectedMetadataVersion: 4,
      expectedPolicy: { enabled: false }, expectedPlanDigest: 'reviewed-digest',
      ...(memberProvisioning ? { memberProvisioning } : {}) });
    for (const [status, actionArgs] of [['pending', input], ['executed', projectApprovalReviewInput(spec, input)]] as const) {
      const reading = describeApprovalActionFields({ actionId: spec.id, actionArgs, status });
      expect(reading.unrepresentable).toBeNull();
      expect(reading.rows).toContainEqual(expect.objectContaining({ path: 'enabled', value: 'true' }));
      for (const path of ['expectedMetadataVersion', 'expectedPolicy', 'expectedPlanDigest']) {
        expect(reading.rows).toContainEqual(expect.objectContaining({ path, technical: true }));
      }
      const sharing = reading.rows.find(row => row.path === 'memberProvisioning' && !row.technical);
      if (memberProvisioning) expect(sharing).toEqual(expect.objectContaining({ kind: 'value',
        value: 'Each person you share it with gets their own Linux user', selectedOptions: [{
          label: 'Each person you share it with gets their own Linux user',
          labelKey: 'managedMachines.identity.approvalSharedLinuxUser',
        }] }));
      else expect(sharing).toBeUndefined();
    }
  });
});
