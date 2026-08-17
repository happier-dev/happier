import { describe, expect, it } from 'vitest';

import { SessionSpawnNewInputV2Schema } from './sessionSpawnNewInputV2.js';

const input = {
  executionTarget: { serverId: 'server-1', machineId: 'machine-1' },
  directory: '/workspace/project',
  agentTarget: {
    kind: 'agent',
    identity: { pluginId: 'happier.agent.codex', localId: 'codex' },
  },
} as const;

describe('SessionSpawnNewInputV2Schema', () => {
  it('accepts only canonical permission intents at the public V2 boundary', () => {
    for (const permissionMode of ['default', 'read-only', 'safe-yolo', 'yolo', 'plan']) {
      expect(SessionSpawnNewInputV2Schema.safeParse({
        ...input,
        permissionMode,
      }).success, permissionMode).toBe(true);
    }

    expect(SessionSpawnNewInputV2Schema.safeParse({
      ...input,
      permissionMode: 'read_only',
    }).success).toBe(false);
    expect(SessionSpawnNewInputV2Schema.safeParse({
      ...input,
      permissionMode: 'surprise-me',
    }).success).toBe(false);
  });

  it('rejects opaque terminal and checkout fields at the public Session-create ingress', () => {
    expect(SessionSpawnNewInputV2Schema.parse(input)).toEqual(input);

    expect(SessionSpawnNewInputV2Schema.safeParse({
      ...input,
      terminal: {
        mode: 'tmux',
        unrecognizedTerminalSecret: 'must-not-persist',
      },
    }).success).toBe(false);
    expect(SessionSpawnNewInputV2Schema.safeParse({
      ...input,
      terminal: {
        mode: 'tmux',
        tmux: {
          sessionName: 'happier',
          unrecognizedTmuxSecret: 'must-not-persist',
        },
      },
    }).success).toBe(false);
    // `target` belongs to post-spawn terminal attachment metadata. It used to
    // survive authoring passthrough, then be stripped by the daemon's spawn
    // contract without affecting a new Session.
    expect(SessionSpawnNewInputV2Schema.safeParse({
      ...input,
      terminal: {
        mode: 'tmux',
        tmux: {
          sessionName: 'happier',
          target: 'existing-session:window',
        },
      },
    }).success).toBe(false);
    expect(SessionSpawnNewInputV2Schema.safeParse({
      ...input,
      checkoutCreationDraft: {
        kind: 'git_worktree',
        displayName: 'feature/session-create',
        baseRef: 'main',
        unrecognizedCheckoutSecret: 'must-not-persist',
      },
    }).success).toBe(false);
  });
});
