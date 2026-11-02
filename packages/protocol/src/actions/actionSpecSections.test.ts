import { describe, expect, it, vi } from 'vitest';
import { actionSpecToActionDefinitionV1, freezeWorkflowActionContractV1, projectActionDefinitionForExternalDiscovery } from './actionCatalog.js';
import { getActionSpec, listActionSpecs } from './actionSpecs.js';
import { projectActionSpecSchemaSections, readCompleteActionSpecV1 } from './actionSpecSections.js';
import { freezeActionCompletionContractV1 } from './actionCompletion.js';
import { createActionExecutor } from './actionExecutor.js';

describe('Action schema sections', () => {
  it('reads each complete native Workflow leaf through one CLI Action admission', async () => {
    const executor = createActionExecutor({});
    const leaves = ['machines.setup.apply', 'deployments.deploy'] as const;
    const reads: string[] = [];
    for (const actionId of leaves) {
      const definition = await readCompleteActionSpecV1({ actionId, read: async input => {
        reads.push(input.id);
        const result = await executor.execute('action.spec.get', input, { surface: 'cli' });
        if (!result.ok) throw new Error(result.errorCode);
        return result.result;
      } });
      expect(freezeWorkflowActionContractV1(definition)).toEqual(
        freezeWorkflowActionContractV1(actionSpecToActionDefinitionV1(getActionSpec(actionId), { surface: 'cli' })));
    }
    expect(reads, 'one root execute per distinct native leaf, independent of schema section count').toEqual(leaves);
  });

  it('carries native completion contracts through full sectioned discovery', async () => {
    const spec = getActionSpec('subagents.plan.start');
    const full = projectActionDefinitionForExternalDiscovery(actionSpecToActionDefinitionV1(spec));
    const discovered = await readCompleteActionSpecV1({ actionId: spec.id,
      read: async input => projectActionSpecSchemaSections(full, input.schemaPath) });
    expect(discovered).toHaveProperty('completion', freezeActionCompletionContractV1(spec.completion!));
    expect(freezeWorkflowActionContractV1(discovered)).toEqual({ inputSchema: discovered.inputSchema,
      outputSchema: freezeActionCompletionContractV1(spec.completion!).terminalOutputSchema,
      completion: freezeActionCompletionContractV1(spec.completion!) });
  });

  it('uses the supplied declaration for qualified Actions and keeps ordinary contributed outputs immediate', () => {
    const completion = freezeActionCompletionContractV1(getActionSpec('subagents.plan.start').completion!);
    const definition = projectActionDefinitionForExternalDiscovery({ ...actionSpecToActionDefinitionV1(getActionSpec('action.spec.get')),
      id: 'external.workflow-test/check', inputSchema: { type: 'object' }, outputSchema: { type: 'string' }, completion });
    expect(freezeWorkflowActionContractV1(definition)).toMatchObject({ completion, outputSchema: completion.terminalOutputSchema });
    expect(freezeWorkflowActionContractV1({ outputSchema: { type: 'string' } }))
      .toEqual({ inputSchema: {}, outputSchema: { type: 'string' } });
    expect(freezeWorkflowActionContractV1({ outputSchema: {} , completion: { awaits: 'unknown' } })).toBeNull();
    expect(freezeWorkflowActionContractV1({ inputSchema: {} })).toBeNull();
  });

  it('retrieves independent input and output sections while another section is pending', async () => {
    const base = actionSpecToActionDefinitionV1(getActionSpec('action.spec.get'), { includeOutputSchema: true });
    const definition = projectActionDefinitionForExternalDiscovery({ ...base, id: 'external.workflow-test/check',
      inputSchema: { type: 'object', definitions: { first: { type: 'string' }, second: { type: 'number' } } },
      outputSchema: { type: 'object', definitions: { result: { type: 'boolean' } } },
    });
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const issued = new Set<string>();
    const read = readCompleteActionSpecV1({ actionId: definition.id, read: async input => {
      if (input.schemaPath) issued.add(input.schemaPath);
      if (input.schemaPath === '/inputSchema/definitions/first') await pending;
      return projectActionSpecSchemaSections(definition, input.schemaPath);
    } });
    try {
      await vi.waitFor(() => expect([...issued]).toEqual(expect.arrayContaining([
        '/inputSchema/definitions/first', '/inputSchema/definitions/second', '/outputSchema/definitions/result',
      ])));
    } finally { release(); }
    expect(await read).toEqual(definition);
  });

  it('reassembles real section projections with nested escaped definitions and recursive references unchanged', async () => {
    const base = actionSpecToActionDefinitionV1(getActionSpec('action.spec.get'), { includeOutputSchema: true });
    const definition = projectActionDefinitionForExternalDiscovery({ ...base,
      inputSchema: { type: 'object', $comment: 'Input metadata', definitions: {
        'outer/name': { type: 'object', definitions: { 'inner~name': { type: 'string', minLength: 1 } } },
      } },
      outputSchema: { type: 'object', $comment: 'Output metadata', properties: { result: { $ref: '#/definitions/tree' } },
        definitions: { tree: { type: 'object', properties: { child: { $ref: '#/definitions/tree' } } } } },
    });
    const original = JSON.stringify(definition);
    const result = await readCompleteActionSpecV1({ actionId: definition.id,
      read: async input => projectActionSpecSchemaSections(definition, input.schemaPath),
    });
    expect(result).toEqual(definition);
    expect(JSON.stringify(definition)).toBe(original);
  });

  it('refuses mismatched section identity and retains transport failures and caller cancellation', async () => {
    const base = actionSpecToActionDefinitionV1(getActionSpec('action.spec.get'), { includeOutputSchema: true });
    const definition = projectActionDefinitionForExternalDiscovery({ ...base,
      outputSchema: { $ref: '#/definitions/result', definitions: { result: { type: 'string' } } },
    });
    for (const mismatch of ['root', 'action', 'path', 'missing'] as const) {
      await expect(readCompleteActionSpecV1({ actionId: definition.id, read: async input => {
        if (mismatch === 'root') return projectActionSpecSchemaSections(definition, '/outputSchema/definitions/result');
        const result = projectActionSpecSchemaSections(definition, input.schemaPath);
        if (!input.schemaPath) return result;
        if (mismatch === 'action') return { ...result, actionSpec: { ...result.actionSpec, id: 'foreign.action' } };
        if (mismatch === 'missing') return { ...result, schemaSection: undefined };
        return { ...result, schemaSection: { path: '/outputSchema/definitions/foreign', schema: { type: 'number' } } };
      } })).rejects.toThrow('invalid_action_schema_section');
    }
    const unavailable = new Error('transport_unavailable');
    await expect(readCompleteActionSpecV1({ actionId: definition.id, read: async input => {
      if (input.schemaPath) throw unavailable;
      return projectActionSpecSchemaSections(definition);
    } })).rejects.toBe(unavailable);
    const controller = new AbortController();
    const aborted = new Error('caller_aborted');
    await expect(readCompleteActionSpecV1({ actionId: definition.id, signal: controller.signal, read: async input => {
      const result = projectActionSpecSchemaSections(definition, input.schemaPath);
      if (input.schemaPath) controller.abort(aborted);
      return result;
    } })).rejects.toBe(aborted);
  });

  it('retrieves nested contributed definitions and escaped names without losing schema metadata', () => {
    const base = actionSpecToActionDefinitionV1(getActionSpec('action.spec.get'), { includeOutputSchema: false });
    const nested = { type: 'string', minLength: 1 };
    const definition = { ...base, inputSchema: { type: 'object', $comment: 'Author metadata', definitions: {
      'outer/name': { type: 'object', definitions: { 'inner~name': nested } },
    } } };
    const root = projectActionSpecSchemaSections(definition);
    expect(root.actionSpec.inputSchema.$comment).toBe('Author metadata');
    const outer = projectActionSpecSchemaSections(definition, root.schemaSections[0].path);
    const inner = projectActionSpecSchemaSections(definition, outer.schemaSections[0].path);
    expect(inner.schemaSection?.schema).toEqual(nested);
  });

  it('keeps every widget, Board and Home discovery response below Claude\'s documented foreground character boundary', () => {
    const rows = listActionSpecs().filter(spec => /^(widgets\.|boards\.|session\.board\.|home\.hub\.layout\.)/.test(spec.id)).map(spec => {
      const full = actionSpecToActionDefinitionV1(spec, { surface: 'mcp', includeOutputSchema: true });
      const projected = projectActionSpecSchemaSections(full);
      const sectionSizes = projected.schemaSections.map(section => JSON.stringify(projectActionSpecSchemaSections(full, section.path)).length);
      const size = JSON.stringify(projected).length;
      expect(size, spec.id).toBeLessThan(50000);
      for (const sectionSize of sectionSizes) expect(sectionSize, spec.id).toBeLessThan(50000);
      return { id: spec.id, size, largestSection: Math.max(0, ...sectionSizes) };
    });
    console.info(JSON.stringify({ census: rows }));
  });

  it('retrieves the complete Board grammar as named sections without changing the full schema', () => {
    const spec = actionSpecToActionDefinitionV1(getActionSpec('session.board.item.upsert'), { surface: 'mcp', includeOutputSchema: false });
    const original = JSON.stringify(spec);
    const result = projectActionSpecSchemaSections(spec);
    expect(JSON.stringify(result).length).toBeLessThan(50000);
    expect(result.schemaSections.length).toBeGreaterThan(0);
    const definitions: Record<string, unknown> = {};
    for (const section of result.schemaSections) {
      const read = projectActionSpecSchemaSections(spec, section.path);
      expect(read).toHaveProperty('schemaSection');
      if (!('schemaSection' in read)) throw new Error('Missing section');
      expect(JSON.stringify(read).length).toBeLessThan(50000);
      definitions[section.path.split('/').at(-1)!] = read.schemaSection.schema;
    }
    expect({ ...result.actionSpec.inputSchema, definitions }).toEqual(spec.inputSchema);
    expect(JSON.stringify(spec)).toBe(original);
    expect(() => projectActionSpecSchemaSections(spec, '/inputSchema/__proto__')).toThrow();
    expect(() => projectActionSpecSchemaSections(spec, '/inputSchema/definitions')).toThrow();
  });
});
