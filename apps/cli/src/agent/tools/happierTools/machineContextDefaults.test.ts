import { describe, expect, it } from 'vitest';
import { createActionExecutor, listActionSpecs } from '@happier-dev/protocol';
import { zodSchemaToJsonSchemaObject } from '@happier-dev/protocol/actions/actionInputJsonSchema';
import { bindContextualActionToolInput, projectSessionBoundActionToolInputSchema } from './actionToolContext';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { createActionToolExecutorBridge } from './createActionToolExecutorBridge';

describe('Session Machine defaults through the agent tool surface', () => {
  it('advertises and binds required Machine operands throughout the agent/MCP catalog without narrowing optional filters or destinations', () => {
    const context = { defaultSessionId: 'session', defaultSessionMachineId: 'session-machine' };
    for (const spec of listActionSpecs()) {
      if (!spec.surfaces.agent && !spec.surfaces.mcp) continue;
      const schema = zodSchemaToJsonSchemaObject(spec.inputSchema);
      if (Array.isArray(schema.required) && schema.required.includes('machineId')) {
        expect(bindContextualActionToolInput({ actionId: spec.id, input: {}, context }), spec.id)
          .toMatchObject({ machineId: 'session-machine' });
        const projected = projectSessionBoundActionToolInputSchema({ actionId: spec.id, inputSchema: spec.inputSchema, context });
        const toolSchema = zodSchemaToJsonSchemaObject(projected as typeof spec.inputSchema);
        expect(toolSchema.required ?? [], spec.id).not.toContain('machineId');
      }
    }
    expect(bindContextualActionToolInput({ actionId: 'workflow.run.list', input: {}, context })).toEqual({});
    expect(bindContextualActionToolInput({ actionId: 'workspace.sync.relationship.create', input: {}, context })).toEqual({});
    expect(bindContextualActionToolInput({ actionId: 'session.handoff', input: {}, context }))
      .toEqual({ sessionId: 'session' });
  });
  it.each(['agent', 'mcp'] as const)('%s binds omitted targets before ordinary admission and preserves explicit targets and refusals', async surface => {
    const targets: unknown[] = [];
    let refused = false;
    // Machine RPC is the boundary; binding, schema validation and admission stay real.
    const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(),
      machineVitalsAction: async ({ input }) => {
        targets.push(input);
        if (refused) return { ok: false, errorCode: 'permission_denied', error: 'permission_denied' };
        return { state: 'reporting', sample: null, series5m: { cpu: [], memory: [], networkRx: [], networkTx: [] } };
      },
    });
    const bridge = (machineId?: string) => createActionToolExecutorBridge({ surface,
      defaultSessionMachineId: machineId, executor,
    });
    for (const toolName of surface === 'agent' ? ['action_execute', 'machines_vitals_get'] : ['action_execute']) {
      const invoke = (machineId: string | undefined, input: unknown) => bridge(machineId).executeActionByToolName(
        toolName, toolName === 'action_execute' ? { actionId: 'machines.vitals.get', input } : input, 'invoking-session');
      const defaulted = await invoke('session-machine', {});
      expect(defaulted, JSON.stringify(defaulted)).toMatchObject({ ok: true });
      expect(targets.at(-1)).toMatchObject({ machineId: 'session-machine' });
      expect(await invoke('session-machine', { machineId: 'explicit-machine' })).toMatchObject({ ok: true });
      expect(targets.at(-1)).toMatchObject({ machineId: 'explicit-machine' });
      const before = targets.length;
      expect(await invoke(undefined, {})).toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
      expect(targets).toHaveLength(before);
      refused = true;
      const denied = { ok: false, errorCode: 'permission_denied', error: 'permission_denied' };
      expect(await invoke('session-machine', {})).toMatchObject(denied);
      expect(await invoke('session-machine', { machineId: 'explicit-machine' })).toMatchObject(denied);
      refused = false;
    }
  });
});
