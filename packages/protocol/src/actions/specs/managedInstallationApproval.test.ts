import { describe, expect, it } from 'vitest';
import { describeApprovalActionFields, projectApprovalReviewInput } from '../actionApprovalPresentation.js';
import { getActionSpec } from '../actionSpecs.js';

describe('managed installation approval presentation', () => {
  it('reads a trust question without routing operands or a raw prompt enum in pending and retained reviews', () => {
    const spec = getActionSpec('machines.managed.bootstrap.respond');
    const input = spec.inputSchema.parse({ serverId: 'profile', homeId: 'home', managedId: 'managed',
      operationId: 'operation', taskId: 'task', purpose: 'approve', approved: true,
      prompt: { kind: 'ssh.trustHost', message: 'Trust this machine?', host: 'guest.example',
        keyType: 'ssh-ed25519', fingerprint: 'SHA256:guest', existingFingerprint: null } });
    for (const [status, actionArgs] of [['pending', input], ['executed', projectApprovalReviewInput(spec, input)]] as const) {
      const fields = describeApprovalActionFields({ actionId: spec.id, actionArgs, status,
        preview: { actionId: spec.id, actionArgs: projectApprovalReviewInput(spec, input) } });
      expect(fields.unrepresentable).toBeNull();
      for (const path of ['serverId', 'homeId', 'operationId', 'taskId', 'purpose', 'approved']) {
        expect(fields.rows.find(row => row.path === path)).toMatchObject({ technical: true });
      }
      expect(fields.rows).toContainEqual(expect.objectContaining({ path: 'question', value: 'Trust this machine?' }));
      expect(fields.rows).toContainEqual(expect.objectContaining({ path: 'host', value: 'guest.example' }));
      expect(fields.rows).toContainEqual(expect.objectContaining({ path: 'fingerprint', value: 'SHA256:guest' }));
      expect(fields.rows.some(row => row.kind === 'value' && row.value.includes('ssh.trustHost'))).toBe(false);
    }
  });
  it('keeps an administrator password out of the retained review', () => {
    const spec = getActionSpec('machines.managed.bootstrap.respond');
    const input = spec.inputSchema.parse({ serverId: 'profile', homeId: 'home', managedId: 'managed',
      operationId: 'operation', taskId: 'task', purpose: 'establish', promptId: 'sudo-prompt', password: 'private-password' });
    const review = projectApprovalReviewInput(spec, input);
    expect(review).not.toHaveProperty('password');
    const fields = describeApprovalActionFields({ actionId: spec.id, actionArgs: null, status: 'executed',
      preview: { actionId: spec.id, actionArgs: review } });
    expect(fields.unrepresentable).toBeNull();
    expect(fields.rows.find(row => row.path === 'promptId')).toMatchObject({ technical: true });
    expect(JSON.stringify(fields)).not.toContain('private-password');
  });

});
