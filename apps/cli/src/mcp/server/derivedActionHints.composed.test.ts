import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { ActionInputHintsSchema } from '@happier-dev/protocol';
import { PluginActionContributionV2Schema } from '@happier-dev/protocol/plugins/actions/v2';
import { compilePluginJsonSchema } from '@happier-dev/protocol/plugins/actions/json-schema-validation';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';

import { createActionToolExecutorBridge } from '@/agent/tools/happierTools/createActionToolExecutorBridge';
import { projectPluginActionInputDefinition } from '@/plugins/projection/registry/normalize/actionInput';
import { mcpElicitationFormRequest } from '@/plugins/runtime/invocation/services/mcpElicitationForm';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { prepareHappierMcpToolInventory, registerHappierMcpBuiltInTools } from './registerHappierMcpBuiltInTools';

describe('derived Action hints through MCP discovery and elicitation', () => {
  it('uses an unauthored catalog hint to ask a real MCP client for a schema-valid choice', async () => {
    const declaration = PluginActionContributionV2Schema.parse({
      id: 'configure', title: 'Configure review', scopes: ['global'], surfaces: ['agent', 'mcp'],
      execution: { target: 'daemon' }, dangerLevel: 'safe', tool: { name: 'review_configure' },
      inputSchema: { type: 'object', additionalProperties: false, required: ['mode'],
        properties: { mode: { type: 'string', title: 'Review mode', enum: ['review', 'revise'] } } },
    });
    const definition = projectPluginActionInputDefinition(declaration);
    // This negative control makes dropping the schema at the catalog seam
    // observable without mocking any normalization or elicitation logic.
    expect(projectPluginActionInputDefinition({ ...declaration, inputSchema: undefined }).inputHints).toBeNull();
    expect(definition.inputHints?.fields).toHaveLength(1);
    const server = new McpServer({ name: 'derived-action-hints', version: '1' });
    const bridge = createActionToolExecutorBridge({ surface: 'mcp',
      executor: createActionExecutor(createUnavailableActionTransportDeps()) });
    registerHappierMcpBuiltInTools(server, {
      sessionId: '', surface: 'mcp',
      toolInventory: prepareHappierMcpToolInventory({ sessionId: '', inventory: {
        tools: [{ name: 'review_configure', title: 'Configure review', description: 'Configure review',
          toolId: 'acme.review/configure', actionId: 'acme.review/actions/configure', safety: 'safe',
          inputSchema: definition.inputSchema, inputHints: definition.inputHints }],
        actionToolNameToId: new Map(),
      } }),
      deps: { ...bridge, changeTitle: async () => ({ success: true }),
        resolveActionOptions: args => bridge.resolveActionOptions(args, '') },
    });
    const client = new Client({ name: 'derived-hint-consumer', version: '1' }, { capabilities: { elicitation: { form: {} } } });
    let elicited = false;
    client.setRequestHandler(ElicitRequestSchema, async request => {
      if ('url' in request.params) throw new Error('Expected ordinary form elicitation');
      expect(mcpElicitationFormRequest(request.params.requestedSchema, request.params.message)).toEqual({
        kind: 'questions', title: 'Choose how to review', questions: [{ id: 'mode', prompt: 'Review mode', type: 'singleChoice', required: true,
          choices: [{ id: 'review', label: 'review' }, { id: 'revise', label: 'revise' }] }],
      });
      elicited = true;
      return { action: 'accept', content: { mode: 'revise' } };
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const advertised = (await client.listTools()).tools.find(tool => tool.name === 'review_configure');
      const metadata = advertised?._meta?.['happier.dev/pluginTool'];
      if (!metadata || typeof metadata !== 'object') throw new Error('Expected published Action metadata');
      const hints = ActionInputHintsSchema.parse(Reflect.get(metadata, 'inputHints'));
      const field = hints.fields[0]!;
      expect(field.widget).toBe('select');
      // The requesting agent uses published hints; this does not add automatic
      // Action elicitation or another product-side form/schema converter.
      const result = await server.server.elicitInput({
        mode: 'form', message: 'Choose how to review',
        requestedSchema: { type: 'object', properties: {
          [field.path]: { type: 'string', title: field.title, oneOf: field.options!.map(option => {
            if (typeof option.value !== 'string') throw new Error('Expected a string choice');
            return { const: option.value, title: option.label };
          }) },
        }, ...(field.required ? { required: [field.path] } : {}) },
      });
      expect(elicited).toBe(true);
      expect(result).toMatchObject({ action: 'accept', content: { mode: 'revise' } });
      const validate = compilePluginJsonSchema(declaration.inputSchema!);
      expect(validate(result.content)).toBe(true);
      expect(validate({ mode: 'unlisted' })).toBe(false);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
