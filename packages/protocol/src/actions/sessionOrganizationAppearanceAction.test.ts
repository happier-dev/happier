import { describe, expect, it } from 'vitest';
import { getActionSpec } from './actionSpecs.js';

describe('saved personal organization color intents', () => {
  it('accepts explicit set/reset colors and rejects malformed colors before a write', () => {
    const session = getActionSpec('session.organization.appearance.set');
    const project = getActionSpec('projects.organization.color.set');
    for (const [spec, target] of [[session, { sessionId: 'session' }], [project, { workspaceKey: 'project-group' }]] as const) {
      for (const color of [null, { kind: 'accent', key: 'blue' }, { kind: 'custom', hex: '#123456' }]) {
        expect(spec.inputSchema.safeParse({ ...target, color }).success).toBe(true);
      }
      expect(spec.inputSchema.parse({ ...target, color: { kind: 'custom', hex: ' #aBc ' } }))
        .toEqual({ ...target, color: { kind: 'custom', hex: '#AABBCC' } });
      for (const color of [undefined, { kind: 'accent', key: 'invented' }, { kind: 'custom', hex: 'red' }]) {
        expect(spec.inputSchema.safeParse({ ...target, color }).success).toBe(false);
      }
      expect(spec.inputSchema.safeParse({ ...target, color: null, accountId: 'someone-else' }).success).toBe(false);
    }
  });
});
