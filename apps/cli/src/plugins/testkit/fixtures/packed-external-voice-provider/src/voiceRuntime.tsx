import * as React from 'react';
import type { PluginClientApi } from '@happier-dev/plugin-sdk';
import type {
  RegisteredVoiceProviderRuntime,
  VoiceProviderContribution,
} from '@happier-dev/plugin-sdk/voice';
import type {
  RealtimeVoiceProviderRuntime,
  VoiceClientAuthArtifact,
} from '@happier-dev/plugin-sdk/voice/client';
import type { RenderContext } from '@happier-dev/plugin-sdk/ui';

const MAX_CATALOG_METADATA_PROPERTIES = 32;
const FIXTURE_VOICE_ID = 'packed-voice-primary';
const CONVERSATION_KIND: Extract<VoiceProviderContribution['kind'], 'conversation'> = 'conversation';
const CURRENT_UI_READ_RESPONSE_PREFIX = 'packed-current-ui-read-response-';
const CURRENT_UI_INVOKE_RESPONSE_PREFIX = 'packed-current-ui-invoke-response-';
const fixtureEvents: unknown[] = [];

(
  globalThis as typeof globalThis & {
    __HAPPIER_PACKED_VOICE_FIXTURE_EVENTS__?: unknown[];
  }
).__HAPPIER_PACKED_VOICE_FIXTURE_EVENTS__ = fixtureEvents;

type PackedProviderConfig = Readonly<{
  profile: 'balanced' | 'expressive';
  enableProvisioning: boolean;
}>;

type PackedConversationRuntime = RealtimeVoiceProviderRuntime & Readonly<{
  settingsActions: NonNullable<RegisteredVoiceProviderRuntime['settingsActions']>;
}>;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return isRecord(value) ? value : null;
}

function readBoundedString(value: unknown, maxLength: number): string | null {
  return typeof value === 'string'
    && value.trim() === value
    && value.length > 0
    && value.length <= maxLength
    ? value
    : null;
}

function currentUiReadCallId(responseId: string): string {
  return `${responseId}:read`;
}

function currentUiInvokeCallId(responseId: string): string {
  return `${responseId}:invoke`;
}

function readCurrentUiCommandId(value: unknown): string | null {
  const commands = readRecord(value)?.commands;
  if (!Array.isArray(commands)) return null;
  return readBoundedString(readRecord(commands[0])?.id, 512);
}

function readCurrentUiReadToolResult(value: unknown): Readonly<{
  responseId: string;
  commandId: string;
  entityLabel: string | null;
  commandCount: number;
}> | null {
  const results = readRecord(value)?.results;
  if (!Array.isArray(results)) return null;
  for (const result of results) {
    const record = readRecord(result);
    if (record?.status !== 'success') continue;
    const responseId = readBoundedString(record.responseId, 512);
    const commandId = readCurrentUiCommandId(record.output);
    if (
      !responseId
      || !commandId
      || !responseId.startsWith(CURRENT_UI_READ_RESPONSE_PREFIX)
      || record.callId !== currentUiReadCallId(responseId)
    ) continue;
    const context = readRecord(record.output);
    const commands = context?.commands;
    return {
      responseId,
      commandId,
      entityLabel: readBoundedString(readRecord(context?.entity)?.label, 512),
      commandCount: Array.isArray(commands) ? commands.length : 0,
    };
  }
  return null;
}

function readCurrentUiInvokeToolResult(value: unknown): Readonly<{
  responseId: string;
  result: unknown;
}> | null {
  const results = readRecord(value)?.results;
  if (!Array.isArray(results)) return null;
  for (const result of results) {
    const record = readRecord(result);
    if (record?.status !== 'success') continue;
    const responseId = readBoundedString(record.responseId, 512);
    if (
      !responseId
      || !responseId.startsWith(CURRENT_UI_INVOKE_RESPONSE_PREFIX)
      || record.callId !== currentUiInvokeCallId(responseId)
    ) continue;
    return { responseId, result: record.output };
  }
  return null;
}

function readToolContinuation(value: unknown): string | null {
  const record = readRecord(value);
  return record?.kind === 'fixture_continue'
    ? readBoundedString(record.responseId, 512)
    : null;
}

function isFixtureTextTurn(value: unknown): boolean {
  const record = readRecord(value);
  return record?.kind === 'fixture_text'
    && readBoundedString(record.text, 16_384) !== null;
}

function createToolCallControl(input: Readonly<{
  responseId: string;
  callId: string;
  toolName: 'readCurrentUiContext' | 'invokeCurrentUiCommand';
  arguments: Readonly<Record<string, string>>;
}>) {
  return {
    kind: 'fixture_tool_call' as const,
    responseId: input.responseId,
    callId: input.callId,
    toolName: input.toolName,
    arguments: input.arguments,
  };
}

function decodeToolCallControl(value: unknown) {
  const record = readRecord(value);
  if (record?.kind !== 'fixture_tool_call') return [];
  const responseId = readBoundedString(record.responseId, 512);
  const callId = readBoundedString(record.callId, 512);
  const argumentsRecord = readRecord(record.arguments);
  if (!responseId || !callId || !argumentsRecord) return [];

  if (record.toolName === 'readCurrentUiContext') {
    if (Object.keys(argumentsRecord).length !== 0) return [];
    return [{
      type: 'tool_calls' as const,
      responseId,
      calls: [{
        v: 1 as const,
        responseId,
        callId,
        toolName: 'readCurrentUiContext',
        order: 0,
        arguments: {},
      }],
    }];
  }

  const commandId = record.toolName === 'invokeCurrentUiCommand'
    ? readBoundedString(argumentsRecord.commandId, 512)
    : null;
  if (!commandId || Object.keys(argumentsRecord).length !== 1) return [];
  return [{
    type: 'tool_calls' as const,
    responseId,
    calls: [{
      v: 1 as const,
      responseId,
      callId,
      toolName: 'invokeCurrentUiCommand',
      order: 0,
      arguments: { commandId },
    }],
  }];
}

function readJsonResponse(
  response: Readonly<{ status: number; body: Uint8Array }>,
  errorCode: string,
): unknown {
  if (response.status !== 200) throw new Error(errorCode);
  try {
    return JSON.parse(new TextDecoder().decode(response.body));
  } catch {
    throw new Error(errorCode);
  }
}

function readProviderConfig(value: unknown): PackedProviderConfig {
  const config = readRecord(value);
  if (
    (config?.profile !== 'balanced' && config?.profile !== 'expressive')
    || typeof config.enableProvisioning !== 'boolean'
    || Object.keys(config).some((key) => key !== 'profile' && key !== 'enableProvisioning')
  ) {
    throw new Error('invalid_provider_config');
  }
  return { profile: config.profile, enableProvisioning: config.enableProvisioning };
}

function readCatalog(response: Readonly<{ status: number; body: Uint8Array }>) {
  const wire = readRecord(readJsonResponse(response, 'invalid_voice_catalog'));
  if (!Array.isArray(wire?.voices) || wire.voices.length < 1 || wire.voices.length > 500) {
    throw new Error('invalid_voice_catalog');
  }
  return wire.voices.map((candidate) => {
    const record = readRecord(candidate);
    const id = typeof record?.voice_id === 'string' ? record.voice_id.trim() : '';
    const name = typeof record?.name === 'string' ? record.name.trim() : '';
    if (id.length < 1 || id.length > 256 || name.length < 1 || name.length > 256) {
      throw new Error('invalid_voice_catalog');
    }
    const metadata: Record<string, string> = {};
    if (typeof record?.language === 'string' && record.language.length <= 512) {
      metadata.language = record.language;
    }
    if (Object.keys(metadata).length > MAX_CATALOG_METADATA_PROPERTIES) {
      throw new Error('invalid_voice_catalog');
    }
    return { id, name, metadata };
  });
}

function readProvisioning(
  response: Readonly<{ status: number; body: Uint8Array }>,
  selectedVoiceId: string,
  profile: PackedProviderConfig['profile'],
) {
  const wire = readRecord(readJsonResponse(response, 'invalid_voice_provisioning'));
  if (wire?.provisioned_voice_id !== selectedVoiceId || wire?.profile !== profile) {
    throw new Error('invalid_voice_provisioning');
  }
  return { selectedVoiceId, profile };
}

function readClientAuth(response: Readonly<{ status: number; body: Uint8Array }>): VoiceClientAuthArtifact {
  const wire = readRecord(readJsonResponse(response, 'invalid_voice_client_auth_artifact'));
  const clientSecret = readRecord(wire?.client_secret);
  const value = clientSecret?.value;
  const expiresAtMs = clientSecret?.expires_at_ms;
  if (
    typeof value !== 'string'
    || value.length < 1
    || value.length > 16_384
    || typeof expiresAtMs !== 'number'
    || !Number.isInteger(expiresAtMs)
    || expiresAtMs <= 0
  ) {
    throw new Error('invalid_voice_client_auth_artifact');
  }
  return { kind: 'bearer_token', value, expiresAtMs, placement: 'authorization_header' };
}

function PackedCurrentContextSurface({ context }: Readonly<{ context: RenderContext }>) {
  React.useEffect(() => {
    context.hostApi.publishCurrentUiContext({
      entity: {
        kind: 'voice',
        label: 'Packed Voice current context',
        summary: 'The packed external Voice fixture publishes this mounted semantic context.',
      },
      detail: { source: 'packed-external-voice-provider' },
      commands: [{
        title: 'Open packed current context',
        command: {
          kind: 'executeAction',
          action: 'open-packed-current-context',
        },
      }],
    });
    return () => {
      try {
        context.hostApi.publishCurrentUiContext(null);
      } catch {
        // The mounted surface may already have been retired by its host.
      }
    };
  }, [context.hostApi]);
  return null;
}

export function renderSurface(context: RenderContext): React.ReactElement {
  return React.createElement(PackedCurrentContextSurface, { context });
}

export function activate(api: PluginClientApi): void {
  fixtureEvents.push({ kind: 'activated' });
  api.actions.register('open-packed-current-context', async (_input, context) => {
    context.signal.throwIfAborted();
    fixtureEvents.push({
      kind: 'packed_current_context_action',
      entityLabel: context.currentUiContext?.entity?.label ?? null,
    });
    return { opened: true };
  });
  let activeMediatedInputCapture: Readonly<{ setMuted(muted: boolean): void }> | null = null;
  let activeRawInputCapture: Readonly<{ setMuted(muted: boolean): void }> | null = null;
  const mediatedRuntime: PackedConversationRuntime = {
    kind: CONVERSATION_KIND,
    settingsOperations: {
      async listCatalog(input) {
        readProviderConfig(input.providerConfig);
        if (input.catalog !== 'voices') throw new Error('unsupported_voice_catalog');
        if (!input.credentials.mediated) throw new Error('voice_mediated_credentials_required');
        const catalog = readCatalog(await input.credentials.mediated.request({
          operationId: 'list-voices',
          parameters: {},
          signal: input.signal,
        }));
        fixtureEvents.push({ kind: 'catalog', selectedVoiceId: catalog[0].id });
        return catalog;
      },
    },
    settingsActions: {
      async execute(input, context) {
        if (input.actionId !== 'provision-voice') throw new Error('unsupported_voice_settings_action');
        const providerConfig = readProviderConfig(input.settings);
        if (!providerConfig.enableProvisioning) throw new Error('voice_provisioning_disabled');
        if (!context.credentials.mediated) throw new Error('voice_mediated_credentials_required');
        const provisioning = readProvisioning(
          await context.credentials.mediated.request({
            operationId: 'provision-voice',
            parameters: {
              voiceId: FIXTURE_VOICE_ID,
              body: { profile: providerConfig.profile },
            },
            signal: context.signal,
          }),
          FIXTURE_VOICE_ID,
          providerConfig.profile,
        );
        fixtureEvents.push({ kind: 'provisioned', ...provisioning });
        return { patch: { profile: 'expressive' } };
      },
    },
    protocol: {
      async prepare(input) {
        const providerConfig = readProviderConfig(input.providerConfig);
        if (!input.credentials.mediated) throw new Error('voice_mediated_credentials_required');
        const clientAuth = readClientAuth(await input.credentials.mediated.request({
          operationId: 'client-auth',
          parameters: {
            body: { audience: 'realtime', voiceId: FIXTURE_VOICE_ID },
          },
          signal: input.signal,
        }));
        fixtureEvents.push({
          kind: 'client_auth',
          artifact: {
            kind: clientAuth.kind,
            expiresAtMs: clientAuth.expiresAtMs,
            placement: clientAuth.placement,
          },
          selectedVoiceId: FIXTURE_VOICE_ID,
        });
        fixtureEvents.push({ kind: 'prepared', profile: providerConfig.profile });
        return {
          kind: 'prepared',
          session: {
            config: {
              selectedVoiceId: FIXTURE_VOICE_ID,
              profile: providerConfig.profile,
              clientAuth,
            },
            safeMetadata: {
              selectedVoiceId: FIXTURE_VOICE_ID,
              profile: providerConfig.profile,
            },
          },
        };
      },
      decodeControl(event) {
        if (readRecord(event)?.kind === 'fixture_tool_call') {
          return decodeToolCallControl(event);
        }
        if (readRecord(event)?.kind === 'fixture_transcript') {
          return [{
            type: 'transcript',
            event: {
              v: 1,
              type: 'voice.transcript.final',
              epoch: 1,
              sequence: 1,
              revision: 1,
              eventId: 'packed-event-1',
              itemId: 'packed-item-1',
              role: 'user',
              text: 'packed provider transcript',
              provenance: 'live',
            },
          }];
        }
        if (readRecord(event)?.kind === 'fixture_output_started') return [{ type: 'assistant_output_started' }];
        return [];
      },
      encodeTurnControl(action) {
        return action === 'cancel_response' ? { kind: 'fixture_cancel' } : null;
      },
    },
    async createConnection(input) {
      const config = readRecord(input.session.config);
      const clientAuth = readRecord(config?.clientAuth);
      if (
        typeof config?.selectedVoiceId !== 'string'
        || typeof config.profile !== 'string'
        || clientAuth?.kind !== 'bearer_token'
        || typeof clientAuth.value !== 'string'
        || !Number.isInteger(clientAuth.expiresAtMs)
        || clientAuth.placement !== 'authorization_header'
      ) {
        throw new Error('invalid_prepared_voice_session');
      }
      let emitControl: ((event: unknown) => void) | null = null;
      let nextCurrentUiResponse = 0;
      const pendingCurrentUiCommands = new Map<string, string>();
      const inputCapture = Object.freeze({
        setMuted(muted: boolean) {
          fixtureEvents.push({ kind: 'mediated_input_muted', muted });
        },
      });
      activeMediatedInputCapture = inputCapture;
      const emitCurrentUiRead = (): void => {
        if (!emitControl) return;
        const responseId = `${CURRENT_UI_READ_RESPONSE_PREFIX}${++nextCurrentUiResponse}`;
        // Effectful Actions travel through canonical provider tool calls so
        // the host owns authorization, settlement, cancellation, and replay.
        emitControl(createToolCallControl({
          responseId,
          callId: currentUiReadCallId(responseId),
          toolName: 'readCurrentUiContext',
          arguments: {},
        }));
      };
      fixtureEvents.push({ kind: 'connection_created' });
      return input.media.createSdkHandleConnection({
        driver: {
          async open({ signal, onControl }) {
            signal.throwIfAborted();
            emitControl = onControl;
            fixtureEvents.push({ kind: 'host_media_opened' });
            emitCurrentUiRead();
            onControl({ kind: 'fixture_transcript' });
            onControl({ kind: 'fixture_output_started' });
          },
          async sendControl(event) {
            if (input.signal.aborted || !emitControl) return;
            fixtureEvents.push({ kind: 'sent', event });
            if (isFixtureTextTurn(event)) {
              emitCurrentUiRead();
              return;
            }
            const currentUiRead = readCurrentUiReadToolResult(event);
            if (currentUiRead) {
              pendingCurrentUiCommands.set(currentUiRead.responseId, currentUiRead.commandId);
              fixtureEvents.push({
                kind: 'current_ui_context_read',
                entityLabel: currentUiRead.entityLabel,
                commandCount: currentUiRead.commandCount,
              });
              return;
            }
            const currentUiInvoke = readCurrentUiInvokeToolResult(event);
            if (currentUiInvoke) {
              fixtureEvents.push({
                kind: 'current_ui_context_invoked',
                result: currentUiInvoke.result,
              });
              return;
            }
            const responseId = readToolContinuation(event);
            if (!responseId) return;
            const commandId = pendingCurrentUiCommands.get(responseId);
            if (!commandId) return;
            pendingCurrentUiCommands.delete(responseId);
            const invokeResponseId = responseId.replace(
              CURRENT_UI_READ_RESPONSE_PREFIX,
              CURRENT_UI_INVOKE_RESPONSE_PREFIX,
            );
            if (invokeResponseId === responseId) return;
            emitControl(createToolCallControl({
              responseId: invokeResponseId,
              callId: currentUiInvokeCallId(invokeResponseId),
              toolName: 'invokeCurrentUiCommand',
              arguments: { commandId },
            }));
          },
          async close(reason) {
            pendingCurrentUiCommands.clear();
            emitControl = null;
            if (activeMediatedInputCapture === inputCapture) activeMediatedInputCapture = null;
            fixtureEvents.push({ kind: 'closed', reason });
          },
        },
      });
    },
    setInputMuted(muted) {
      const inputCapture = activeMediatedInputCapture;
      if (!inputCapture) throw new Error('fixture_provider_input_capture_unavailable');
      inputCapture.setMuted(muted);
    },
    encodeToolResults(results) {
      return [{ kind: 'fixture_tool_results', results }];
    },
    encodeToolContinuation(responseId) {
      return { kind: 'fixture_continue', responseId };
    },
    encodeContextUpdate(text) {
      return [{ kind: 'fixture_context', text }];
    },
    encodeTextTurn(text) {
      return [{ kind: 'fixture_text', text }];
    },
    async dispose() {
      fixtureEvents.push({ kind: 'runtime_disposed' });
    },
    microphoneMode: 'provider_managed',
  };
  api.voiceProviders.register('conversation-mediated', mediatedRuntime);
  const rawRuntime: RealtimeVoiceProviderRuntime = {
    kind: CONVERSATION_KIND,
    protocol: {
      async prepare(input) {
        input.signal.throwIfAborted();
        return { kind: 'prepared', session: { config: {}, safeMetadata: {} } };
      },
      decodeControl() {
        return [];
      },
      encodeTurnControl() {
        return null;
      },
    },
    async createConnection(input) {
      if (!input.credentials.raw) throw new Error('voice_raw_credentials_required');
      await input.credentials.raw.materialize({
        kind: 'httpHeaders',
        origin: 'https://voice.example.test',
        headerNames: ['authorization'],
      }, { signal: input.signal });
      input.signal.throwIfAborted();
      fixtureEvents.push({ kind: 'raw_connection_authorized' });
      const inputCapture = Object.freeze({
        setMuted(muted: boolean) {
          fixtureEvents.push({ kind: 'raw_input_muted', muted });
        },
      });
      activeRawInputCapture = inputCapture;
      return input.media.createSdkHandleConnection({
        driver: {
          async open() {
            fixtureEvents.push({ kind: 'raw_connection_opened' });
          },
          async sendControl(event) {
            fixtureEvents.push({ kind: 'raw_sent', event });
          },
          async close(reason) {
            if (activeRawInputCapture === inputCapture) activeRawInputCapture = null;
            fixtureEvents.push({ kind: 'raw_closed', reason });
          },
        },
      });
    },
    encodeToolResults() {
      return [];
    },
    encodeToolContinuation() {
      return {};
    },
    encodeContextUpdate() {
      return [];
    },
    encodeTextTurn() {
      return [];
    },
    outputLevelMeter: 'unavailable',
    microphoneMode: 'provider_managed',
    setInputMuted(muted) {
      const inputCapture = activeRawInputCapture;
      if (!inputCapture) throw new Error('fixture_provider_input_capture_unavailable');
      inputCapture.setMuted(muted);
    },
  };
  api.voiceProviders.register('conversation-raw', rawRuntime);
}
