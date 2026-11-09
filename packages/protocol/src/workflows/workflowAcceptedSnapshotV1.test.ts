import { describe, expect, it } from 'vitest';

import {
  WorkflowAcceptedSnapshotV1Schema,
  WorkflowRunExecutionTargetV1Schema,
  deriveWorkflowAcceptedPermissionCeilingV1,
} from './workflowDefinitionV1.js';
import { validateWorkflowDefinition } from './workflowValidationV1.js';

const definition = {
  version: 1 as const,
  inputs: [],
  defaults: {
    agentTarget: {
      kind: 'agent' as const,
      identity: { pluginId: 'happier.agent.test', localId: 'test' },
    },
  },
  blocks: [{
    kind: 'step' as const,
    id: 'step',
    document: { text: 'Work', references: [], attachments: [] },
    input: [],
    result: { kind: 'text' as const },
  }],
};

const workspaceTarget = {
  project: {
    machineId: 'machine-1',
    directory: '/workspace/project/packages/app',
    checkoutRootPath: '/workspace/project',
    workspaceRefId: 'workspace-1',
  },
  originalCommittedRevision: 'a'.repeat(40),
} as const;

const frozen = { startedBy: 'user', authoredDefinition: definition, materializedLeaves: [], frozenChildren: {}, workDepth: 0, metadata: null };

describe('WorkflowAcceptedSnapshotV1', () => {
  it('retains canonical opaque Automation identity without rewriting accepted snapshot bytes', () => {
    for (const automationId of ['a'.repeat(256), 'e\u0301']) {
      const snapshot = { ...frozen, definition, inputs: {}, machineId: 'machine-1', executionTarget: { kind: 'session' },
        workspaceTarget, authorization: { admittedPermissionCeiling: 'default', principal: { kind: 'host' } },
        source: { kind: 'automation', automationId } };
      expect(WorkflowAcceptedSnapshotV1Schema.parse(snapshot)).toEqual(snapshot);
    }
  });
  it('requires an explicit frozen authorship observation for saved sources', () => {
    const saved = { kind: 'saved' as const, definitionId: 'definition-1',
      revision: { headerVersion: 2, bodyVersion: 4 } };
    const base = { startedBy: 'user', definition, authoredDefinition: definition, workDepth: 0,
      materializedLeaves: [], frozenChildren: {}, metadata: { title: 'Frozen' },
      inputs: {}, machineId: 'machine-1', executionTarget: { kind: 'session' as const },
      workspaceTarget, origin: { kind: 'direct' as const },
      authorization: { admittedPermissionCeiling: 'default' as const, principal: { kind: 'host' as const } } };
    expect(WorkflowAcceptedSnapshotV1Schema.safeParse({ ...base, source: saved }).success).toBe(false);
    for (const savedBy of [null, { kind: 'person' as const, accountId: 'editor' }]) {
      expect(WorkflowAcceptedSnapshotV1Schema.parse({ ...base, source: { ...saved, savedBy } }).source)
        .toEqual({ ...saved, savedBy });
      const source = { kind: 'automation' as const, automationId: 'automation-1',
        definitionId: saved.definitionId, revision: saved.revision, savedBy };
      expect(WorkflowAcceptedSnapshotV1Schema.parse({ ...base, source }).source).toEqual(source);
    }
    expect(WorkflowAcceptedSnapshotV1Schema.safeParse({ ...base, source: {
      kind: 'automation', automationId: 'automation-1', definitionId: saved.definitionId,
      revision: saved.revision,
    } }).success).toBe(false);
    expect(WorkflowAcceptedSnapshotV1Schema.safeParse({ ...base, source: { kind: 'inline' } }).success).toBe(true);
  });
  it('retires the Workflow-only attached target rather than aliasing it to a Session', () => {
    expect(WorkflowRunExecutionTargetV1Schema.safeParse({ kind: 'attached_run' }).success).toBe(false);
    expect(WorkflowRunExecutionTargetV1Schema.parse({ kind: 'session' })).toEqual({ kind: 'session' });
    expect(WorkflowRunExecutionTargetV1Schema.parse({ kind: 'detached_run' })).toEqual({ kind: 'detached_run' });
  });
  it('derives one canonical ceiling from every effective nested leaf and the omission default', () => {
    const normalized = validateWorkflowDefinition({
      version: 1,
      defaults: {
        agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.test', localId: 'test' } },
        permissionMode: 'read-only',
      },
      blocks: [
        { kind: 'step', id: 'one', document: { text: 'one' }, execution: { permissionMode: 'plan' } },
        {
          kind: 'loop', id: 'loop', body: ['body'],
          repetition: {
            kind: 'evaluate', maxIterations: 2, history: 'none',
            evaluator: {
              kind: 'step', id: 'judge', document: { text: 'judge' },
              execution: { permissionMode: 'safe-yolo' },
              result: { kind: 'decision', decisions: ['continue', 'stop'] },
            },
          },
        },
      ],
    }).normalizedDefinition!;

    expect(deriveWorkflowAcceptedPermissionCeilingV1(normalized)).toBe('safe-yolo');
    expect(deriveWorkflowAcceptedPermissionCeilingV1(validateWorkflowDefinition({
      version: 1,
      defaults: { agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.test', localId: 'test' } } },
      blocks: ['uses canonical omission'],
    }).normalizedDefinition!)).toBe('default');
  });

  it('counts declared non-Agent permissions without granting default authority when they are omitted', () => {
    for (const block of [
      { kind: 'action', id: 'list', actionId: 'workflow.starters.list', input: {} },
      { kind: 'wait', id: 'wait', document: { text: 'Continue' } },
      { kind: 'workflow', id: 'nested', workflowRef: 'plugin:external.recipes/nested', input: {} },
    ]) {
      const authored = validateWorkflowDefinition({ version: 1, defaults: { permissionMode: 'yolo' }, blocks: [block] });
      expect(authored.valid).toBe(true);
      expect(deriveWorkflowAcceptedPermissionCeilingV1(authored.normalizedDefinition!)).toBe('yolo');
      const unprivileged = validateWorkflowDefinition({ version: 1, defaults: {}, blocks: [block] });
      expect(unprivileged.valid).toBe(true);
      expect(deriveWorkflowAcceptedPermissionCeilingV1(unprivileged.normalizedDefinition!)).toBe('read-only');
      const mixed = validateWorkflowDefinition({ version: 1, defaults: { permissionMode: 'read-only' },
        blocks: [{ kind: 'step', id: 'agent', document: { text: 'Read' }, execution: {
          agentTarget: { kind: 'agent', identity: { pluginId: 'external.agent', localId: 'reader' } },
        } }, block] });
      expect(mixed.valid).toBe(true);
      expect(deriveWorkflowAcceptedPermissionCeilingV1(mixed.normalizedDefinition!)).toBe('read-only');
    }
  });

  it('freezes the complete direct admission correspondence', () => {
    const snapshot = WorkflowAcceptedSnapshotV1Schema.parse({
      ...frozen,
      definition,
      metadata: { title: 'Frozen release check', description: 'Accepted once' },
      source: { kind: 'saved', definitionId: 'definition-1', revision: { headerVersion: 2, bodyVersion: 4 }, savedBy: null },
      inputs: { topic: 'workflow' },
      machineId: 'machine-1',
      executionTarget: { kind: 'detached_run' },
      workspaceTarget,
      origin: { kind: 'direct', originSessionId: 'session-1' },
      authorization: {
        admittedPermissionCeiling: 'read-only',
        principal: { kind: 'api', accountId: 'account-1', principalId: 'principal-1', credentialId: 'credential-1' },
      },
      resultDelivery: {
        kind: 'originating_session', originSessionId: 'session-1',
      },
    });
    expect(snapshot).toMatchObject({ machineId: 'machine-1', workspaceTarget, inputs: { topic: 'workflow' } });
    expect(snapshot.metadata).toEqual({ title: 'Frozen release check', description: 'Accepted once' });
    expect(snapshot.executionTarget).toEqual({ kind: 'detached_run' });
  });

  it('freezes the absence of inline display metadata and rejects malformed metadata', () => {
    const inline = {
      ...frozen,
      definition,
      source: { kind: 'inline' as const },
      inputs: {},
      machineId: 'machine-1',
      executionTarget: { kind: 'session' as const },
      workspaceTarget,
      origin: { kind: 'direct' as const },
      authorization: { admittedPermissionCeiling: 'default' as const, principal: { kind: 'host' as const } },
    };
    expect(WorkflowAcceptedSnapshotV1Schema.safeParse(inline).success).toBe(true);
    expect(WorkflowAcceptedSnapshotV1Schema.safeParse({ ...inline, metadata: { title: '   ' } }).success).toBe(false);
  });

  it('requires the normalized Run execution target in accepted storage', () => {
    const base = {
      ...frozen,
      definition,
      source: { kind: 'inline' as const },
      inputs: {},
      machineId: 'machine-1',
      workspaceTarget,
      origin: { kind: 'direct' as const },
      authorization: { admittedPermissionCeiling: 'default' as const, principal: { kind: 'host' as const } },
    };
    expect(WorkflowAcceptedSnapshotV1Schema.safeParse(base).success).toBe(false);
    expect(WorkflowAcceptedSnapshotV1Schema.safeParse({
      ...base,
      executionTarget: { kind: 'session' },
    }).success).toBe(true);
    expect(WorkflowAcceptedSnapshotV1Schema.safeParse({
      ...base,
      executionTarget: { kind: 'detached_run', runId: 'forged' },
    }).success).toBe(false);
  });

  it('rejects delivery to a Session other than the frozen origin', () => {
    expect(WorkflowAcceptedSnapshotV1Schema.safeParse({
      ...frozen,
      definition,
      source: { kind: 'inline' },
      inputs: {},
      machineId: 'machine-1',
      executionTarget: { kind: 'session' },
      workspaceTarget,
      origin: { kind: 'direct', originSessionId: 'session-1' },
      authorization: { admittedPermissionCeiling: 'default', principal: { kind: 'host' } },
      resultDelivery: {
        kind: 'originating_session', originSessionId: 'session-2',
      },
    }).success).toBe(false);
  });

  it('rejects a project workspace from a machine other than the immutable Run target', () => {
    expect(WorkflowAcceptedSnapshotV1Schema.safeParse({
      ...frozen,
      definition,
      source: { kind: 'inline' },
      inputs: {},
      machineId: 'machine-2',
      executionTarget: { kind: 'session' },
      workspaceTarget,
      origin: { kind: 'direct' },
      authorization: { admittedPermissionCeiling: 'default', principal: { kind: 'host' } },
    }).success).toBe(false);
  });
});
