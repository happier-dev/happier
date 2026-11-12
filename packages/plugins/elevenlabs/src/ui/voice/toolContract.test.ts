import { describe, expect, it } from 'vitest';
import { compilePluginJsonSchema } from '@happier-dev/plugin-sdk/manifest';
import { describePluginJsonSchemaValueIssues } from '@happier-dev/protocol/plugins/actions/json-schema-validation';
import { listVoiceToolActionSpecs } from '@happier-dev/protocol/actions/actionSpecs';
import { zodSchemaToJsonSchemaObject } from '@happier-dev/protocol/actions/actionInputJsonSchema';
import vendorSchema from './fixtures/tools.openapi.json';
import recordedCreateTool from './fixtures/tools.create.live.json';
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
  it('replays the real accepted settings tool request and attaches the returned tool to the created agent', async () => {
    let agent: Record<string, unknown> = {};
    // Only the vendor boundary is replaced. The create-tool exchange is recorded;
    // the remaining vendor responses echo the actual provisioning request.
    const result = await provisionElevenLabsWithAccountOperations({
      accountOperations: { request: async ({ operationId, parameters }) => {
        let response: unknown;
        if (operationId === 'voices') response = { voices: [{ voice_id: ELEVENLABS_VOICE_PROVIDER_DEFAULT_SETTINGS.tts.voiceId }] };
        else if (operationId === 'create-tool') {
          expect(parameters.body).toEqual(recordedCreateTool.request);
          response = recordedCreateTool.response.body;
        } else if (operationId === 'create-agent') {
          expect(parameters.body).toMatchObject({ conversation_config: {
            agent: { prompt: { tool_ids: [recordedCreateTool.response.body.id] } },
          } });
          agent = { ...(parameters.body as Record<string, unknown>), agent_id: 'agent_recorded_contract' };
          response = { agent_id: 'agent_recorded_contract' };
        } else if (operationId === 'agent') response = agent;
        else throw new Error(`Unexpected vendor operation: ${operationId}`);
        return { status: recordedCreateTool.response.status, finalUrl: recordedCreateTool.provenance.endpoint,
          headers: {}, body: new TextEncoder().encode(JSON.stringify(response)) };
      } },
      request: { kind: 'create', prompt: 'Happier Voice', tools: [recordedCreateTool.sourceTool],
        tts: ELEVENLABS_VOICE_PROVIDER_DEFAULT_SETTINGS.tts },
      signal: new AbortController().signal,
    });
    expect(result).toMatchObject({ ok: true, agentId: 'agent_recorded_contract' });
  });

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
