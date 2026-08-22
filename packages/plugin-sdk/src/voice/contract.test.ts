import { readFileSync } from 'node:fs';
import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  VoiceCredentialSlotIdSchema as CanonicalVoiceCredentialSlotIdSchema,
  VoiceProviderContributionSchema as CanonicalVoiceProviderContributionSchema,
  type ConnectedAccountHttpHeadersRequest as ProtocolConnectedAccountHttpHeadersRequest,
  type ConnectedAccountMaterializationRequest as ProtocolConnectedAccountMaterializationRequest,
  type PluginContributionLocalId,
} from '@happier-dev/protocol';
import {
  isVoiceSdkSafeActionSpec as canonicalIsVoiceSdkSafeActionSpec,
  listVoiceSdkSafeToolActionSpecs as canonicalListVoiceSdkSafeToolActionSpecs,
} from '@happier-dev/protocol/actions/actionSpecs';
import type { VoiceGuidanceAvailability as CanonicalVoiceGuidanceAvailability } from '@happier-dev/protocol/actions/actionInputVoiceGuidance';
import {
  VoiceRealtimeJsonValueSchema as CanonicalVoiceRealtimeJsonValueSchema,
  type VoiceRealtimeJsonValue as CanonicalVoiceRealtimeJsonValue,
  type VoiceRealtimeToolCallV1,
  type VoiceRealtimeToolResultV1 as CanonicalVoiceRealtimeToolResultV1,
  type VoiceRuntimePlatform as CanonicalVoiceRuntimePlatform,
  type VoiceTranscriptCanonicalEventV1,
  type VoiceTranscriptLadderMapper as CanonicalVoiceTranscriptLadderMapper,
  type VoiceTranscriptLadderMode as CanonicalVoiceTranscriptLadderMode,
  type VoiceTranscriptLadderObservation as CanonicalVoiceTranscriptLadderObservation,
} from '@happier-dev/protocol/voice/realtime';
import type {
  VoiceSpeechOperationContext as ProtocolVoiceSpeechOperationContext,
  VoiceSpeechSynthesizeRequest as ProtocolVoiceSpeechSynthesizeRequest,
  VoiceSpeechSynthesizeResult as ProtocolVoiceSpeechSynthesizeResult,
  VoiceSpeechTranscribeRequest as ProtocolVoiceSpeechTranscribeRequest,
  VoiceSpeechTranscribeResult as ProtocolVoiceSpeechTranscribeResult,
} from '@happier-dev/protocol/voice/speech';
import type { PluginApi } from '../activation.js';
import type {
  PluginVoiceProviderDefinition as DirectPluginVoiceProviderDefinition,
} from '../definePlugin.js';
import type { HttpService } from '../http.js';
import type {
  AgentSessionRealtimeAvailability,
  AgentSessionRealtimeStartInput,
  AgentSessionRealtimeStartResult,
} from '../experimental/agentRuntime/realtime.js';
import type { InteractionsService } from '../interactions.js';
import type { PluginRegistrationValueByFamily } from '../registration/valueByFamily.js';
import type { PluginUiHostApi } from '../ui/hostApi.js';
import type {
  PluginSettingsActionInput,
  PluginSettingsActionRuntime,
} from '../settings/index.js';
import type { VoiceSettingsActionContext } from './index.js';
import {
  createVoiceRecordSchema,
  withVoiceSchemaField,
  VoiceCredentialSlotIdSchema,
  VoiceProviderContributionSchema,
} from './index.js';
import {
  createVoiceRecordSchema as canonicalCreateVoiceRecordSchema,
  withVoiceSchemaField as canonicalWithVoiceSchemaField,
} from './projections.js';

import type {
  VoiceCredentialSlotId,
  VoiceCredentialAccess,
  ConnectedAccountHttpHeadersRequest,
  PluginVoiceProviderDefinition,
  VoiceProviderContribution,
  VoiceProviderRuntime,
  VoiceProvidersRegistrationApi,
  VoiceRawCredentialAccess,
  VoiceRawCredentialGrantDeclaration,
  VoiceSchema,
} from './index.js';
import {
  describeActionInputFieldForVoice,
  isVoiceSdkSafeActionSpec,
  listVoiceSdkSafeToolActionSpecs,
  VoiceRealtimeJsonValueSchema,
  type VoiceClientToolDefinition,
  type RealtimeVoiceProviderRuntime,
  type PluginVoiceAgentSessionRealtimeService,
  type VoiceConnectionMediaHost,
  type VoiceProviderExecutionAuthority,
  type VoiceRealtimeCanonicalEvent,
  type VoiceRealtimeConnection,
  type VoiceRealtimeJsonValue,
  type VoiceRealtimeToolResultV1,
  type VoiceGuidanceAvailability,
  type VoiceRuntimePlatform,
  type VoiceTranscriptLadderMapper,
  type VoiceTranscriptLadderMode,
  type VoiceTranscriptLadderObservation,
} from './client.js';
import type {
  SpeechProviderRuntime,
  VoiceSpeechOperationContext,
  VoiceSpeechSynthesizeRequest,
  VoiceSpeechSynthesizeResult,
  VoiceSpeechTranscribeRequest,
  VoiceSpeechTranscribeResult,
} from './speech.js';

describe('Voice author source contract', () => {
  it('publishes neutral Voice composition from the actual /voice package entry', () => {
    const voiceBarrel = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');

    expect(voiceBarrel).not.toMatch(/@(?:preview|experimental|stable|incubating)\b/u);
    expect(voiceBarrel).not.toContain('@happier-dev/plugin-sdk/protocol');
    expect(createVoiceRecordSchema).toBe(canonicalCreateVoiceRecordSchema);
    expect(withVoiceSchemaField).toBe(canonicalWithVoiceSchemaField);
  });

  it('keeps the package namespace /voice entry aligned with its source owner', async () => {
    const packageVoice = await import('@happier-dev/plugin-sdk/voice');

    expect(typeof packageVoice.createVoiceRecordSchema).toBe('function');
    expect(typeof packageVoice.withVoiceSchemaField).toBe('function');

    const packageRecordSchema = packageVoice.createVoiceRecordSchema(VoiceRealtimeJsonValueSchema);
    const packageWithField = packageVoice.withVoiceSchemaField(
      packageRecordSchema,
      'parameters',
      packageRecordSchema,
    );

    expect(packageWithField.parse({ kind: 'list' })).toEqual({ kind: 'list' });
    expect(packageWithField.safeParse({ parameters: { value: 'x' } }).success).toBe(true);
    expect(packageWithField.safeParse({ parameters: ['invalid'] }).success).toBe(false);
  });

  it('owns conversation types under /voice/client instead of activation aliases', () => {
    const activationSource = readFileSync(new URL('../activation.ts', import.meta.url), 'utf8');
    const agentRealtimeSource = readFileSync(
      new URL('../experimental/agentRuntime/realtime.ts', import.meta.url),
      'utf8',
    );
    const clientSource = readFileSync(new URL('./client.ts', import.meta.url), 'utf8');
    const voiceSource = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
    expect(activationSource).not.toMatch(/\bexport type PluginVoiceRealtimeConnection\b/u);
    expect(activationSource).not.toMatch(/\bPluginVoice[A-Z]\w*/u);
    expect(clientSource).not.toContain("from '../activation.js'");
    expect(clientSource).not.toContain("from '@happier-dev/protocol/actions'");
    expect(clientSource).toContain("import type { ActionSpec } from '../actions/service.js';");
    expect(clientSource).toMatch(
      /import type \{[^}]*VoiceRealtimeJsonValue[^}]*\} from '\.\/projections\.js';/u,
    );
    expect(clientSource).not.toMatch(/VoiceRealtimeJson(?:Array|Object)/u);
    expect(clientSource).not.toMatch(/\bactionSpecToElevenLabsClientToolParameters\b/u);
    expect(clientSource).toContain('export type PluginVoiceAgentSessionRealtimeService');
    expect(clientSource).not.toMatch(/\bAgentSessionRealtimeConversation\b/u);
    expect(agentRealtimeSource).not.toMatch(/\bPluginVoiceAgentSessionRealtimeService\b/u);
    expect(clientSource).not.toMatch(/\bexport type Voice[A-Z]\w*\s*=\s*PluginVoice[A-Z]\w*/u);
    expect(voiceSource).not.toContain("from '../activation.js'");
    expect(voiceSource).not.toMatch(/\bVoiceAccountOperationService\s*=\s*PluginVoice/u);
  });

  it('projects the definePlugin voice declaration type through /voice', () => {
    const voiceSource = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');

    expect(voiceSource).toContain(
      "export type { PluginVoiceProviderDefinition } from '../definePlugin.js';",
    );
    expectTypeOf<PluginVoiceProviderDefinition>()
      .toEqualTypeOf<DirectPluginVoiceProviderDefinition>();
  });

  it('exposes one discriminated registration family and speech synthesis includes model', () => {
    expectTypeOf<Parameters<VoiceProvidersRegistrationApi['register']>[0]>()
      .toEqualTypeOf<PluginContributionLocalId>();
    expectTypeOf<Parameters<VoiceProvidersRegistrationApi['register']>[1]>()
      .toEqualTypeOf<VoiceProviderRuntime>();
    expectTypeOf<RealtimeVoiceProviderRuntime['kind']>().toEqualTypeOf<'conversation'>();
    expectTypeOf<SpeechProviderRuntime['kind']>().toEqualTypeOf<'speech'>();
    expectTypeOf<keyof VoiceSpeechOperationContext>()
      .toEqualTypeOf<'credentials' | 'settings' | 'http' | 'signal'>();
    expectTypeOf<VoiceSpeechOperationContext['http']>()
      .toEqualTypeOf<Pick<HttpService, 'request'>>();
    expectTypeOf<VoiceSpeechSynthesizeRequest['model']>().toEqualTypeOf<string | null>();
    expectTypeOf<VoiceCredentialSlotId>().toBeString();
    expectTypeOf<VoiceProviderContribution['kind']>().toEqualTypeOf<'conversation' | 'speech'>();
    expectTypeOf<PluginApi['voiceProviders']>().toEqualTypeOf<VoiceProvidersRegistrationApi>();
    expectTypeOf<keyof PluginApi['voiceProviders']>().toEqualTypeOf<'register'>();
    expectTypeOf<PluginRegistrationValueByFamily['voiceProviders']>()
      .toEqualTypeOf<VoiceProviderRuntime>();
    expectTypeOf<Parameters<PluginSettingsActionRuntime<VoiceSettingsActionContext>['execute']>>()
      .toEqualTypeOf<[PluginSettingsActionInput, VoiceSettingsActionContext]>();
    expectTypeOf<keyof VoiceSettingsActionContext>()
      .toEqualTypeOf<'credentials' | 'interactions' | 'signal' | 'tools'>();
    expectTypeOf<VoiceSettingsActionContext['tools']>()
      .toEqualTypeOf<readonly VoiceClientToolDefinition[]>();
  });

  it('uses the exact canonical transient askQuestions service for Voice settings', () => {
    type VoiceSettingsAskQuestions = VoiceSettingsActionContext['interactions']['askQuestions'];

    expectTypeOf<VoiceSettingsAskQuestions>().toEqualTypeOf<InteractionsService['askQuestions']>();
  });

  it('exports the canonical Voice credential-slot constructor for author literals', () => {
    const credentialSlotId = VoiceCredentialSlotIdSchema.parse('api_key');

    expect(VoiceCredentialSlotIdSchema).toBe(CanonicalVoiceCredentialSlotIdSchema);
    expect(VoiceProviderContributionSchema).toBe(CanonicalVoiceProviderContributionSchema);
    expect(credentialSlotId).toBe('api_key');
    expectTypeOf(credentialSlotId).toEqualTypeOf<VoiceCredentialSlotId>();
  });

  it('projects Protocol-owned effectful tool custody closed by default', () => {
    const provider = VoiceProviderContributionSchema.parse({
      id: 'conversation',
      title: 'Conversation',
      kind: 'conversation',
      roles: ['realtime_conversation'],
      platforms: ['web'],
      capabilities: { turn: { cancelResponse: false, bargeIn: false } },
      client: { artifactId: 'voice-runtime-web', modulePath: './voice', exportName: 'activate' },
    });
    if (provider.kind !== 'conversation') throw new Error('Expected a conversation Voice provider');

    expect(provider.capabilities).toMatchObject({
      tools: { effectCalls: 'none' },
    });
  });

  it('projects the canonical Voice header materialization request without a local structural alias', () => {
    expectTypeOf<ConnectedAccountHttpHeadersRequest>()
      .toEqualTypeOf<ProtocolConnectedAccountHttpHeadersRequest>();
  });

  it('uses the exact canonical Connected Account request at every raw Voice boundary', () => {
    type VoiceRawMaterializationRequest = Parameters<VoiceRawCredentialAccess['materialize']>[0];

    expectTypeOf<VoiceRawMaterializationRequest>()
      .toEqualTypeOf<ProtocolConnectedAccountMaterializationRequest>();
    expectTypeOf<VoiceRawCredentialGrantDeclaration['request']>()
      .toEqualTypeOf<ProtocolConnectedAccountMaterializationRequest>();
  });

  it('directly aliases Protocol-owned speech DTOs while composing SDK-owned operation authorities', () => {
    const speechSource = readFileSync(new URL('./speech.ts', import.meta.url), 'utf8');

    expect(speechSource).toContain("from '@happier-dev/protocol/voice/providerOperations';");
    expect(speechSource).toContain("from '@happier-dev/protocol/voice/speech';");
    expect(speechSource).toContain(
      'export type VoiceSpeechOperationContext = ProtocolVoiceSpeechOperationContext<',
    );
    expectTypeOf<VoiceSpeechOperationContext>().toEqualTypeOf<
      ProtocolVoiceSpeechOperationContext<VoiceCredentialAccess<'speech'>, Pick<HttpService, 'request'>>
    >();
    expectTypeOf<VoiceSpeechTranscribeRequest>()
      .toEqualTypeOf<ProtocolVoiceSpeechTranscribeRequest>();
    expectTypeOf<VoiceSpeechTranscribeResult>()
      .toEqualTypeOf<ProtocolVoiceSpeechTranscribeResult>();
    expectTypeOf<VoiceSpeechSynthesizeRequest>()
      .toEqualTypeOf<ProtocolVoiceSpeechSynthesizeRequest>();
    expectTypeOf<VoiceSpeechSynthesizeResult>()
      .toEqualTypeOf<ProtocolVoiceSpeechSynthesizeResult>();
  });

  it('exports the browser-safe conversation value codec and SDK-safe tool catalog', () => {
    expect(VoiceRealtimeJsonValueSchema).toBe(CanonicalVoiceRealtimeJsonValueSchema);
    expect(isVoiceSdkSafeActionSpec).toBe(canonicalIsVoiceSdkSafeActionSpec);
    expect(listVoiceSdkSafeToolActionSpecs).toBe(canonicalListVoiceSdkSafeToolActionSpecs);
    expectTypeOf<Parameters<typeof isVoiceSdkSafeActionSpec>[0]>()
      .toEqualTypeOf<Pick<import('../actions/service.js').ActionSpec, 'sideEffectClass'>>();
    expect(isVoiceSdkSafeActionSpec({ sideEffectClass: 'read' })).toBe(true);
    expect(isVoiceSdkSafeActionSpec({ sideEffectClass: 'write' })).toBe(false);
    expectTypeOf<VoiceRealtimeJsonValue>().toEqualTypeOf<CanonicalVoiceRealtimeJsonValue>();
    expectTypeOf<typeof VoiceRealtimeJsonValueSchema>()
      .toEqualTypeOf<VoiceSchema<VoiceRealtimeJsonValue>>();
    expectTypeOf<ReturnType<typeof VoiceRealtimeJsonValueSchema.optional>>()
      .toEqualTypeOf<VoiceSchema<VoiceRealtimeJsonValue | undefined>>();
    expectTypeOf<ReturnType<typeof VoiceRealtimeJsonValueSchema.array>>()
      .toEqualTypeOf<VoiceSchema<VoiceRealtimeJsonValue[]>>();
    expect(VoiceRealtimeJsonValueSchema.optional().parse(undefined)).toBeUndefined();
    expectTypeOf<keyof VoiceRealtimeToolResultV1>()
      .toEqualTypeOf<keyof CanonicalVoiceRealtimeToolResultV1>();
    expectTypeOf<VoiceRealtimeToolResultV1['output']>()
      .toEqualTypeOf<VoiceRealtimeJsonValue | undefined>();
  });

  it('projects canonical Voice field guidance for provider tool schemas', () => {
    expectTypeOf<typeof describeActionInputFieldForVoice>().toBeFunction();
    expectTypeOf<VoiceGuidanceAvailability>()
      .toEqualTypeOf<CanonicalVoiceGuidanceAvailability>();
  });

  it('preserves canonical realtime event and tool DTO identity', () => {
    expectTypeOf<VoiceTranscriptCanonicalEventV1>().toMatchTypeOf<
      Extract<VoiceRealtimeCanonicalEvent, { type: 'transcript' }>['event']
    >();
    type ProjectedToolCall = Extract<VoiceRealtimeCanonicalEvent, { type: 'tool_calls' }>['calls'][number];
    expectTypeOf<keyof VoiceRealtimeToolCallV1>()
      .toEqualTypeOf<keyof ProjectedToolCall>();
    expectTypeOf<ProjectedToolCall['arguments']>().toEqualTypeOf<VoiceRealtimeJsonValue>();
    type ProjectedToolResult = Parameters<RealtimeVoiceProviderRuntime['encodeToolResults']>[0][number];
    expectTypeOf<keyof CanonicalVoiceRealtimeToolResultV1>()
      .toEqualTypeOf<keyof ProjectedToolResult>();
    expectTypeOf<ProjectedToolResult['status']>()
      .toEqualTypeOf<CanonicalVoiceRealtimeToolResultV1['status']>();
    expectTypeOf<ProjectedToolResult['output']>()
      .toEqualTypeOf<VoiceRealtimeJsonValue | undefined>();
    expectTypeOf<Extract<
      VoiceRealtimeCanonicalEvent,
      { type: 'provider_event' }
    >>().toEqualTypeOf<never>();
  });

  it('re-exports the Protocol-owned transcript ladder instead of restating it', () => {
    expectTypeOf<VoiceTranscriptLadderMode>().toEqualTypeOf<CanonicalVoiceTranscriptLadderMode>();
    expectTypeOf<VoiceTranscriptLadderObservation>()
      .toEqualTypeOf<CanonicalVoiceTranscriptLadderObservation>();
    expectTypeOf<VoiceTranscriptLadderMapper>().toEqualTypeOf<CanonicalVoiceTranscriptLadderMapper>();
  });

  it('keeps the client runtime platform a subset of the canonical declared platforms', () => {
    /*
     * Narrower on purpose — the host collapses every desktop shell to the web bundle — but never
     * divergent: a platform this seam names must be one the canonical enum knows.
     */
    expectTypeOf<VoiceRuntimePlatform>().toMatchTypeOf<CanonicalVoiceRuntimePlatform>();
    expectTypeOf<VoiceRuntimePlatform>().not.toEqualTypeOf<CanonicalVoiceRuntimePlatform>();
  });

  it('projects the strict Agent realtime runtime-version declaration by canonical identity', () => {
    expect(VoiceProviderContributionSchema.parse({
      id: 'agent-realtime',
      title: 'Agent realtime',
      kind: 'conversation',
      roles: ['realtime_conversation'],
      platforms: ['web'],
      capabilities: { turn: { cancelResponse: false, bargeIn: false } },
      execution: {
        kind: 'experimental_agent_session_realtime',
        agent: 'codex',
        supportedRuntimeVersions: ['1.2.3'],
      },
      client: { artifactId: 'voice-runtime-web', modulePath: './voice', exportName: 'activate' },
    })).toMatchObject({
      execution: {
        kind: 'experimental_agent_session_realtime',
        agent: 'codex',
        supportedRuntimeVersions: ['1.2.3'],
      },
    });
  });

  it('gives connection operations the existing UI host and caller lifetime', () => {
    type ConnectionInput = Parameters<RealtimeVoiceProviderRuntime['createConnection']>[0];

    expectTypeOf<keyof ConnectionInput>().toEqualTypeOf<
      'session' | 'attemptId' | 'mic' | 'interruption' | 'levels' | 'media' | 'tools' | 'ui' | 'signal' | 'execution' | 'credentials'
    >();
    expectTypeOf<ConnectionInput['signal']>().toEqualTypeOf<AbortSignal>();
    expectTypeOf<ConnectionInput['ui']>().toEqualTypeOf<PluginUiHostApi>();
    expectTypeOf<ConnectionInput['media']>().toEqualTypeOf<VoiceConnectionMediaHost>();
    expectTypeOf<ConnectionInput['execution']>().toEqualTypeOf<VoiceProviderExecutionAuthority>();
    expectTypeOf<Extract<
      ConnectionInput['execution'],
      { kind: 'experimental_agent_session_realtime' }
    >['agentSessionRealtime']>().toEqualTypeOf<PluginVoiceAgentSessionRealtimeService>();
    expectTypeOf<keyof PluginVoiceAgentSessionRealtimeService>()
      .toEqualTypeOf<'inspect' | 'start'>();
    expectTypeOf<Parameters<PluginVoiceAgentSessionRealtimeService['inspect']>>()
      .toEqualTypeOf<[options?: Readonly<{ signal?: AbortSignal }>]>();
    expectTypeOf<ReturnType<PluginVoiceAgentSessionRealtimeService['inspect']>>()
      .toEqualTypeOf<Promise<AgentSessionRealtimeAvailability>>();
    expectTypeOf<Parameters<PluginVoiceAgentSessionRealtimeService['start']>>()
      .toEqualTypeOf<[
        input: AgentSessionRealtimeStartInput,
        options?: Readonly<{ signal?: AbortSignal }>,
      ]>();
    expectTypeOf<ReturnType<PluginVoiceAgentSessionRealtimeService['start']>>()
      .toEqualTypeOf<Promise<AgentSessionRealtimeStartResult>>();
    expectTypeOf<Parameters<ConnectionInput['media']['createWebRtcConnection']>[0]>()
      .toEqualTypeOf<Readonly<{
        signaling: Readonly<{
          exchangeOffer(input: Readonly<{
            offerSdp: string;
            signal: AbortSignal;
          }>): Promise<Readonly<{ answerSdp: string }>>;
        }>;
        control: Readonly<{
          label: string;
          onOpen(input: Readonly<{
            sendJson(value: VoiceRealtimeJsonValue): Promise<void>;
          }>): void | Promise<void>;
        }>;
      }>>();
    expectTypeOf<Parameters<ConnectionInput['media']['createPcmConnection']>[0]>()
      .not.toHaveProperty('mic');
    expectTypeOf<ReturnType<ConnectionInput['media']['createPcmConnection']>>()
      .toEqualTypeOf<Readonly<{
        connection: VoiceRealtimeConnection;
        enqueueOutput(base64Pcm16Le: string): boolean;
        clearOutput(): void;
        waitForOutputDrain(signal: AbortSignal): Promise<void>;
      }>>();
    expectTypeOf<Parameters<ConnectionInput['media']['createPcmConnection']>[0]['output']>()
      .not.toHaveProperty('retainedOutputMaxMs');
  });
});
