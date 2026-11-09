import { describe, expect, it } from 'vitest';
import { getActionSpec, isSessionTargetPreparationAction, SessionTargetsResolveInputV1Schema } from './actionSpecs.js';
import { actionSpecToActionDefinitionV1 } from './actionCatalog.js';
import { ActionDiscoveryDefinitionV1Schema } from './actionDefinitionV1.js';
import { compileProtocolJsonSchema } from '../plugins/actions/jsonSchemaCompiler.js';
import { SessionStatusActionResultV1Schema } from '../sessions/control/contract.js';
import { projectSessionSummaryV1 } from '../sessions/control/listResult.js';
import { RoleActionInputSchemasV1 } from '../prompts/roles/roleActionsV1.js';

describe('Session target declaration discovery', () => {
  it('admits canonical contributed Action identities for inspection while retaining strict target input', () => {
    const input = { actionId: 'example.session-targets/actions/inspect', target: { selector: 'self' } };
    expect(SessionTargetsResolveInputV1Schema.safeParse(input).success).toBe(true);
    expect(SessionTargetsResolveInputV1Schema.safeParse({ ...input, actionId: 'example.session-targets/inspect' }).success).toBe(false);
    expect(SessionTargetsResolveInputV1Schema.safeParse({ ...input, extraAuthority: true }).success).toBe(false);
    expect(SessionTargetsResolveInputV1Schema.safeParse({ ...input, target: { selector: 'self', extraAuthority: true } }).success).toBe(false);
    // The signed root is the admitted dispatch wrapper, never the described
    // plugin Action or the host Action used to read a preparation fact.
    expect(isSessionTargetPreparationAction('action.invoke')).toBe(true);
    expect(isSessionTargetPreparationAction('session.targets.resolve')).toBe(true);
    expect(isSessionTargetPreparationAction('teams.archive')).toBe(false);
  });

  it('publishes Session targets through real strict discovery and input-schema consumers', () => {
    for (const [id, cardinality, extraInput] of [
      ['session.message.send', 'many', { message: 'Review the change', wait: true }],
      ['session.status.get', 'many', {}],
      ['session.open', 'one', {}],
      ['session.stop', 'many', {}],
      ['session.turn.cancel', 'many', {}],
      ['session.messages.recent.get', 'many', {}],
      ['session.archive', 'one', {}],
      ['session.unarchive', 'one', {}],
      ['session.goal.get', 'one', {}],
      ['session.goal.set', 'one', { objective: 'Ship the fix' }],
      ['session.goal.clear', 'one', {}],
      ['session.manager.set', 'one', { managerSessionId: 'new-manager', expectedManagerSessionId: null }],
      ['session.coordinator.enable', 'one', { roleId: 'orchestrator', keep: 'none', ruleSuggestions: [] }],
      ['session.role.set', 'one', { roleId: 'orchestrator' }],
      ['session.roles.override.set', 'one', { roleId: 'orchestrator', workspaceWrites: 'deny' }],
      ['session.roles.override.clear', 'one', { roleId: 'orchestrator' }],
      ['session.roles.add', 'one', { roleId: 'scout', role: {
        name: 'Scout', instructions: 'Read and report.', runsAs: { kind: 'session' },
        workspaceWrites: 'deny', secondOpinion: 'off', enabled: true,
      } }],
      ['session.roles.remove', 'one', { roleId: 'scout' }],
      ['session.notes.set', 'one', { notes: 'Verify before reporting.' }],
      ['session.tags.set', 'one', { tagIds: [] }],
      ['session.memory.set', 'one', { serverId: 'home', expectedMetadataRevision: 3, enabled: false }],
      ['session.context.update', 'one', { serverId: 'home', expectedMetadataRevision: 3, intent: { kind: 'set_plan', entryId: null } }],
      ['session.roles.apply_to_reports', 'one', {}],
    ] as const) {
      const spec = getActionSpec(id);
      const input = { sessionId: { selector: 'workers', of: 'manager-id' }, ...extraInput };
      expect(spec.inputSchema.safeParse(input).success, id).toBe(true);
      const discovered = ActionDiscoveryDefinitionV1Schema.parse(actionSpecToActionDefinitionV1(spec));
      expect(discovered).toMatchObject({ sessionTarget: { field: 'sessionId', cardinality } });
      const validate = compileProtocolJsonSchema(discovered.inputSchema, 'draft-07');
      expect(validate(input), id).toBe(true);
      expect(validate({ ...input, sessionId: { selector: 'workers', of: { selector: 'self' } } }), id).toBe(false);
      expect(validate({ ...input, sessionId: { selector: 'workers', unknownRouting: true } }), id).toBe(false);
      expect(spec.inputSchema.safeParse({ ...extraInput, sessionId: 'existing-id' }).success, id).toBe(true);
    }
  });

  it('publishes closed fanout results with each existing send outcome still validated', () => {
    const result = { kind: 'fanout', results: [
      { target: { serverId: 'home', sessionId: 'worker-a' }, result: { ok: true, result: { status: 'accepted', localId: 'input-a' } } },
      { target: { serverId: 'home', sessionId: 'worker-b' }, result: { ok: false, errorCode: 'denied', error: 'denied' } },
    ] };
    for (const surface of [undefined, 'api', 'plugin'] as const) {
      const spec = getActionSpec('session.message.send');
      const definition = actionSpecToActionDefinitionV1(spec, { surface });
      expect(definition.outputSchema).toBeDefined();
      const validate = compileProtocolJsonSchema(definition.outputSchema!, 'draft-07');
      expect(validate(result)).toBe(true);
      expect(validate({ ...result, results: [{ ...result.results[0],
        result: { ok: true, result: { status: 'invented', localId: 'input-a' } },
      }] })).toBe(false);
      expect(validate({ ...result, expandedTargets: true })).toBe(false);
    }
  });

  it('targets the Session participant policy without widening participant identity at storage', () => {
    const spec = getActionSpec('discussion.participant.policy.set');
    const input = { discussionId: 'discussion', participant: { kind: 'session', sessionId: { selector: 'self' } }, answerPolicy: 'reads_only' };
    const discovered = ActionDiscoveryDefinitionV1Schema.parse(actionSpecToActionDefinitionV1(spec));
    expect(discovered).toMatchObject({ sessionTarget: { field: 'participant.sessionId', cardinality: 'one' } });
    expect(spec.inputSchema.safeParse(input).success).toBe(true);
    expect(compileProtocolJsonSchema(discovered.inputSchema, 'draft-07')(input)).toBe(true);
    expect(spec.inputSchema.safeParse({ ...input, participant: { kind: 'session', sessionId: { selector: 'self', authority: 'person' } } }).success).toBe(false);
  });

  it('keeps role mutation validation and exact leaf routing behind the shared target declaration', () => {
    const selector = { selector: 'manager' };
    const spec = getActionSpec('session.role.set');
    expect(spec.inputSchema.safeParse({ sessionId: selector }).success).toBe(false);
    expect(spec.inputSchema.safeParse({ sessionId: selector, answersWorkerQuestions: false }).success).toBe(true);
    expect(spec.inputSchema.safeParse({ sessionId: selector, roleId: 'builder', extraAuthority: true }).success).toBe(false);
    expect(RoleActionInputSchemasV1['session.role.set'].safeParse({ sessionId: selector, roleId: 'builder' }).success).toBe(false);
    expect(getActionSpec('roles.list').sessionTarget).toBeUndefined();
    expect(getActionSpec('roles.override.set').sessionTarget).toBeUndefined();
  });

  it('preserves the canonical status result inside strict group discovery output', () => {
    const status = SessionStatusActionResultV1Schema.parse({ session: projectSessionSummaryV1({
      row: { id: 'worker-a', createdAt: 1, updatedAt: 2, active: false, activeAt: 1 },
      metadata: null, encryption: null,
    }) });
    const target = { serverId: 'home', sessionId: 'worker-a' };
    const result = { kind: 'fanout', results: [{ target, result: { ok: true, result: status } }] };
    for (const surface of [undefined, 'api', 'plugin'] as const) {
      const definition = actionSpecToActionDefinitionV1(getActionSpec('session.status.get'), { surface });
      const validate = compileProtocolJsonSchema(definition.outputSchema!, 'draft-07');
      expect(validate(status)).toBe(true);
      expect(validate(result)).toBe(true);
      expect(validate({ ...result, results: [{ target, result: { ok: true, result: {
        session: { id: 'worker-a', createdAt: 'invalid' },
      } } }] })).toBe(false);
      expect(validate({ ...result, expandedTargets: true })).toBe(false);
    }
  });
});
