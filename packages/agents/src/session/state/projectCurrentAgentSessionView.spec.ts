import { readSessionWorkStateV1FromMetadata } from '@happier-dev/protocol';
import { describe, expect, it } from 'vitest';

import { buildHappierReplayPromptFromDialog } from '../../sessions/replay/happierReplayPrompt.js';
import { applyModelIntentSessionMetadata } from './metadataWriters.js';
import { projectCurrentAgentSessionView } from './projectCurrentAgentSessionView.js';

/**
 * The departing Agent's tracked work, as it really sits in Session metadata.
 * A placeholder `{ v: 1 }` is not displayable, so it cannot exercise the half of
 * section 8 that captures the snapshot before the field is cleared.
 */
const SOURCE_WORK_STATE = {
  v: 1,
  backendId: 'claude',
  updatedAt: 10,
  items: [
    {
      id: 'i1',
      kind: 'task',
      origin: 'vendor',
      status: 'active',
      title: 'Port the parser to the new decoder',
      updatedAt: 10,
    },
  ],
} as const;

const CLAUDE_NATIVE_VIEW = {
  flavor: 'claude',
  claudeSessionId: 'claude-1',
  claudeTranscriptPath: '/home/u/.claude/projects/x/claude-1.jsonl',
  runtimeDescriptorV1: { v: 1, agentId: 'claude', agent: {} },
} as const;

describe('projectCurrentAgentSessionView — one flat vendor key', () => {
  it('emits only the target Agent key and drops the source Agent key and log path', () => {
    const next = projectCurrentAgentSessionView(CLAUDE_NATIVE_VIEW, {
      agentId: 'codex',
      nativeResumeIdentity: { v: 1, vendorResumeId: 'codex-1' },
      runtimeDescriptor: { v: 1, agentId: 'codex', agent: {} },
    });

    expect(next.codexSessionId).toBe('codex-1');
    expect(next.claudeSessionId).toBeUndefined();
    expect(next.claudeTranscriptPath).toBeUndefined();
    expect(next.flavor).toBe('codex');
    expect(next.runtimeDescriptorV1).toEqual({ v: 1, agentId: 'codex', agent: {} });
  });

  it('writes the target’s own id and clears every other Agent’s', () => {
    const next = projectCurrentAgentSessionView({
      flavor: 'codex',
      codexSessionId: 'codex-1',
      claudeTranscriptPath: '/home/u/.claude/x/claude-1.jsonl',
    }, {
      agentId: 'claude',
      nativeResumeIdentity: { v: 1, vendorResumeId: 'claude-2' },
    });

    expect(next.claudeSessionId).toBe('claude-2');
    expect(next.codexSessionId).toBeUndefined();
    // The restored id names a DIFFERENT conversation than the path left behind,
    // so the slot is cleared rather than carried: the returning Agent's own
    // runtime republishes the right path on its next established turn.
    expect(next.claudeTranscriptPath).toBeUndefined();
  });

  it('leaves no flat key at all for a fresh target', () => {
    const next = projectCurrentAgentSessionView(CLAUDE_NATIVE_VIEW, { agentId: 'codex' });

    expect(next.codexSessionId).toBeUndefined();
    expect(next.claudeSessionId).toBeUndefined();
    expect(next.claudeTranscriptPath).toBeUndefined();
    expect(next.flavor).toBe('codex');
  });

  it('never carries one Agent’s session-log path into another Agent’s view', () => {
    const next = projectCurrentAgentSessionView({ claudeTranscriptPath: '/tmp/leak.jsonl' }, {
      agentId: 'codex',
      nativeResumeIdentity: { v: 1, vendorResumeId: 'codex-1' },
    });

    expect(next.codexSessionId).toBe('codex-1');
    expect(Object.values(next)).not.toContain('/tmp/leak.jsonl');
  });

  it('drops a stale runtime descriptor when the target declares none', () => {
    const next = projectCurrentAgentSessionView(
      { ...CLAUDE_NATIVE_VIEW, agentRuntimeDescriptorV1: { v: 1, agentId: 'claude', agent: {} } },
      { agentId: 'codex' },
    );

    expect(next.runtimeDescriptorV1).toBeUndefined();
    expect(next.agentRuntimeDescriptorV1).toBeUndefined();
  });
});

describe('projectCurrentAgentSessionView — state disposition (§8)', () => {
  const SOURCE_VIEW = {
    // Session-global facts that must survive the transition.
    path: '/home/u/project',
    machineId: 'machine-1',
    permissionMode: 'acceptEdits',
    permissionModeUpdatedAt: 10,
    terminal: { mode: 'tmux' },
    forkV1: { v: 1 },
    replaySeedV1: { v: 1 },
    readStateV1: { v: 1 },
    tag: 'session-tag',

    // Current Agent identity.
    flavor: 'claude',
    claudeSessionId: 'claude-1',
    claudeTranscriptPath: '/home/u/.claude/x.jsonl',
    runtimeDescriptorV1: { v: 1, agentId: 'claude', agent: {} },

    // Agent-scoped current projections.
    sessionWorkStateV1: SOURCE_WORK_STATE,
    sessionWorkflowActivityHeadlineV1: { v: 1 },
    sessionAgentActivityHeadlineV1: { v: 1 },
    slashCommands: ['/compact'],
    slashCommandDetails: [{ command: '/compact' }],
    tools: ['Bash'],
    agentRuntimeCapabilitiesV1: { v: 1 },
    agentRuntimeFacetsV1: { v: 1 },
    mcpSelectionV1: { v: 1 },
    externalAgentObservationV1: { v: 1 },
    sessionUsageLimitRecoveryV1: { v: 1 },
    runtimeActivityState: 'active',
    runtimeActivityActiveCount: 2,
    runtimeActivityObservedAt: 5,
    runtimeActivityRevision: 3,
    runtimeActivitySourceClass: 'agent',
    modelSelectionIntentV1: { v: 1 },
    modelOverrideV1: 'opus',
    sessionAppliedModelV1: { v: 1 },
    providerBindingV1: { v: 1 },
    acpSessionModesV1: { v: 1 },
    sessionModesV1: { v: 1 },
    acpSessionModelsV1: { v: 1 },
    sessionModelsV1: { v: 1 },
    acpConfigOptionsV1: { v: 1 },
    sessionConfigOptionsV1: { v: 1 },
    acpSessionModeOverrideV1: 'plan',
    sessionModeOverrideV1: 'plan',
    acpConfigOptionOverridesV1: { v: 1 },
    sessionConfigOptionOverridesV1: { v: 1 },

    // The source Agent's connected-service auth binding and its materialized
    // credential home. Both name a service only the SOURCE Agent's catalog
    // declares, so a target that cannot apply them must not inherit them.
    connectedServices: {
      v: 1,
      bindingsByServiceId: {
        'claude-subscription': { source: 'connected', selection: 'profile', profileId: 'team' },
      },
    },
    connectedServicesUpdatedAt: 11,
    connectedServiceMaterializationIdentityV1: { v: 1, id: 'csm_source', createdAt: 1, source: 'first_spawn' },
  } as const;

  const CARRIED_KEYS = [
    'path',
    'machineId',
    'permissionMode',
    'permissionModeUpdatedAt',
    'terminal',
    'forkV1',
    'replaySeedV1',
    'readStateV1',
    'tag',
  ] as const;

  const CLEARED_KEYS = [
    'sessionWorkStateV1',
    'sessionWorkflowActivityHeadlineV1',
    'sessionAgentActivityHeadlineV1',
    'slashCommands',
    'slashCommandDetails',
    'tools',
    'agentRuntimeCapabilitiesV1',
    'agentRuntimeFacetsV1',
    'mcpSelectionV1',
    'externalAgentObservationV1',
    'sessionUsageLimitRecoveryV1',
    'runtimeActivityState',
    'runtimeActivityActiveCount',
    'runtimeActivityObservedAt',
    'runtimeActivityRevision',
    'runtimeActivitySourceClass',
    'modelSelectionIntentV1',
    'modelOverrideV1',
    'sessionAppliedModelV1',
    'providerBindingV1',
    'acpSessionModesV1',
    'sessionModesV1',
    'acpSessionModelsV1',
    'sessionModelsV1',
    'acpConfigOptionsV1',
    'sessionConfigOptionsV1',
    'acpSessionModeOverrideV1',
    'sessionModeOverrideV1',
    'acpConfigOptionOverridesV1',
    'sessionConfigOptionOverridesV1',
    'connectedServices',
    'connectedServicesUpdatedAt',
    'connectedServiceMaterializationIdentityV1',
  ] as const;

  it.each(CARRIED_KEYS)('carries the Session-global fact %s', (key) => {
    const next = projectCurrentAgentSessionView(SOURCE_VIEW, {
      agentId: 'codex',
      agentScopedCurrentState: 'clear',
    }) as Record<string, unknown>;

    expect(next[key]).toEqual((SOURCE_VIEW as Record<string, unknown>)[key]);
  });

  it.each(CLEARED_KEYS)('clears the Agent-scoped current projection %s', (key) => {
    const next = projectCurrentAgentSessionView(SOURCE_VIEW, {
      agentId: 'codex',
      agentScopedCurrentState: 'clear',
    }) as Record<string, unknown>;

    expect(next[key]).toBeUndefined();
  });

  it('carries Agent-scoped current projections when the caller keeps them', () => {
    const next = projectCurrentAgentSessionView(SOURCE_VIEW, {
      agentId: 'claude',
      nativeResumeIdentity: { v: 1, vendorResumeId: 'claude-1' },
      agentScopedCurrentState: 'carry',
    }) as Record<string, unknown>;

    expect(next.sessionWorkStateV1).toEqual(SOURCE_WORK_STATE);
    expect(next.slashCommands).toEqual(['/compact']);
    expect(next.modelSelectionIntentV1).toEqual({ v: 1 });
    // Physical handoff moves the SAME Agent, so its connected-service binding
    // and the materialized home carrying those credentials are still true.
    expect(next.connectedServices).toEqual(SOURCE_VIEW.connectedServices);
    expect(next.connectedServicesUpdatedAt).toBe(11);
    expect(next.connectedServiceMaterializationIdentityV1)
      .toEqual(SOURCE_VIEW.connectedServiceMaterializationIdentityV1);
  });

  it('leaves target mode/model intent to the canonical intent writers rather than inventing a second one', () => {
    // §6.1: an omitted model/mode/override means "target default", which is
    // exactly the cleared state this projector produces. Applying a selected
    // intent stays with applyModelIntentSessionMetadata and friends so there is
    // one intent writer, not two.
    const next = projectCurrentAgentSessionView(SOURCE_VIEW, {
      agentId: 'codex',
      agentScopedCurrentState: 'clear',
    }) as Record<string, unknown>;

    const cleared = applyModelIntentSessionMetadata(next, {
      v: 1,
      selection: {
        agentTargetKey: 'agent:codex',
        providerConnectionId: null,
        modelId: 'gpt-5-codex',
      },
      updatedAt: 42,
    }) as Record<string, unknown>;

    expect(cleared.modelSelectionIntentV1).toMatchObject({
      selection: { agentTargetKey: 'agent:codex', modelId: 'gpt-5-codex' },
    });
  });

  it('does not mutate the input metadata', () => {
    const input = { ...SOURCE_VIEW } as Record<string, unknown>;
    projectCurrentAgentSessionView(input, { agentId: 'codex', agentScopedCurrentState: 'clear' });

    expect(input.claudeSessionId).toBe('claude-1');
    expect(input.sessionWorkStateV1).toEqual(SOURCE_WORK_STATE);
  });

  /**
   * Section 8's work-state row has TWO clauses — "capture bounded display-safe
   * snapshot into brief, THEN clear current field" — and asserting only the
   * clear is how a half-implemented requirement stayed green: the field
   * disappeared at the cutover, the in-flight plan went with it, and no test
   * could tell. The items live in a structured projection, not in the replayed
   * prose, so the brief is the only thing that can carry them across.
   *
   * Both halves are asserted against the SAME metadata object, so neither the
   * snapshot nor the clear can be satisfied by a different field.
   */
  it('captures the departing work state into the brief before clearing the current field', () => {
    const workState = readSessionWorkStateV1FromMetadata(SOURCE_VIEW);
    expect(workState).not.toBeNull();

    const brief = buildHappierReplayPromptFromDialog({
      previousSessionId: 'sess_same',
      continuity: 'same_session_agent_change',
      strategy: 'recent_messages',
      recentMessagesCount: 5,
      dialog: [{ role: 'User', createdAt: 1, text: 'keep going' }],
      workState,
    });
    expect(brief).toContain('[active] task: Port the parser to the new decoder');

    const next = projectCurrentAgentSessionView(SOURCE_VIEW, {
      agentId: 'codex',
      agentScopedCurrentState: 'clear',
    }) as Record<string, unknown>;

    expect(next.sessionWorkStateV1).toBeUndefined();
    expect(JSON.stringify(next)).not.toContain('Port the parser to the new decoder');
  });
});
