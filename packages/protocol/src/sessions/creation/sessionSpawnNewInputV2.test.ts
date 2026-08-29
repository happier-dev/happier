import { describe, expect, it } from 'vitest';

import {
  SessionAuthoringCheckoutCreationDraftV1Schema as canonicalCheckoutCreationDraftSchema,
} from '../authoring/creationFieldsV1.js';
import * as sessionSpawnInput from './sessionSpawnNewInputV2.js';

const { SessionSpawnNewInputV2Schema } = sessionSpawnInput;

const input = {
  executionTarget: { serverId: 'server-1', machineId: 'machine-1' },
  directory: '/workspace/project',
  agentTarget: {
    kind: 'agent',
    identity: { pluginId: 'happier.agent.codex', localId: 'codex' },
  },
} as const;

describe('SessionSpawnNewInputV2Schema', () => {
  it('admits one structured initial input atomically and rejects the retired text-only field', () => {
    const initialInput = {
      text: 'Review the selected pull request.',
      attachments: [{
        attachmentLocalId: 'entry',
        value: {
          key: 'github:pull:42',
          value: { sourceId: 'github', entryId: '42' },
          presentation: { label: 'PR #42' },
        },
      }],
    } as const;

    expect(SessionSpawnNewInputV2Schema.parse({ ...input, initialInput }).initialInput)
      .toEqual(initialInput);
    expect(SessionSpawnNewInputV2Schema.safeParse({
      ...input,
      initialMessage: initialInput.text,
    }).success).toBe(false);
    expect(SessionSpawnNewInputV2Schema.safeParse({
      ...input,
      initialInput: { text: '' },
    }).success).toBe(false);
    expect(SessionSpawnNewInputV2Schema.safeParse({
      ...input,
      initialInput: { text: '', attachments: initialInput.attachments },
    }).success).toBe(true);
    expect(SessionSpawnNewInputV2Schema.safeParse({
      ...input,
      initialInput: { attachments: initialInput.attachments },
    }).success).toBe(true);
  });

  it('publishes the one bounded checkout authoring draft used by spawn', () => {
    expect('SessionAuthoringCheckoutCreationDraftV1Schema' in sessionSpawnInput).toBe(true);
    expect(sessionSpawnInput.SessionAuthoringCheckoutCreationDraftV1Schema)
      .toBe(canonicalCheckoutCreationDraftSchema);

    const checkoutCreationDraft = {
      kind: 'git_worktree',
      displayName: 'feature/session-create',
      baseRef: 'main',
      branchMode: 'new',
    } as const;
    expect(SessionSpawnNewInputV2Schema.parse({
      ...input,
      checkoutCreationDraft,
    }).checkoutCreationDraft).toEqual(checkoutCreationDraft);
    expect(sessionSpawnInput.SessionAuthoringCheckoutCreationDraftV1Schema.safeParse({
      ...checkoutCreationDraft,
      unexpected: true,
    }).success).toBe(false);
  });

  it('rejects raw launch environment variables at the public V2 boundary', () => {
    expect(SessionSpawnNewInputV2Schema.safeParse({
      ...input,
      environmentVariables: {
        TOKEN: 'secret-value',
      },
    }).success).toBe(false);
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
