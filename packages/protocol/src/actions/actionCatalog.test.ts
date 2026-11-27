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
import { DEPLOYMENT_DEPLOY_ACTION_ID_V1, DEPLOYMENT_ENVIRONMENT_LIST_ACTION_ID_V1, DEPLOYMENT_TEMPLATE_INSTANTIATE_ACTION_ID_V1 } from '../deployments/deploymentActionIdsV1.js';
import { zodSchemaToJsonSchemaObject } from './actionInputJsonSchema.js';
import { prepareExternalActionResponseEnvelopeV1 } from './externalActionApi.js';
import { compileProtocolJsonSchema } from '../plugins/actions/jsonSchemaCompiler.js';
import { createActionExecutor } from './actionExecutor.js';
import { ActionDiscoveryDefinitionSummaryV1Schema } from './actionDefinitionV1.js';
import { NOTIFICATION_NOTIFY_ME_ACTION_ID } from './notificationConfigurationActionIds.js';
import { TEAM_POLICY_SET_ACTION_ID_V1 } from '../teams/actionIdsV1.js';
import { resolveActionApprovalRouting } from './actionApprovalPolicy.js';
import {
  DATABASE_STATEMENT_RUN_ACTION_ID_V1, DATABASE_TARGETS_FORGET_ACTION_ID_V1, DATABASE_ACCESS_SET_ACTION_ID_V1,
  DATABASE_TARGETS_CONNECT_ACTION_ID_V1, DATABASE_ROWS_EXPORT_DOWNLOAD_ACTION_ID_V1,
} from './actionIdsDatabaseV1.js';

describe('actionCatalog action-definition adapter', () => {
  it('publishes the implicit Notify destination and explains it to Workflow authors', async () => {
    const id = NOTIFICATION_NOTIFY_ME_ACTION_ID;
    const result = await createActionExecutor({}).execute('action.spec.get', { id, includeOutputSchema: false },
      { surface: 'agent', authority: 'present_user' });
    expect(result).toMatchObject({ ok: true, result: { actionSpec: {
      id,
      description: expect.stringMatching(/omit.*channels.*Account.*delivery default/i),
      inputHints: { fields: expect.arrayContaining([
        expect.objectContaining({ path: 'channels', unsetLabel: 'Your delivery default' }),
      ]) },
    } } });
  });

  it.each([
    { id: DATABASE_STATEMENT_RUN_ACTION_ID_V1, scope: 'environment' as const, kinds: ['environment', 'database', 'approvalProfile'] },
    { id: DATABASE_TARGETS_FORGET_ACTION_ID_V1, scope: undefined, kinds: ['database', 'approvalProfile'] },
    { id: DATABASE_ACCESS_SET_ACTION_ID_V1, scope: undefined, kinds: ['database', 'approvalProfile'] },
    { id: DATABASE_TARGETS_CONNECT_ACTION_ID_V1, scope: undefined, kinds: ['approvalProfile'] },
    { id: DATABASE_ROWS_EXPORT_DOWNLOAD_ACTION_ID_V1, scope: undefined, kinds: ['approvalProfile'] },
  ])('publishes the canonical existing Database target operand for $id through public discovery', ({ id, scope, kinds }) => {
    const definition: ActionDefinitionV1 = {
      ...actionSpecToActionDefinitionV1(getActionSpec('action.spec.get')),
      id, sideEffectClass: 'external', approvalScope: scope, automation: undefined,
    };
    const primary = kinds.includes('database') ? { kind: 'database', field: 'target' } : undefined;
    const automation = projectActionDefinitionForExternalDiscovery(definition).automation;
    expect(automation).toMatchObject({ subjectKinds: kinds });
    expect(automation?.primarySubject).toEqual(primary);
    const [summary] = searchSerializedActionSpecsForSurface({ surface: 'cli', query: definition.id,
      purpose: 'automation', limit: null, additionalDefinitions: [definition], isActionEnabled: () => false });
    expect(summary.automation).toEqual(automation);
  });

  it.each([
    { scope: 'environment' as const, kinds: ['environment', 'approvalProfile'], primary: undefined },
    { scope: 'healthCheck' as const, kinds: ['healthCheck', 'approvalProfile'], primary: { kind: 'healthCheck', field: 'checkId' } },
    { scope: { kind: 'plugin' as const, subjectKindId: 'ticket', identityField: 'ticketId' },
      kinds: ['plugin', 'approvalProfile'], primary: { kind: 'plugin', field: 'ticketId' } },
    { scope: undefined, kinds: ['approvalProfile'], primary: undefined },
  ])('publishes contributed operand metadata from its existing $scope approval declaration', ({ scope, kinds, primary }) => {
    const definition: ActionDefinitionV1 = {
      ...actionSpecToActionDefinitionV1(getActionSpec('action.spec.get')),
      id: 'example.catalog/actions/resource', sideEffectClass: 'external', approvalScope: scope, automation: undefined,
    };
    const publicDefinition = projectActionDefinitionForExternalDiscovery(definition);
    expect(publicDefinition.automation).toMatchObject({ before: true, after: true, subjectKinds: kinds });
    expect(publicDefinition.automation?.primarySubject).toEqual(primary);
    const [summary] = searchSerializedActionSpecsForSurface({ surface: 'cli', query: definition.id,
      purpose: 'automation', limit: null, additionalDefinitions: [definition], isActionEnabled: () => false });
    expect(summary.automation).toEqual(publicDefinition.automation);
  });

  it('fills operand metadata when a prior catalog projection retained only hook flags', () => {
    const definition: ActionDefinitionV1 = {
      ...actionSpecToActionDefinitionV1(getActionSpec('action.spec.get')),
      id: 'example.catalog/actions/partial', sideEffectClass: 'external', approvalScope: 'healthCheck',
      automation: { before: true, after: true, workflowStep: false },
    };
    expect(projectActionDefinitionForExternalDiscovery(definition).automation).toMatchObject({
      before: true, after: true, workflowStep: true,
      subjectKinds: ['healthCheck', 'approvalProfile'],
      primarySubject: { kind: 'healthCheck', field: 'checkId' },
    });
  });

  it('publishes the Voice spawn model hint through the strict Action summary schema', async () => {
    const id = 'session.spawn_new';
    const context = { surface: 'voice' as const, authority: 'present_user' as const };
    const result = await createActionExecutor({}).execute('action.spec.search', { query: id }, context);
    expect(result).toMatchObject({ ok: true, result: { actionSpecs: expect.arrayContaining([expect.objectContaining({ id })]) } });
    const spawn = ActionDiscoveryDefinitionSummaryV1Schema.parse(projectActionDefinitionSummaryForExternalDiscovery(
      actionSpecToActionDefinitionV1(getActionSpec(id), { surface: 'voice', includeOutputSchema: false }),
    ));
    expect(spawn.inputHints?.fields.filter(field => field.path === 'modelSelection' || field.path.startsWith('modelSelection.')))
      .toMatchObject([{ path: 'modelSelection', optionsSourceId: 'agents.models.available' }]);
  });

  it('finds the Store app installation Action from a plain-word Agent search', async () => {
    const result = await createActionExecutor({}).execute('action.spec.search', { query: 'install Store app', limit: 1 },
      { surface: 'agent', authority: 'present_user' });
    expect(result).toMatchObject({ ok: true, result: { actionSpecs: [{ id: DEPLOYMENT_TEMPLATE_INSTANTIATE_ACTION_ID_V1 }] } });
  });

  it('validates the primary subject pair at the strict discovery boundary', () => {
    const summary = serializeActionSpec(getActionSpec('session.stop'), { includeOutputSchema: false });
    const read = (primarySubject: unknown) => ActionDiscoveryDefinitionSummaryV1Schema.safeParse({
      ...summary, automation: { ...summary.automation, primarySubject },
    });
    expect(read({ kind: 'session', field: 'sessionId' }).success).toBe(true);
    expect(read({ kind: 'unknown', field: 'sessionId' }).success).toBe(false);
    expect(read({ kind: 'session', field: '' }).success).toBe(false);
    expect(read({ kind: 'session', field: 'sessionId', fallback: 'machineId' }).success).toBe(false);
  });

  it.each([
    ['session.stop', 'session', 'sessionId'],
    ['projects.visibility.set', 'project', 'target'],
    ['projects.setup.set', 'project', 'projectRef'],
    ['projects.deploymentDefaults.set', 'app', 'projectSourceId'],
    ['deployments.deploy', 'environment', 'environmentId'],
    ['deployments.backups.run', 'backup', 'environmentId'],
    ['deployments.backups.restore', 'backup', 'environmentId'],
    ['machines.reboot', 'machine', 'machineId'],
    ['machines.services.control', 'machine', 'machineId'],
    ['machines.services.exec', 'machine', 'machineId'],
  ])('reads the declared primary operand for %s through Action search and get', async (id, kind, field) => {
    const executor = createActionExecutor({});
    const context = { surface: 'ui' as const };
    const primarySubject = { kind, field };
    expect(await executor.execute('action.spec.search', { query: id, purpose: 'automation', limit: null }, context))
      .toMatchObject({ ok: true, result: { actionSpecs: expect.arrayContaining([
        expect.objectContaining({ id, automation: expect.objectContaining({ primarySubject }) }),
      ]) } });
    expect(await executor.execute('action.spec.get', { id, includeOutputSchema: false }, context))
      .toMatchObject({ ok: true, result: { actionSpec: { id, automation: { primarySubject } } } });
  });

  it.each(['settings.set', 'deployments.environments.create', 'deployments.templates.instantiate'])(
    'keeps ambient context from becoming a primary operand for %s', async id => {
      const executor = createActionExecutor({});
      const context = { surface: 'ui' as const };
      const result = await executor.execute('action.spec.get', { id, includeOutputSchema: false }, context);
      expect(result).toMatchObject({ ok: true, result: { actionSpec: { id, automation: {
        subjectKinds: expect.arrayContaining(['approvalProfile']),
      } } } });
      expect(result).not.toHaveProperty('result.actionSpec.automation.primarySubject');
    },
  );

  it('enumerates native subject choices through ordinary search and strict discovery without executable operands', () => {
    for (const [id, subjectKinds] of [
      ['projects.visibility.set', ['project', 'approvalProfile']],
      ['projects.deploymentDefaults.set', ['app', 'approvalProfile']],
      ['deployments.backups.run', ['environment', 'backup', 'approvalProfile']],
      ['deployments.backups.restore', ['environment', 'backup', 'database', 'approvalProfile']],
      ['machines.reboot', ['machine', 'approvalProfile']],
      ['machines.services.control', ['machine', 'environment', 'approvalProfile']],
      ['machines.services.exec', ['machine', 'environment', 'approvalProfile']],
      ['deployments.environments.create', ['environment', 'approvalProfile']],
      ['session.stop', ['session', 'project', 'machine', 'approvalProfile']],
      ['settings.set', ['approvalProfile']],
    ] as const) {
      const summary = searchSerializedActionSpecsForSurface({
        surface: 'ui', query: id, purpose: 'automation', limit: null, includeOutputSchema: false,
      }).find(row => row.id === id);
      expect(summary, id).toBeDefined();
      expect(summary?.automation, id).toMatchObject({ before: true, subjectKinds });
      expect(projectActionDefinitionSummaryForExternalDiscovery(summary!), id).toMatchObject({
        automation: { subjectKinds },
      });
      expect(projectActionDefinitionForExternalDiscovery(actionSpecToActionDefinitionV1(getActionSpec(id))), id)
        .toMatchObject({ automation: { subjectKinds } });
    }
  });

  it('returns a complete deliberately demanded catalog beyond ordinary search limits', () => {
    const base = actionSpecToActionDefinitionV1(getActionSpec('action.spec.search'));
    const definitions = Array.from({ length: 201 }, (_, index): ActionDefinitionV1 => ({
      ...base, id: `test.complete/actions/choice-${index}`, title: `Complete choice ${index}`,
    }));
    const search = (limit?: number | null) => searchSerializedActionSpecsForSurface({
      surface: 'ui', includeOutputSchema: false, isActionEnabled: () => false,
      additionalDefinitions: definitions, ...(limit === undefined ? {} : { limit }),
    });
    expect(getActionSpec('action.spec.search').inputSchema.safeParse({ limit: null }).success).toBe(true);
    expect(search(null).map(row => row.id).sort()).toEqual(definitions.map(row => row.id).sort());
    expect(search()).toHaveLength(20);
    expect(search(100)).toHaveLength(100);
  });

  it('publishes hook and Workflow choices consistently to catalog and strict external discovery', () => {
    for (const [id, automation] of [
      ['machines.command.run', { before: true, after: true, workflowStep: true }],
      ['workflow.run.summaries', { before: false, after: false, workflowStep: true }],
      ['ui.current_context.read', { before: false, after: false, workflowStep: false }],
      [DEPLOYMENT_DEPLOY_ACTION_ID_V1, { before: true, after: true, workflowStep: true }],
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
    expect(accountSummary[0]).toMatchObject({ automation: { workflowStep: true } });
    expect(projectActionDefinitionForExternalDiscovery(accountPlugin)).toMatchObject({
      automation: { workflowStep: true },
    });
    const clientPlugin = { ...contributed, executionPlacement: 'client' as const };
    expect(projectActionDefinitionForExternalDiscovery(clientPlugin)).toMatchObject({
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
      .map(spec => ({ ...serializeActionSpec(spec, { surface: 'mcp' }), inputHints: null }));
    for (const query of [undefined, '']) {
      const summaries = searchSerializedActionSpecsForSurface({ surface: 'mcp', query, limit: 2, isActionEnabled, includeOutputSchema: false });
      expect(summaries.map(summary => summary.id)).toEqual(expected.map(definition => definition.id));
      expect(summaries.every(summary => summary.outputSchema === undefined)).toBe(true);
      expect(searchSerializedActionSpecsForSurface({ surface: 'mcp', query, limit: 2, isActionEnabled })).toEqual(expected);
    }
    for (const purpose of ['workflow_step', 'automation'] as const) {
      const [spawn] = searchSerializedActionSpecsForSurface({ surface: 'mcp', query: 'session.spawn_new', limit: 1, purpose });
      expect(spawn?.id).toBe('session.spawn_new');
      expect(spawn?.inputHints?.fields.length).toBeGreaterThan(0);
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

  it('lets Voice discover the same Environment and Backup subject choices as the trigger editor', () => {
    const id = DEPLOYMENT_ENVIRONMENT_LIST_ACTION_ID_V1;
    const [summary] = searchSerializedActionSpecsForSurface({ surface: 'voice', query: id, limit: 1 });
    expect(summary?.id).toBe(id);
    const definition = getActionDefinitionForCatalogSurface({ surface: 'voice', id });
    expect(definition?.bindings?.voiceClientToolName).toBe('deployments_environments_list');
    expect(definition?.sideEffectClass).toBe('read');
  });

  it.each([
    'launch_profiles.read',
    'launch_profiles.search',
    'machines.agents.list',
  ] as const)('exposes the Workflow authoring choice %s to Voice as a read', id => {
    expect(getActionDefinitionForCatalogSurface({ surface: 'voice', id })).toMatchObject({
      sideEffectClass: 'read',
      bindings: { voiceClientToolName: id.replaceAll('.', '_') },
    });
  });

  it.each([
    ['home.policy.set', 'mcp'],
    ['home.policy.set', 'voice'],
    [TEAM_POLICY_SET_ACTION_ID_V1, 'voice'],
    ['session.approval_profile.set', 'voice'],
  ] as const)('exposes approval-profile changes through %s on %s and retains Ask', (id, surface) => {
    const definition = getActionDefinitionForCatalogSurface({ surface, id });
    expect(definition?.id).toBe(id);
    if (surface === 'voice') expect(definition?.bindings?.voiceClientToolName).toBe(id.replaceAll('.', '_'));
    expect(resolveActionApprovalRouting({ actionId: id, spec: getActionSpec(id), input: {},
      context: { surface, authority: 'account_automation' } }).required).toBe(true);
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
      automation: { before: true, after: true, workflowStep: false, subjectKinds: ['approvalProfile'] },
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
