import { describe, expect, it } from 'vitest';
import { SessionAuthoringValueV1Schema, SyncedSessionAuthoringValueV2Schema } from '../authoring/index.js';

import {
  SessionAuthoringCheckoutCreationDraftV1Schema as canonicalCheckoutCreationDraftSchema,
} from '../authoring/creationFieldsV1.js';
import * as sessionSpawnInput from './sessionSpawnNewInputV2.js';
import { SessionRequesterBootstrapRpcRequestV1Schema } from './sessionRequesterBootstrapV1.js';
import { SessionPromptStackV1Schema } from '../context/sessionContextV1.js';

const { SessionSpawnNewInputV2Schema } = sessionSpawnInput;

const input = {
  executionTarget: { serverId: 'server-1', machineId: 'machine-1' },
  directory: { kind: 'path', path: '/workspace/project' },
  agentTarget: {
    kind: 'agent',
    identity: { pluginId: 'happier.agent.codex', localId: 'codex' },
  },
} as const;

describe('SessionSpawnNewInputV2Schema', () => {
  it('carries exact managed birth provenance without admitting incomplete or caller-selected Session source', () => {
    const managedCreation = { homeId: 'home', managedId: 'managed',
      controller: { machineId: 'controller', installationId: 'installation' } };
    expect(SessionSpawnNewInputV2Schema.parse({ ...input, managedCreation })).toMatchObject({ managedCreation });
    expect(SessionSpawnNewInputV2Schema.safeParse({ ...input, managedCreation: { ...managedCreation, controller: { machineId: 'controller' } } }).success).toBe(false);
    expect(SessionSpawnNewInputV2Schema.safeParse({ ...input, managedCreation: { ...managedCreation, sessionId: 'claimed-session' } }).success).toBe(false);
    expect(SessionSpawnNewInputV2Schema.parse(input)).not.toHaveProperty('managedCreation');
  });
  it('carries the complete qualified Session context before initialization in ordinary and browser-safe birth', () => {
    const promptStack = SessionPromptStackV1Schema.parse([
      { id: 'session.reference', ref: { kind: 'doc', serverId: 'reference-home', artifactId: 'reference' }, enabled: false, placement: 'system_append' },
      { id: 'session.instructions', ref: { kind: 'doc', serverId: 'instruction-home', artifactId: 'instructions' }, enabled: true, required: true, placement: 'system_append' },
    ]);
    expect(SessionSpawnNewInputV2Schema.parse({ ...input, promptStack })).toMatchObject({ promptStack });
    expect(sessionSpawnInput.SessionServerStartSpawnDraftV1Schema.parse({ ...input, promptStack })).toMatchObject({ promptStack });
    expect(SessionSpawnNewInputV2Schema.parse(input)).not.toHaveProperty('promptStack');
    expect(SessionSpawnNewInputV2Schema.safeParse({ ...input, promptStack: [...promptStack, promptStack[0]] }).success).toBe(false);
    expect(SessionSpawnNewInputV2Schema.safeParse({ ...input, promptStack: [{ ...promptStack[1], ref: { ...promptStack[1]!.ref, markdown: 'hidden inline instructions' } }] }).success).toBe(false);
  });
  it('keeps requester sign-in material in the closed private transport envelope only', () => {
    const privateSchema = SessionRequesterBootstrapRpcRequestV1Schema;
    const credentials = { token: 'requester-token' };
    const requesterBootstrap = { v: 1, disposition: 'ordinary_requester', sessionId: 'prepared-session', sessionCreationDisposition: 'rejoined', credentials };
    const envelope = { kind: 'requester_session_bootstrap_v1', input, requesterBootstrap };
    expect(privateSchema.safeParse(envelope).success).toBe(true);
    expect(privateSchema.safeParse({ ...envelope, requesterBootstrap: { v: 1, disposition: 'ordinary_requester', credentials } }).success).toBe(true);
    expect(privateSchema.safeParse({ ...envelope, requesterBootstrap: { v: 1, disposition: 'ordinary_requester', sessionId: 'partial-preparation', credentials } }).success).toBe(false);
    expect(SessionSpawnNewInputV2Schema.safeParse({ ...input, requesterBootstrap }).success).toBe(false);
    expect(privateSchema.safeParse({ ...envelope, accountId: 'author-selected-account' }).success).toBe(false);
    expect(privateSchema.safeParse({ ...envelope, requesterBootstrap: { ...requesterBootstrap, machineId: 'other' } }).success).toBe(false);
    expect(privateSchema.safeParse({ ...envelope, requesterBootstrap: { ...requesterBootstrap,
      credentials: { token: 'requester-token', secret: 'invalid-key' } } }).success).toBe(false);
  });
  it('admits strict Bot creation facts through ordinary and browser-safe spawn', () => {
    const identity = { bot: { kind: 'bot' }, createdAsBot: true };
    expect(SessionSpawnNewInputV2Schema.parse({ ...input, identity })).toMatchObject({ identity });
    expect(sessionSpawnInput.SessionServerStartSpawnDraftV1Schema.parse({ ...input, identity }))
      .toMatchObject({ identity });
    expect(SessionSpawnNewInputV2Schema.parse(input)).not.toHaveProperty('identity');
    for (const invalidIdentity of [
      { ...identity, avatarId: 'override' },
      { bot: { kind: 'bot', name: 'private' }, createdAsBot: true },
      { ...identity, createdAsBot: false },
    ]) {
      expect(SessionSpawnNewInputV2Schema.safeParse({ ...input, identity: invalidIdentity }).success).toBe(false);
    }
  });
  it('carries a creation memory choice without accepting nonboolean values', () => {
    for (const memoryEnabled of [true, false]) {
      expect(SessionSpawnNewInputV2Schema.parse({ ...input, memoryEnabled }).memoryEnabled).toBe(memoryEnabled);
      expect(sessionSpawnInput.SessionServerStartSpawnDraftV1Schema.parse({ ...input, memoryEnabled }).memoryEnabled)
        .toBe(memoryEnabled);
    }
    expect(SessionSpawnNewInputV2Schema.safeParse({ ...input, memoryEnabled: 'true' }).success).toBe(false);
  });
  it('admits creation-scoped triggers without caller-selected Session identities', () => {
    const initialTriggers = [{ target: { kind: 'workflow', ref: 'builtin:review-and-converge' },
      trigger: { kind: 'sessionLifecycle', enabled: true, events: ['sessionStarted'], policy: { kind: 'firstMatch' } } }];
    expect(SessionSpawnNewInputV2Schema.parse({ ...input, initialTriggers }).initialTriggers).toEqual(initialTriggers);
    expect(SessionAuthoringValueV1Schema.shape.initialTriggers.parse(initialTriggers)).toEqual(initialTriggers);
    expect(SyncedSessionAuthoringValueV2Schema.shape.initialTriggers.parse(initialTriggers)).toEqual(initialTriggers);
    expect(SessionSpawnNewInputV2Schema.safeParse({ ...input, initialTriggers: [{ ...initialTriggers[0], sessionId: 'other' }] }).success).toBe(false);
    expect(SessionSpawnNewInputV2Schema.safeParse({ ...input, initialTriggers: [{ ...initialTriggers[0],
      trigger: { ...initialTriggers[0]!.trigger, sourceSessionId: 'other' } }] }).success).toBe(false);
    expect(SessionSpawnNewInputV2Schema.safeParse({ ...input, initialTriggers: [{ ...initialTriggers[0],
      trigger: { ...initialTriggers[0]!.trigger, policy: { kind: 'currentTurn', sourceTurnId: 'turn' } } }] }).success).toBe(false);
  });
  it('requires an explicit directory intent and excludes checkout creation from managed sessions', () => {
    expect(SessionSpawnNewInputV2Schema.parse(input).directory).toEqual(input.directory);
    expect(SessionSpawnNewInputV2Schema.parse({ ...input, directory: { kind: 'managed' } }).directory)
      .toEqual({ kind: 'managed' });
    expect(SessionSpawnNewInputV2Schema.safeParse({ ...input, directory: '/workspace/project' }).success).toBe(false);
    expect(SessionSpawnNewInputV2Schema.safeParse({ ...input, directory: { kind: 'managed', path: '/fake' } }).success).toBe(false);
    expect(SessionSpawnNewInputV2Schema.safeParse({
      ...input,
      directory: { kind: 'managed' },
      checkoutCreationDraft: { kind: 'git_worktree', displayName: 'feature', baseRef: 'main', branchMode: 'new' },
    }).success).toBe(false);
    expect(sessionSpawnInput.SessionServerStartSpawnDraftV1Schema.safeParse({
      ...input,
      directory: { kind: 'managed' },
      checkoutCreationDraft: { kind: 'git_worktree', displayName: 'feature', baseRef: 'main', branchMode: 'new' },
    }).success).toBe(false);
  });
  it('carries the strict lead relation in ordinary and browser-safe creation without implying access', () => {
    const reportsTo = { sessionId: 'lead' };
    expect(SessionSpawnNewInputV2Schema.parse({ ...input, reportsTo }).reportsTo).toEqual(reportsTo);
    expect(sessionSpawnInput.SessionServerStartSpawnDraftV1Schema.parse({ ...input, reportsTo }).reportsTo)
      .toEqual(reportsTo);
    expect(SessionSpawnNewInputV2Schema.parse(input)).not.toHaveProperty('reportsTo');
    expect(SessionSpawnNewInputV2Schema.safeParse({
      ...input, reportsTo: { ...reportsTo, accessLevel: 'edit' },
    }).success).toBe(false);
  });

  it('accepts a Team-resource Connected Service binding at the Machine spawn boundary', () => {
    expect(SessionSpawnNewInputV2Schema.parse({
      ...input,
      connectedServices: {
        v: 2,
        bindingsByServiceId: {
          'happier.connected-accounts.test/service': {
            source: 'team_resource',
            deliveryMode: 'brokered',
            resourceId: 'resource-1',
          },
        },
      },
    }).connectedServices).toMatchObject({ v: 2 });
  });

  it('carries explicit Team context independently of an empty access draft', () => {
    const parsed = SessionSpawnNewInputV2Schema.parse({
      ...input, primaryTeamId: 'team', initialAccess: { grants: [] },
    });
    expect(parsed.primaryTeamId).toBe('team');
    expect(parsed.initialAccess).toEqual({ grants: [] });
    expect(SessionSpawnNewInputV2Schema.safeParse({ ...input, primaryTeamId: '' }).success).toBe(false);
  });
  it('carries every distinct Team credential slot atomically while preserving omission compatibility', () => {
    const providerBinding = {
      v: 1,
      slot: { kind: 'provider_model' },
      resourceId: 'resource-1',
      expectedResourceRevision: 0,
      deliveryMode: 'brokered',
    } as const;
    const purposeBinding = {
      v: 1,
      slot: {
        kind: 'connected_service_purpose',
        purpose: {
          consumer: { pluginId: 'happier.agent.codex', localId: 'codex' },
          purpose: 'repository_api',
        },
      },
      resourceId: 'resource-2',
      expectedResourceRevision: 3,
      deliveryMode: 'direct',
    } as const;
    const teamCredentialBindings = [providerBinding, purposeBinding];
    expect(SessionSpawnNewInputV2Schema.parse({ ...input, teamCredentialBindings }).teamCredentialBindings)
      .toEqual(teamCredentialBindings);
    expect(SessionSpawnNewInputV2Schema.parse(input)).not.toHaveProperty('teamCredentialBindings');
    expect(SessionSpawnNewInputV2Schema.safeParse({
      ...input,
      teamCredentialBindings: [purposeBinding, purposeBinding],
    }).success).toBe(false);
    expect(SessionSpawnNewInputV2Schema.safeParse({
      ...input,
      teamCredentialBindings: [{ ...providerBinding, unexpected: true }],
    }).success)
      .toBe(false);
  });
  it('preserves strict subject-keyed initial access through ordinary and browser-safe spawn', () => {
    const initialAccess = { grants: [
      { subject: { kind: 'account', accountId: 'reader' }, accessLevel: 'view', canApprovePermissions: false },
      { subject: { kind: 'team', teamId: 'team' }, accessLevel: 'edit', canApprovePermissions: true },
      { subject: { kind: 'group', teamId: 'team', groupId: 'group' }, accessLevel: 'admin', canApprovePermissions: false },
    ] };
    expect(SessionSpawnNewInputV2Schema.parse({ ...input, initialAccess }).initialAccess).toEqual(initialAccess);
    expect(sessionSpawnInput.SessionServerStartSpawnDraftV1Schema.parse({ ...input, initialAccess }).initialAccess)
      .toEqual(initialAccess);
    expect(SessionSpawnNewInputV2Schema.safeParse({
      ...input, initialAccess: { grants: [...initialAccess.grants, initialAccess.grants[0]] },
    }).success).toBe(false);
    expect(SessionSpawnNewInputV2Schema.safeParse({
      ...input, initialAccess: { grants: [{ ...initialAccess.grants[1], requiredByTeamPolicy: true }] },
    }).success).toBe(false);
    expect(SessionSpawnNewInputV2Schema.safeParse({
      ...input,
      initialAccess: {
        grants: [{
          ...initialAccess.grants[0],
          accountEnvelopeInput: { v: 1, encryptedDataKey: Buffer.alloc(105).toString('base64') },
        }],
      },
    }).success).toBe(false);
    expect(SessionSpawnNewInputV2Schema.safeParse({
      ...input, initialAccess: { grants: [], responsibleAccountId: 'reader' },
    }).success).toBe(false);
  });

  it('accepts only the strict informational placement origin', () => {
    const placementOrigin = {
      kind: 'machine_pool',
      poolId: '11111111-1111-4111-8111-111111111111',
    } as const;
    expect(SessionSpawnNewInputV2Schema.parse({ ...input, placementOrigin }).placementOrigin)
      .toEqual(placementOrigin);
    expect(SessionSpawnNewInputV2Schema.safeParse({
      ...input,
      placementOrigin: { ...placementOrigin, name: 'Private Pool' },
    }).success).toBe(false);
  });

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

  it('carries typed Composer references in the first input without an arbitrary metadata bag', () => {
    const structuredInput = {
      v: 1,
      mentions: [{ kind: 'partner.reference', ref: 'partner:issue-42', token: '@issue', label: 'Issue #42' }],
    } as const;
    expect(SessionSpawnNewInputV2Schema.parse({
      ...input,
      initialInput: { text: 'Check @issue', structuredInput },
    }).initialInput).toEqual({ text: 'Check @issue', structuredInput });
    expect(SessionSpawnNewInputV2Schema.safeParse({
      ...input,
      initialInput: { text: 'Check @issue', meta: { arbitrary: true } },
    }).success).toBe(false);
  });

  it('accepts a contentless semantic Composer attachment as the whole first turn', () => {
    const attachment = {
      v: 1,
      instanceId: 'issue-42',
      attachment: { pluginId: 'acme.issues', localId: 'issue' },
      key: '42',
      value: { issueId: 42 },
      presentation: { label: 'Issue #42', typeLabel: 'Issue' },
    } as const;
    expect(SessionSpawnNewInputV2Schema.parse({
      ...input,
      initialInput: { structuredInput: { v: 1, composerAttachments: [attachment] } },
    }).initialInput).toEqual({ structuredInput: { v: 1, composerAttachments: [attachment] } });
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

  it('carries raw launch environment on the direct-to-daemon V2 input but never into the server-start draft', () => {
    const environmentVariables = { TOKEN: 'secret-value' } as const;
    expect(SessionSpawnNewInputV2Schema.parse({
      ...input,
      environmentVariables,
    }).environmentVariables).toEqual(environmentVariables);
    expect(sessionSpawnInput.SessionServerStartSpawnDraftV1Schema.safeParse({
      ...input,
      creationKey: undefined,
      initialInput: undefined,
      environmentVariables,
    }).success).toBe(false);
    expect(SessionSpawnNewInputV2Schema.safeParse({
      ...input,
      environmentVariables: { '': 'unnamed' },
    }).success).toBe(false);
  });

  it('accepts a value-free one-launch Saved Secret reference overlay', () => {
    const secretReferenceOverlay = {
      v: 1,
      bindings: {
        API_KEY: {
          ref: 'happier:shared-secret:v1:resource_1',
          revision: 3,
        },
      },
    } as const;
    expect(SessionSpawnNewInputV2Schema.parse({
      ...input,
      profileId: 'profile-1',
      secretReferenceOverlay,
    }).secretReferenceOverlay).toEqual(secretReferenceOverlay);
    expect(SessionSpawnNewInputV2Schema.safeParse({
      ...input,
      profileId: 'profile-1',
      secretReferenceOverlay: {
        v: 1,
        bindings: { API_KEY: { value: 'plaintext-is-not-a-reference' } },
      },
    }).success).toBe(false);
    expect(SessionSpawnNewInputV2Schema.safeParse({
      ...input,
      profileId: 'profile-1',
      secretReferenceOverlay: {
        v: 1,
        bindings: { API_KEY: { ref: 'happier:shared-secret:v1:resource_1' } },
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

  it('admits a Herdr-hosted Session through the existing terminal authoring field', () => {
    const parsed = SessionSpawnNewInputV2Schema.parse({
      ...input,
      terminal: { mode: 'herdr', herdr: { sessionName: 'default' } },
    });
    expect(parsed.terminal).toEqual({ mode: 'herdr', herdr: { sessionName: 'default' } });
    expect(SessionSpawnNewInputV2Schema.safeParse({
      ...input,
      terminal: { mode: 'herdr', herdr: { socketPath: '/private/socket' } },
    }).success).toBe(false);
  });
});
