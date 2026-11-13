import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { compilePluginJsonSchema } from '@happier-dev/plugin-sdk/manifest';
import { ACTION_IDS } from '@happier-dev/protocol/actions/actionIds';
import { listVoiceToolActionSpecs } from '@happier-dev/protocol/actions/actionSpecs';
import { forEachJsonSchemaChild, type JsonSchemaObject } from '@happier-dev/protocol/actions/actionInputJsonSchema';
import type { VoiceClientToolDefinition } from '@happier-dev/plugin-sdk/voice/client';
import { createOpenAiToolSessionUpdate } from '@happier-dev/plugins-openai/ui/voice';
import { createXaiSessionUpdate } from '@happier-dev/plugins-xai/ui/voice';
import { XaiRealtimeSettingsV1Schema } from '@happier-dev/plugins-xai/protocol/voice';
import { ELEVENLABS_VOICE_PROVIDER_DEFAULT_SETTINGS } from '@happier-dev/plugins-elevenlabs/protocol/voice';

import { storage } from '@/sync/domains/state/storage';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { provisionElevenLabsWithAccountOperations } from '../../../../../packages/plugins/elevenlabs/src/ui/voice/operations';
import elevenLabsVendorSchema from '../../../../../packages/plugins/elevenlabs/src/ui/voice/fixtures/tools.openapi.json';

import { createBundledConversationRuntimeHostLease } from './bundledConversationRuntimeHost';

vi.mock('socket.io-client', async original =>
  (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(original));
await loadSyncSingletonForTests();

const actionIds = new Set<string>(ACTION_IDS);
const utf8Bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;

function advertisesFullGrammar(schema: JsonSchemaObject): boolean {
  if (schema.definitions !== undefined || schema.$defs !== undefined) return true;
  if (Array.isArray(schema.enum) && schema.enum.length === actionIds.size
    && schema.enum.every(id => typeof id === 'string' && actionIds.has(id))) return true;
  let found = false;
  forEachJsonSchemaChild(schema, child => {
    if (child && typeof child === 'object' && !Array.isArray(child)) {
      found ||= advertisesFullGrammar(child as JsonSchemaObject);
    }
  });
  return found;
}

async function measureElevenLabs(tools: readonly VoiceClientToolDefinition[]) {
  const requests: unknown[] = [];
  const validateTool = compilePluginJsonSchema(elevenLabsVendorSchema);
  let agent: Record<string, unknown> = {};
  await provisionElevenLabsWithAccountOperations({
    // The vendor account-operation boundary echoes real provisioning writes;
    // host projection, provider conversion, and vendor schema validation stay real.
    accountOperations: { request: async ({ operationId, parameters }) => {
      let response: unknown;
      // This external-operation fixture receives JSON records authored by the real provider.
      const body = parameters.body && typeof parameters.body === 'object' && !Array.isArray(parameters.body)
        ? parameters.body as Readonly<Record<string, unknown>> : null;
      if (operationId === 'voices') {
        response = { voices: [{ voice_id: ELEVENLABS_VOICE_PROVIDER_DEFAULT_SETTINGS.tts.voiceId }] };
      } else if (operationId === 'create-tool') {
        if (!body) throw new Error('Missing tool provisioning body');
        expect(validateTool(body.tool_config)).toBe(true);
        requests.push(body);
        response = { id: `tool_advertisement_${requests.length}` };
      } else if (operationId === 'create-agent') {
        if (!body) throw new Error('Missing agent provisioning body');
        agent = { ...body, agent_id: 'agent_advertisement' };
        response = { agent_id: 'agent_advertisement' };
      } else if (operationId === 'agent') {
        response = agent;
      } else {
        throw new Error(`Unexpected offline vendor operation: ${operationId}`);
      }
      return { status: 200, finalUrl: 'https://api.elevenlabs.io/v1/convai/tools', headers: {},
        body: new TextEncoder().encode(JSON.stringify(response)) };
    } },
    request: { kind: 'create', prompt: 'Offline advertisement contract',
      tools: tools.map(({ name, description, parameters }) => ({ name, description, parameters })),
      tts: ELEVENLABS_VOICE_PROVIDER_DEFAULT_SETTINGS.tts },
    signal: new AbortController().signal,
  });
  return { count: requests.length, bytes: utf8Bytes(requests) };
}

// Reproduced at 471 Voice Actions: these were the actual outgoing descriptor
// arrays before named grammar and the complete Action-id enum moved to discovery.
const families = [
  { family: 'OpenAI', previousBytes: 257_298,
    measure: async (tools: readonly VoiceClientToolDefinition[]) => {
      const update = createOpenAiToolSessionUpdate(tools) as { session: { tools: unknown[] } };
      return { count: update.session.tools.length, bytes: utf8Bytes(update.session.tools) };
    } },
  { family: 'xAI', previousBytes: 298_592,
    measure: async (tools: readonly VoiceClientToolDefinition[]) => {
      const update = createXaiSessionUpdate(XaiRealtimeSettingsV1Schema.parse({}), tools) as { session: { tools: unknown[] } };
      return { count: update.session.tools.length, bytes: utf8Bytes(update.session.tools) };
    } },
  { family: 'ElevenLabs', previousBytes: 317_099, measure: measureElevenLabs },
] as const;

describe('realtime Voice tool advertisement cost', () => {
  let previousSettings: ReturnType<typeof storage.getState>['settings'];

  beforeEach(() => {
    previousSettings = storage.getState().settings;
    storage.setState(current => ({ ...current, settings: { ...current.settings, experiments: true,
      featureToggles: { ...current.settings.featureToggles, voice: true },
      voice: { ...current.settings.voice, privacy: { ...current.settings.voice.privacy,
        currentUiContextMode: 'on_demand', shareDeviceInventory: true } } } }));
  });

  afterEach(() => {
    storage.setState(current => ({ ...current, settings: previousSettings }));
  });

  it.each(families)('keeps $family descriptors compact through sectioned discovery', async ({ family, measure, previousBytes }) => {
    expect(listVoiceToolActionSpecs().length).toBeGreaterThanOrEqual(471);
    const lease = createBundledConversationRuntimeHostLease();
    try {
      const tools = lease.host.getRealtimeClientToolDefinitions({ exposure: 'voice_assistant' });
      expect(tools.some(tool => advertisesFullGrammar(tool.parameters))).toBe(false);
      const advertisement = await measure(tools);
      expect(advertisement.count).toBe(31);
      expect(advertisement.bytes).toBeLessThan(previousBytes);
      console.info(JSON.stringify({ family, ...advertisement }));
    } finally {
      lease.revoke();
    }
  });
});
