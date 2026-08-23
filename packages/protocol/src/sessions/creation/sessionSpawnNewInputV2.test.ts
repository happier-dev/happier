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
  it('accepts bounded daemon-compatible launch environment variables', () => {
    expect(SessionSpawnNewInputV2Schema.parse({
      ...input,
      environmentVariables: {
        TOKEN: 'secret-value',
        camelCase: 'supported by the daemon spawn validator',
      },
    })).toMatchObject({
      environmentVariables: {
        TOKEN: 'secret-value',
        camelCase: 'supported by the daemon spawn validator',
      },
    });
  });

  it('rejects invalid and oversized launch environment variables at the V2 boundary', () => {
    const invalidKey = SessionSpawnNewInputV2Schema.safeParse({
      ...input,
      environmentVariables: { 'BAD-NAME': 'secret-value' },
    });
    expect(invalidKey.success).toBe(false);
    if (!invalidKey.success) {
      expect(invalidKey.error.issues).toContainEqual(expect.objectContaining({
        path: ['environmentVariables', 'BAD-NAME'],
      }));
    }

    const forbiddenKey = SessionSpawnNewInputV2Schema.safeParse({
      ...input,
      environmentVariables: JSON.parse('{"constructor":"secret-value"}'),
    });
    expect(forbiddenKey.success).toBe(false);
    if (!forbiddenKey.success) {
      expect(forbiddenKey.error.issues).toContainEqual(expect.objectContaining({
        path: ['environmentVariables', 'constructor'],
      }));
    }

    const oversizedValue = SessionSpawnNewInputV2Schema.safeParse({
      ...input,
      environmentVariables: { TOKEN: 'x'.repeat(16 * 1024 + 1) },
    });
    expect(oversizedValue.success).toBe(false);
    if (!oversizedValue.success) {
      expect(oversizedValue.error.issues).toContainEqual(expect.objectContaining({
        path: ['environmentVariables', 'TOKEN'],
      }));
    }

    const tooManyEntries = SessionSpawnNewInputV2Schema.safeParse({
      ...input,
      environmentVariables: Object.fromEntries(
        Array.from({ length: 257 }, (_, index) => [`ENV_${index}`, 'x']),
      ),
    });
    expect(tooManyEntries.success).toBe(false);
    if (!tooManyEntries.success) {
      expect(tooManyEntries.error.issues).toContainEqual(expect.objectContaining({
        path: ['environmentVariables'],
      }));
    }
  });

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
