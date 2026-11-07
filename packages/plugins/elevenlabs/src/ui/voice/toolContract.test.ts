import { describe, expect, it } from 'vitest';
import { compilePluginJsonSchema } from '@happier-dev/plugin-sdk/manifest';
import { describePluginJsonSchemaValueIssues } from '@happier-dev/protocol/plugins/actions/json-schema-validation';
import { listVoiceToolActionSpecs } from '@happier-dev/protocol/actions/actionSpecs';
import { zodSchemaToJsonSchemaObject } from '@happier-dev/protocol/actions/actionInputJsonSchema';
import vendorSchema from './fixtures/tools.openapi.json';
import { provisionElevenLabsWithAccountOperations } from './operations.js';
import { ELEVENLABS_VOICE_PROVIDER_DEFAULT_SETTINGS } from '../../protocol/voice/index.js';
import { VoiceActionExecuteInputSchema, VOICE_ACTION_EXECUTE_TOOL_NAME } from '@/voice/tools/voiceActionExecution';

// Validation keywords copied from https://api.elevenlabs.io/openapi.json,
// API 1.0, retrieved 2026-11-06; annotation-only fields omitted.
const validateClientTool = compilePluginJsonSchema(vendorSchema);
const catalog = [
  ...listVoiceToolActionSpecs().map(spec => ({ id: spec.id, name: String(spec.bindings?.voiceClientToolName),
    description: spec.description || spec.title, inputSchema: spec.inputSchema })),
  { id: VOICE_ACTION_EXECUTE_TOOL_NAME, name: VOICE_ACTION_EXECUTE_TOOL_NAME,
    description: 'Execute a discovered Voice Action.', inputSchema: VoiceActionExecuteInputSchema },
];

describe('ElevenLabs tool contract', () => {
  it.each(catalog)('provisions the real $id catalog schema accepted by the vendor', async (spec) => {
    let agent: Record<string, unknown> = {};
    let created = false;
    const parameters = zodSchemaToJsonSchemaObject(spec.inputSchema, { reused: 'ref' });
    await provisionElevenLabsWithAccountOperations({
      accountOperations: { request: async ({ operationId, parameters: input }) => {
        const body = input.body as Record<string, unknown> | undefined;
        let result: unknown = {};
        if (operationId === 'voices') result = { voices: [{ voice_id: ELEVENLABS_VOICE_PROVIDER_DEFAULT_SETTINGS.tts.voiceId }] };
        if (operationId === 'create-tool') {
          const config = body?.tool_config as Record<string, unknown>;
          const valid = validateClientTool(config);
          expect(valid, `${spec.id}: ${JSON.stringify(describePluginJsonSchemaValueIssues(validateClientTool))}`).toBe(true);
          expect(config.parameters).toMatchObject({
            type: 'object',
            required: ['arguments_json'],
            properties: { arguments_json: { type: 'string', description: expect.stringContaining(JSON.stringify(parameters)) } },
          });
          created = true;
          result = { id: 'tool_contract' };
        }
        if (operationId === 'create-agent') {
          agent = { ...body, agent_id: 'agent_contract' };
          result = { agent_id: 'agent_contract' };
        }
        if (operationId === 'agent') result = agent;
        return { status: 200, finalUrl: 'https://api.elevenlabs.io/v1/convai/tools', headers: {},
          body: new TextEncoder().encode(JSON.stringify(result)) };
      } },
      request: { kind: 'create', prompt: 'Happier Voice', tools: [{
        name: spec.name, description: spec.description,
        parameters,
      }], tts: ELEVENLABS_VOICE_PROVIDER_DEFAULT_SETTINGS.tts },
      signal: new AbortController().signal,
    });
    expect(created).toBe(true);
  });
});
