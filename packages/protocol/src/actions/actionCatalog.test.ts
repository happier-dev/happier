import { beforeEach, describe, expect, it } from 'vitest';

import {
  type ActionDefinitionV1,
  type ActionSpec,
  actionSpecToActionDefinitionV1,
  getActionDefinitionForCatalogSurface,
  getActionSpec,
  listActionSpecs,
  listActionDefinitionsForCatalogSurface,
  listActionSpecsForCatalogSurface,
  searchSerializedActionSpecsForSurface,
  searchSerializedActionSpecs,
  serializeActionSpec,
  SerializedActionDefinitionV1Schema,
} from '../index.js';
import { z } from 'zod/mini';
import { filterResolvedActionOptions, projectActionDefinitionForExternalDiscovery, projectActionDefinitionSummaryForExternalDiscovery } from './actionCatalog.js';
import { DEPLOYMENT_DEPLOY_ACTION_ID_V1 } from '../deployments/deploymentActionIdsV1.js';
import { zodSchemaToJsonSchemaObject } from './actionInputJsonSchema.js';
import { prepareExternalActionResponseEnvelopeV1 } from './externalActionApi.js';
import { compileProtocolJsonSchema } from '../plugins/actions/jsonSchemaCompiler.js';

describe('actionCatalog action-definition adapter', () => {
  it('publishes hook and Workflow choices consistently to catalog and strict external discovery', () => {
    for (const [id, automation] of [
      ['machines.command.run', { before: true, after: true, workflowStep: true }],
      ['workflow.run.summaries', { before: false, after: false, workflowStep: true }],
      ['ui.current_context.read', { before: false, after: false, workflowStep: false }],
      [DEPLOYMENT_DEPLOY_ACTION_ID_V1, { before: true, after: false, workflowStep: true }],
    ] as const) {
      const summary = serializeActionSpec(getActionSpec(id), { includeOutputSchema: false });
      expect(summary, id).toMatchObject({ automation });
      expect(projectActionDefinitionSummaryForExternalDiscovery(summary), id).toMatchObject({ automation });
    }

    const contributed: ActionDefinitionV1 = {
      ...actionSpecToActionDefinitionV1(getActionSpec('machines.command.run')),
      id: 'test.automation/actions/contributed',
      title: 'Contributed automation choice',
      sideEffectClass: 'read',
    };
    const contributedSummary = searchSerializedActionSpecsForSurface({
      surface: 'agent', query: contributed.id, includeOutputSchema: false,
      isActionEnabled: () => false, additionalDefinitions: [contributed],
    });
    expect(contributedSummary).toHaveLength(1);
    expect(contributedSummary[0]).toMatchObject({
      automation: { before: false, after: false, workflowStep: true },
    });
    expect(projectActionDefinitionForExternalDiscovery(contributed)).toMatchObject({
      automation: { before: false, after: false, workflowStep: true },
    });
    const workflowNamedPlugin = { ...contributed, id: 'workflow.run.example/actions/read' };
    expect(searchSerializedActionSpecsForSurface({
      surface: 'agent', query: workflowNamedPlugin.id, includeOutputSchema: false,
      isActionEnabled: () => false, additionalDefinitions: [workflowNamedPlugin],
    })[0]).toMatchObject({ automation: { workflowStep: true } });
    expect(projectActionDefinitionForExternalDiscovery(workflowNamedPlugin)).toMatchObject({
      automation: { workflowStep: true },
    });
    const accountPlugin = { ...contributed, executionPlacement: 'account' as const };
    const accountSummary = searchSerializedActionSpecsForSurface({
      surface: 'agent', query: accountPlugin.id, includeOutputSchema: false,
      isActionEnabled: () => false, additionalDefinitions: [accountPlugin],
    });
    expect(accountSummary[0]).toMatchObject({ automation: { workflowStep: false } });
    expect(projectActionDefinitionForExternalDiscovery(accountPlugin)).toMatchObject({
      automation: { workflowStep: false },
    });
    expect(serializeActionSpec(getActionSpec('wait'), { includeOutputSchema: false })).toMatchObject({
      executionPlacement: 'account', automation: { workflowStep: true },
    });
  });

  it('admits a deliberate 201-row option projection through the canonical Action schema', () => {
    expect(getActionSpec('action.options.resolve').inputSchema.safeParse({
      optionsSourceId: 'machines.available', limit: 201,
    }).success).toBe(true);
  });

  it('preserves complete options and honors deliberate 201-row projections after filtering', () => {
    const options = Array.from({ length: 202 }, (_, index) => ({ value: `machine-${index}`, label: `Machine ${index}` }));
    expect(filterResolvedActionOptions(options)).toHaveLength(202);
    expect(filterResolvedActionOptions(options, { query: 'Machine', limit: 201 })).toHaveLength(201);
    expect(filterResolvedActionOptions(options, { query: 'Machine 1', limit: 2 })).toEqual([
      { value: 'machine-1', label: 'Machine 1' }, { value: 'machine-10', label: 'Machine 10' },
    ]);
  });

  it('publishes the seeded Surprise me operand to agent and MCP discovery and admits it as concrete art', () => {
    const input = { sessionId: 'bot-surprise', face: { style: 'solid', shape: { generate: 'surprise', seed: 17 } } };
    for (const surface of ['agent', 'mcp'] as const) {
      const definition = getActionDefinitionForCatalogSurface({ id: 'session.bot.face.set', surface })!;
      const publishedSchema = JSON.stringify(definition.inputSchema);
      expect(publishedSchema).toContain('8%');
      expect(publishedSchema).toContain('quiet and needsYou');
      expect(publishedSchema).toContain('signed distance <= 0');
      const validate = compileProtocolJsonSchema(definition.inputSchema, 'draft-07');
      expect(validate(input)).toBe(true);
      expect(validate({ ...input, face: { ...input.face, shape: { generate: 'other', seed: 17 } } })).toBe(false);
      expect(getActionSpec('session.bot.face.set').inputSchema.parse(input)).toMatchObject({
        face: { style: 'solid', shape: { v: 1, origin: 'surprise' } },
      });
    }
  });

  it.each(['agent', 'mcp'] as const)('publishes revision-free draft inputs and hints to %s while retaining UI snapshot CAS', surface => {
    const spec = getActionSpec('template.draft');
    const input = { sourceSessionRef: { serverId: 'home', sessionId: 'bot' }, content: {
      v: 1, identity: { name: 'Helper', description: '' }, instructions: { markdown: 'Help.' },
      memoryRules: [], skills: [], needs: { software: [], connectedAccounts: [], mcpServers: [] },
    } };
    const reviewed = { ...input, expectedRevision: { headerVersion: 1, bodyVersion: 1 } };
    const definition = getActionDefinitionForCatalogSurface({ id: 'template.draft', surface })!;
    const validate = compileProtocolJsonSchema(definition.inputSchema, 'draft-07');
    expect(validate(input)).toBe(true);
    expect(validate(reviewed)).toBe(false);
    expect(definition.inputHints?.fields.some(field => field.path === 'expectedRevision')).toBe(false);
    const ui = actionSpecToActionDefinitionV1(spec, { surface: 'ui' });
    expect(compileProtocolJsonSchema(ui.inputSchema, 'draft-07')(reviewed)).toBe(true);
  });
  it.each([
    ['machines.setup.plan', 'sources.0.setup.items.0.selection.ref'],
    ['machines.setup.apply', 'targets.0.sources.0.setup.items.0.selection.ref'],
  ] as const)(
    'publishes setup software choices without overlapping input hints for %s',
    (actionId, path) => {
      const definition = SerializedActionDefinitionV1Schema.parse(actionSpecToActionDefinitionV1(getActionSpec(actionId)));
      expect(definition.inputHints?.fields.filter(field => field.optionsSourceId === 'machines.setup.software.available'))
        .toEqual([expect.objectContaining({ path, widget: 'select' })]);
    },
  );
  it.each([
    ['session.open', { sessionId: `c${'a'.repeat(24)}` }],
    ['ui.voice_global.history.search', {}],
    ['settings.get', { anchor: 'voiceConversations.mode' }],
    ['ui.find', { op: 'read' }],
  ] as const)('admits and advertises exact client choice for %s while preserving domain validation', (id, input) => {
    const spec = getActionSpec(id);
    const selected = { ...input, clientId: 'app-b' };
    const parsed = spec.inputSchema.safeParse(selected);
    expect(parsed, parsed.success ? undefined : JSON.stringify(parsed.error.issues)).toMatchObject({ success: true, data: selected });
    const domainUnknown = spec.clientActionDomainInputSchema!.safeParse({ ...input, extraUnknownField: true }).success;
    expect(spec.inputSchema.safeParse({ ...selected, extraUnknownField: true }).success).toBe(domainUnknown);
    expect(spec.inputSchema.safeParse({ ...input, clientId: '' }).success).toBe(false);
    const definition = actionSpecToActionDefinitionV1(spec);
    const validate = compileProtocolJsonSchema(definition.inputSchema, 'draft-07');
    expect(validate(selected)).toBe(true);
    expect(validate({ ...input, clientId: 123 })).toBe(false);
  });
  it('projects the client selector for every client-routable Action through the single catalog owner', () => {
    for (const spec of listActionSpecs().filter(spec => spec.executionPlacement === 'client'
      || spec.executionPlacements?.includes('client'))) {
      expect(JSON.stringify(actionSpecToActionDefinitionV1(spec).inputSchema), spec.id).toContain('"clientId"');
    }
  });
  it('preserves declared confirmation facts through serialization and strict discovery', () => {
    const spec = { ...getActionSpec('session.delete'), confirmVerb: { key: 'common.delete', fallback: 'Delete' }, irreversible: true as const };
    const definition = actionSpecToActionDefinitionV1(spec);
    expect(SerializedActionDefinitionV1Schema.parse(definition)).toMatchObject({ confirmVerb: spec.confirmVerb, irreversible: true });
    expect(projectActionDefinitionForExternalDiscovery(definition)).toMatchObject({ confirmVerb: spec.confirmVerb, irreversible: true });
    expect(serializeActionSpec(spec)).not.toHaveProperty('hostReviewedChildren');
    expect(definition).not.toHaveProperty('hostReviewedChildren');
  });
  it('offers the existing handoff operation through CLI and Voice with its normal policy', () => {
    for (const surface of ['cli', 'voice'] as const) {
      expect(listActionSpecsForCatalogSurface({ surface }).some(spec => spec.id === 'session.handoff')).toBe(true);
    }
    expect(getActionSpec('session.handoff').safety).toBe('safe');
  });

  // Full-catalog projection is synchronous; let worker-reporting IPC complete
  // between contracts instead of starving it across the entire census.
  beforeEach(() => new Promise<void>(resolve => setImmediate(resolve)));

  it('shares repeated discovery schemas while retaining complete input and output contracts', () => {
    const repeated = z.strictObject({ name: z.string().check(z.minLength(1)) });
    const schema = z.strictObject({ first: repeated, second: repeated, items: z.array(repeated) });
    const spec = { ...getActionSpec('action.spec.get'), inputSchema: schema, outputSchema: schema };
    const definition = actionSpecToActionDefinitionV1(spec);
    const inline = zodSchemaToJsonSchemaObject(schema, { target: 'draft-7' });
    for (const projected of [definition.inputSchema, definition.outputSchema!]) {
      expect(JSON.stringify(projected).length).toBeLessThan(JSON.stringify(inline).length);
      const validate = compileProtocolJsonSchema(projected, 'draft-07');
      expect(validate({ first: { name: 'a' }, second: { name: 'b' }, items: [{ name: 'c' }] })).toBe(true);
      expect(validate({ first: { name: 'a' }, second: { name: '' }, items: [] })).toBe(false);
      expect(validate({ first: { name: 'a' }, second: { name: 'b' }, items: [{ name: 'c', extra: true }] })).toBe(false);
    }
  });

  it.each([
    ['machines.list', 'api'],
    ['session.spawn_new', 'api'],
    ['session.spawn_new', 'cli'],
    ['session.spawn_new', 'mcp'],
  ] as const)('projects %s on %s as strict external JSON', (actionId, surface) => {
    const actionSpec = projectActionDefinitionForExternalDiscovery(
      actionSpecToActionDefinitionV1(getActionSpec(actionId), { surface }),
    );

    const prepared = prepareExternalActionResponseEnvelopeV1({
      v: 1,
      actionId: 'action.spec.get',
      execution: { ok: true, result: { actionSpec } },
    });

    expect(prepared.response.execution).toMatchObject({ ok: true });
    if (actionId === 'session.spawn_new' && surface === 'mcp') {
      expect(actionSpec.inputSchema.properties).not.toHaveProperty('observeSessionCommit');
      expect(actionSpec).not.toHaveProperty('surfaceBindings');
    }
  });

  it('omits unrepresentable optional output metadata without weakening the input contract', () => {
    const spec = { ...getActionSpec('action.spec.get'), outputSchema: z.strictObject({ data: z.custom<unknown>() }) };
    const definition = actionSpecToActionDefinitionV1(spec);
    expect(definition.id).toBe(spec.id);
    expect(definition.inputSchema).toMatchObject({ type: 'object' });
    expect(definition).not.toHaveProperty('outputSchema');
    expect(() => actionSpecToActionDefinitionV1({ ...spec, inputSchema: spec.outputSchema })).toThrow();
  });

  it('builds a serialized action definition with a JSON-schema input contract', () => {
    const definition = actionSpecToActionDefinitionV1(getActionSpec('action.spec.get'));

    expect(definition.kindVersion).toBe(1);
    expect(definition.id).toBe('action.spec.get');
    expect(definition.inputSchema.type).toBe('object');
    expect(definition.inputSchema.properties).toMatchObject({
      id: {
        type: 'string',
      },
    });
    expect(definition).toMatchObject({
      requiredAuthority: 'account_automation',
      executionPlacement: 'account',
    });
  });

  it('projects A.6 action metadata into exported action definitions when present', () => {
    const spec = {
      id: 'action.spec.get',
      title: 'Get action spec',
      description: 'Read one action spec.',
      safety: 'safe',
      approval: { result: 'required' },
      placements: [],
      slash: null,
      bindings: {
        mcpToolName: 'action_spec_get',
        sdkMethod: 'actionSpecGet',
        rpcMethod: 'action.spec.get',
      },
      examples: {
        sdk: {
          codeExample: 'await ctx.actions.actionSpecGet({ id: "session.list" })',
        },
      },
      surfaces: {
        ui: false,
        voice: false,
        agent: true,
        mcp: true,
        cli: false,
        rpc: true,
        api: true,
        plugin: true,
      },
      inputHints: null,
      inputSchema: z.strictObject({ id: z.string() }),
      outputSchema: z.looseObject({ spec: z.unknown() }),
      execution: {
        handler: 'actions.get',
        transport: 'host',
      },
      sideEffectClass: 'read',
      operation: {
        version: 1,
        visibility: 'activity',
        progress: 'indeterminate',
      },
    } satisfies ActionSpec;

    const definition = actionSpecToActionDefinitionV1(spec);

    expect(definition.outputSchema).toEqual(expect.objectContaining({}));
    expect(definition.execution).toEqual(expect.objectContaining({
      handler: 'actions.get',
      transport: 'host',
    }));
    expect(definition.sideEffectClass).toBe('read');
    expect(definition.operation).toEqual({
      version: 1,
      visibility: 'activity',
      progress: 'indeterminate',
    });
    expect(definition.approval).toEqual({ result: 'required' });
    expect(definition.bindings).toEqual(expect.objectContaining({
      mcpToolName: 'action_spec_get',
      sdkMethod: 'actionSpecGet',
      rpcMethod: 'action.spec.get',
    }));
    expect(definition.examples).toEqual(expect.objectContaining({
      sdk: {
        codeExample: 'await ctx.actions.actionSpecGet({ id: "session.list" })',
      },
    }));
  });

  it('declares only the public fork, spawn, and handoff Actions as tracked core operations', () => {
    expect(getActionSpec('session.fork').operation).toEqual({
      version: 1,
      visibility: 'activity',
      progress: 'indeterminate',
      presentation: { onStart: 'current' },
    });
    expect(getActionSpec('session.spawn_new').operation).toEqual({
      version: 1,
      visibility: 'activity',
      progress: 'reported',
      presentation: { onStart: 'current' },
    });
    expect(getActionSpec('session.handoff').operation).toEqual({
      version: 1,
      visibility: 'activity',
      progress: 'reported',
      presentation: { onStart: 'current' },
    });
    expect(getActionSpec('session.handoff.prepare_target').operation).toBeUndefined();
  });

  it('normalizes supported predecessor surfaces at the serialized read seam only', () => {
    const current = actionSpecToActionDefinitionV1(getActionSpec('action.spec.get'));
    const parsed = SerializedActionDefinitionV1Schema.parse({
      ...current,
      surfaces: {
        ui_button: true,
        ui_slash_command: false,
        voice_tool: false,
        voice_action_block: true,
        session_agent: true,
        mcp: true,
        cli: false,
        future_surface: true,
      },
    });

    expect(parsed.surfaces).toEqual({
      ui: true,
      voice: true,
      agent: true,
      mcp: true,
      cli: false,
      rpc: false,
      api: false,
      plugin: false,
    });

    expect(SerializedActionDefinitionV1Schema.safeParse({
      ...current,
      compatibilityExtension: { introducedBy: 'supported-predecessor' },
    }).success).toBe(true);
  });

  it('filters action definitions by surface and enabled predicate', () => {
    const candidates = new Set(['review.start', 'session.mode.set', 'ui.voice_global.reset']);
    const definitions = listActionDefinitionsForCatalogSurface({
      surface: 'cli',
      isActionEnabled: (id) => candidates.has(id) && id !== 'review.start',
    });

    expect(definitions.some((definition) => definition.id === 'review.start')).toBe(false);
    expect(definitions.some((definition) => definition.id === 'session.mode.set')).toBe(true);
    expect(definitions.every((definition) => definition.surfaces.cli === true)).toBe(true);
    expect(definitions.map((definition) => definition.id)).toEqual(['session.mode.set']);
  });

  describe.each(['ui', 'voice', 'agent', 'mcp', 'cli', 'rpc', 'api', 'plugin'] as const)('%s-visible Action census', (surface) => {
    const specs = listActionSpecsForCatalogSurface({ surface });

    it('contains visible Action definitions', () => {
      expect(specs.length).toBeGreaterThan(0);
    });

    // Each contract gets the ordinary test budget and a named failure. A whole
    // surface contains over a thousand independently projected contracts.
    it.each(specs)(`projects every ${surface}-visible Action definition through the canonical schema boundary: $id`, (spec) => {
      const definition = actionSpecToActionDefinitionV1(spec, { surface });
      expect(definition.id).toBe(spec.id);
      const parsed = SerializedActionDefinitionV1Schema.safeParse(JSON.parse(JSON.stringify(definition)));
      expect(parsed.success, `${definition.id}: ${parsed.success ? '' : parsed.error.message}`).toBe(true);
    });
  });

  it('retains the ranked, limited definitions and output schemas for an empty search', () => {
    const ids = new Set(['execution.run.permission.respond', 'action.spec.get', 'session.message.send']);
    const isActionEnabled = (id: string) => ids.has(id);
    const expected = [...listActionSpecsForCatalogSurface({ surface: 'mcp', isActionEnabled })]
      .sort((left, right) => left.title.localeCompare(right.title))
      .slice(0, 2)
      .map(spec => serializeActionSpec(spec, { surface: 'mcp' }));
    for (const query of [undefined, '']) {
      expect(searchSerializedActionSpecsForSurface({ surface: 'mcp', query, limit: 2, isActionEnabled })).toEqual(expected);
    }
  });

  it.each(['agent', 'mcp', 'cli'] as const)('searches the real %s catalog without unrelated schema failures', (surface) => {
    expect(searchSerializedActionSpecsForSurface({
      surface,
      query: 'action.spec.get',
      limit: 1,
    }).map((definition) => definition.id)).toEqual(['action.spec.get']);
    expect(searchSerializedActionSpecsForSurface({
      surface,
      query: 'execution.run.stream.read',
      limit: 1,
    }).map((definition) => definition.id)).toEqual(
      getActionSpec('execution.run.stream.read').surfaces[surface] ? ['execution.run.stream.read'] : [],
    );
  });

  it('keeps an exact title ahead of other Actions covering the same query words', () => {
    const exactTitle = { ...getActionSpec('settings.get'), title: 'Public profile' };
    expect(searchSerializedActionSpecs([getActionSpec('account.public_profile.preview'), exactTitle], {
      query: 'public profile', limit: 1,
    }).map(definition => definition.id)).toEqual(['settings.get']);
  });

  it.each([
    ['read public profile background', 'settings.get'],
    ['change public profile background', 'settings.set'],
    ['switch public profile preset', 'widgets.area.layout.select'],
    ['list public profile layouts', 'widgets.area.layout.list'],
    ['create public profile layout', 'widgets.area.layout.create'],
    ['rename public profile layout', 'widgets.area.layout.rename'],
    ['delete public profile layout', 'widgets.area.layout.delete'],
    ['reorder public profile layouts', 'widgets.area.layout.reorder'],
    ['reset public profile preset', 'widgets.area.layout.reset'],
    ['undo public profile reset', 'widgets.area.layout.undo'],
    ['preview public profile bio links', 'account.public_profile.preview'],
    ['hide public profile tokens field', 'account.public_profile.update'],
    ['change public profile period', 'account.public_profile.update'],
    ['publish public profile draft', 'account.public_profile.publish'],
  ] as const)('finds the existing public profile editing owner for "%s"', (query, actionId) => {
    const results = searchSerializedActionSpecsForSurface({ surface: 'agent', query, limit: 5, includeOutputSchema: false });
    expect(results.map(definition => definition.id), query).toContain(actionId);
  });

  it('finds the read owners for saved workflows, starter templates, eligible events and Home Boards', () => {
    for (const [query, actionId] of [
      ['saved workflows', 'workflow.definition.list'],
      ['starter workflow templates', 'workflow.starters.list'],
      ['eligible trigger events', 'workflow.events.list'],
      ['Home Boards', 'boards.list'],
    ] as const) {
      expect(searchSerializedActionSpecsForSurface({
        surface: 'agent', query, limit: 1,
      }).map((definition) => definition.id), query).toEqual([actionId]);
    }
  });

  it('reuses immutable host projections while evaluating request-current search inputs', () => {
    const hostSpec = getActionSpec('action.spec.get');
    const contributedDefinition = (id: string): ActionDefinitionV1 => ({
      kindVersion: 1,
      id,
      title: id,
      description: null,
      safety: 'safe',
      placements: [],
      slash: null,
      bindings: null,
      examples: null,
      surfaces: {
        ui: false,
        voice: false,
        agent: false,
        mcp: false,
        cli: false,
        rpc: false,
        api: true,
        plugin: false,
      },
      inputHints: null,
      inputSchema: {},
    });

    const firstHostSearch = searchSerializedActionSpecsForSurface({
      surface: 'api',
      query: hostSpec.id,
      isActionEnabled: (id) => id === hostSpec.id,
    });
    const repeatedHostSearch = searchSerializedActionSpecsForSurface({
      surface: 'api',
      query: hostSpec.id,
      isActionEnabled: (id) => id === hostSpec.id,
    });
    const secondHostSearch = searchSerializedActionSpecsForSurface({
      surface: 'api',
      query: hostSpec.id,
      isActionEnabled: () => false,
    });
    const firstContributedSearch = searchSerializedActionSpecsForSurface({
      surface: 'api',
      query: 'fresh-contribution',
      isActionEnabled: (id) => id === hostSpec.id,
      additionalDefinitions: [contributedDefinition('fresh-contribution-one')],
    });
    const secondContributedSearch = searchSerializedActionSpecsForSurface({
      surface: 'api',
      query: 'fresh-contribution',
      isActionEnabled: (id) => id === hostSpec.id,
      additionalDefinitions: [contributedDefinition('fresh-contribution-two')],
    });
    const matchingContribution = (id: string, title: string): ActionDefinitionV1 => ({
      ...contributedDefinition(id),
      title,
      description: hostSpec.id,
    });
    const mixedSearch = searchSerializedActionSpecsForSurface({
      surface: 'api',
      query: hostSpec.id,
      limit: 2,
      isActionEnabled: (id) => id === hostSpec.id,
      additionalDefinitions: [
        matchingContribution('matching-contribution-b', 'B matching contribution'),
        matchingContribution(hostSpec.id, '000 shadowed host'),
        {
          ...matchingContribution('hidden-contribution', '000 hidden contribution'),
          surfaces: { ...hostSpec.surfaces, api: false },
        },
        matchingContribution('matching-contribution-a', 'A matching contribution'),
      ],
    });

    expect(firstHostSearch.map((definition) => definition.id)).toEqual([hostSpec.id]);
    expect(repeatedHostSearch.map((definition) => definition.id)).toEqual([hostSpec.id]);
    expect(secondHostSearch).toEqual([]);
    expect(firstContributedSearch.map((definition) => definition.id)).toEqual(['fresh-contribution-one']);
    expect(secondContributedSearch.map((definition) => definition.id)).toEqual(['fresh-contribution-two']);
    expect(repeatedHostSearch[0]).toBe(firstHostSearch[0]);
    expect(Object.isFrozen(firstHostSearch[0])).toBe(true);
    expect(mixedSearch.map((definition) => definition.id)).toEqual([
      hostSpec.id,
      'matching-contribution-a',
    ]);
    expect(mixedSearch[0]).toBe(firstHostSearch[0]);
  });

  it('projects contributed Action summaries through named public fields', () => {
    const contributed: ActionDefinitionV1 = {
      kindVersion: 1,
      id: 'com.acme.actions/actions/strictprojectionneedle9x',
      title: 'Strictprojectionneedle9x',
      description: null,
      safety: 'safe',
      placements: [],
      slash: null,
      bindings: null,
      examples: null,
      surfaces: {
        ui: false,
        voice: false,
        agent: false,
        mcp: false,
        cli: true,
        rpc: false,
        api: true,
        plugin: false,
      },
      inputHints: null,
      inputSchema: {},
      scopes: ['global'],
      contributionSurfaces: ['cli'],
      availability: undefined,
      hostAccess: undefined,
      priority: undefined,
      dangerLevel: 'safe',
    };

    expect(searchSerializedActionSpecsForSurface({
      surface: 'api',
      query: 'strictprojectionneedle9x',
      additionalDefinitions: [contributed],
    })).toEqual([{
      id: 'com.acme.actions/actions/strictprojectionneedle9x',
      title: 'Strictprojectionneedle9x',
      description: null,
      safety: 'safe',
      placements: [],
      slash: null,
      bindings: null,
      examples: null,
      surfaces: {
        ui: false,
        voice: false,
        agent: false,
        mcp: false,
        cli: true,
        rpc: false,
        api: true,
        plugin: false,
      },
      inputHints: null,
    }]);
  });

  it('preserves strict object semantics in exported input schemas', () => {
    const definition = actionSpecToActionDefinitionV1(getActionSpec('ui.voice_global.reset'));

    expect(definition.inputSchema).toMatchObject({
      type: 'object',
      additionalProperties: false,
    });
  });

  it('projects constrained Action inputs and outputs through the shared catalog', () => {
    const spec: ActionSpec = {
      ...getActionSpec('action.spec.get'),
      inputSchema: z.strictObject({
        label: z.string().check(z.minLength(2), z.maxLength(20), z.regex(/^[a-z-]+$/), z.describe('Action label')),
        attempts: z.number().check(z.minimum(1), z.maximum(3)),
        tags: z.array(z.string()).check(z.minLength(1), z.maxLength(2)),
        mode: z.enum(['safe', 'fast']),
      }).check(z.describe('Constrained action input')),
      outputSchema: z.string().check(z.minLength(2), z.describe('Result text')),
    };

    const definition = actionSpecToActionDefinitionV1(spec);
    const serialized = serializeActionSpec(spec);

    expect(definition.inputSchema).toMatchObject({
      description: 'Constrained action input',
      additionalProperties: false,
    });
    const validate = compileProtocolJsonSchema(definition.inputSchema, 'draft-07');
    const valid = { label: 'valid', attempts: 2, tags: ['tag'], mode: 'safe' };
    expect(validate(valid)).toBe(true);
    for (const invalid of [
      { ...valid, label: 'x' }, { ...valid, label: 'x'.repeat(21) }, { ...valid, label: 'Invalid' },
      { ...valid, attempts: 0 }, { ...valid, attempts: 4 },
      { ...valid, tags: [] }, { ...valid, tags: ['a', 'b', 'c'] },
      { ...valid, mode: 'unknown' }, { ...valid, extra: true },
    ]) expect(validate(invalid)).toBe(false);
    expect(serialized.outputSchema).toMatchObject({
      type: 'string',
      minLength: 2,
      description: 'Result text',
    });
  });

  it('preserves structured Connected Account options without making their identifiers catalog search text', () => {
    const connectedAccountRef = {
      service: { pluginId: 'com.acme.accounts', localId: 'service' },
      accountId: 'account-private-42',
    };
    const spec: ActionSpec = {
      ...getActionSpec('action.spec.get'),
      inputHints: {
        fields: [{
          path: 'id',
          title: 'Selected account',
          widget: 'select',
          options: [{ value: connectedAccountRef, label: 'Account' }],
        }],
      },
    };

    const definition = actionSpecToActionDefinitionV1(spec);
    expect(definition.inputHints?.fields[0]?.options?.[0]?.value).toEqual(connectedAccountRef);
    expect(searchSerializedActionSpecs([spec], { query: 'account-private-42' })).toEqual([]);
    expect(searchSerializedActionSpecs([spec], { query: 'com.acme.accounts' })).toEqual([]);
  });

  it('projects the API output schema through both get and search while retaining the internal output', () => {
    const spec = getActionSpec('session.message.send');
    const apiOutputSchema = spec.surfaceBindings?.api?.outputSchema;
    if (!spec.outputSchema || !apiOutputSchema) throw new Error('Expected internal and API output schemas');

    const apiOutputJsonSchema = zodSchemaToJsonSchemaObject(apiOutputSchema, { target: 'draft-7', reused: 'ref' });
    const internalOutputJsonSchema = zodSchemaToJsonSchemaObject(spec.outputSchema, { target: 'draft-7', reused: 'ref' });
    const apiDefinition = getActionDefinitionForCatalogSurface({
      id: 'session.message.send',
      surface: 'api',
    });
    const [apiSearchResult] = searchSerializedActionSpecsForSurface({
      surface: 'api',
      query: 'session.message.send',
      limit: 1,
    });
    const contributed = { ...actionSpecToActionDefinitionV1(spec, { surface: 'api' }), id: 'example.tools/actions/send-summary' };
    const compact = searchSerializedActionSpecsForSurface({
      surface: 'api', query: 'session.message.send', limit: 2, includeOutputSchema: false,
      isActionEnabled: id => id === spec.id,
      additionalDefinitions: [{ ...contributed, description: 'session.message.send' }],
    });

    expect(apiDefinition?.outputSchema).toEqual(apiOutputJsonSchema);
    expect(apiSearchResult?.id).toBe('session.message.send');
    expect(apiSearchResult?.outputSchema).toEqual(apiOutputJsonSchema);
    expect(compact.map(definition => definition.id)).toEqual([spec.id, contributed.id]);
    for (const definition of compact) expect(Object.hasOwn(definition, 'outputSchema'), definition.id).toBe(false);
    expect(searchSerializedActionSpecsForSurface({ surface: 'api', query: spec.id, limit: 1 })[0]).toBe(apiSearchResult);
    expect(actionSpecToActionDefinitionV1(spec).outputSchema).toEqual(internalOutputJsonSchema);
  });
});
