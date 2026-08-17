import { sha256 } from '@noble/hashes/sha2';
import { z } from 'zod';

import { PluginContributionIdentityV1Schema } from '../../../plugins/contributionIdentity.js';
import { createCanonicalJsonSigningInput } from '../../../crypto/canonicalJson.js';
import { asProtocolZod } from "../../../plugins/actions/internalProtocolZodAdapter.js";

export const VOICE_MEDIA_VERSION_V1 = 1 as const;
export const VOICE_MEDIA_AGENT_REALTIME_PCM_FORMAT_V1 = {
  encoding: 'pcm_s16le',
  sampleRateHz: 24_000,
  channelCount: 1,
  bytesPerSample: 2,
} as const;

const SafeSequenceSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const PositiveByteCountSchema = z.number().int().positive().max(16 * 1024 * 1024);
const Sha256DigestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/u);

export const VoiceMediaApplicationKindV1Schema = z.enum([
  'speech_transcription',
  'agent_realtime',
]);
export type VoiceMediaApplicationKindV1 = z.infer<typeof VoiceMediaApplicationKindV1Schema>;

export const VoiceMediaApplicationAuthorityV1Schema = z.object({
  v: z.literal(VOICE_MEDIA_VERSION_V1),
  applicationKind: VoiceMediaApplicationKindV1Schema,
  applicationAttemptId: z.string().min(1).max(256),
  applicationAuthorityDigest: Sha256DigestSchema,
}).strict();
export type VoiceMediaApplicationAuthorityV1 = z.infer<
  typeof VoiceMediaApplicationAuthorityV1Schema
>;

export const AgentRealtimeApplicationAuthorityFactsV1Schema = z.object({
  v: z.literal(VOICE_MEDIA_VERSION_V1),
  happierSessionId: z.string().min(1).max(256),
  agentRef: asProtocolZod(PluginContributionIdentityV1Schema),
  agentGeneration: z.string().min(1).max(512),
  sessionBridgeId: z.string().min(1).max(256),
  applicationAttemptId: z.string().min(1).max(256),
}).strict();
export type AgentRealtimeApplicationAuthorityFactsV1 = z.infer<
  typeof AgentRealtimeApplicationAuthorityFactsV1Schema
>;

function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

export function createAgentRealtimeApplicationAuthorityV1(
  input: AgentRealtimeApplicationAuthorityFactsV1,
): VoiceMediaApplicationAuthorityV1 & Readonly<{ applicationKind: 'agent_realtime' }> {
  const facts = AgentRealtimeApplicationAuthorityFactsV1Schema.parse(input);
  const signingInput = createCanonicalJsonSigningInput({
    domain: 'happier.voice-media.agent-realtime.authority.v1',
    applicationKind: 'agent_realtime',
    ...facts,
  });
  return VoiceMediaApplicationAuthorityV1Schema.parse({
    v: VOICE_MEDIA_VERSION_V1,
    applicationKind: 'agent_realtime',
    applicationAttemptId: facts.applicationAttemptId,
    applicationAuthorityDigest:
      `sha256:${bytesToHex(sha256(new TextEncoder().encode(signingInput)))}`,
  }) as VoiceMediaApplicationAuthorityV1 & Readonly<{ applicationKind: 'agent_realtime' }>;
}

export function verifyAgentRealtimeApplicationAuthorityV1(input: Readonly<{
  authority: VoiceMediaApplicationAuthorityV1;
  facts: AgentRealtimeApplicationAuthorityFactsV1;
}>): boolean {
  const parsedAuthority = VoiceMediaApplicationAuthorityV1Schema.safeParse(input.authority);
  const parsedFacts = AgentRealtimeApplicationAuthorityFactsV1Schema.safeParse(input.facts);
  if (
    !parsedAuthority.success
    || parsedAuthority.data.applicationKind !== 'agent_realtime'
    || !parsedFacts.success
  ) {
    return false;
  }
  const expected = createAgentRealtimeApplicationAuthorityV1(parsedFacts.data);
  return parsedAuthority.data.applicationAttemptId === expected.applicationAttemptId
    && parsedAuthority.data.applicationAuthorityDigest === expected.applicationAuthorityDigest;
}

export const VoiceMediaAgentRealtimePcmFormatV1Schema = z.object({
  encoding: z.literal(VOICE_MEDIA_AGENT_REALTIME_PCM_FORMAT_V1.encoding),
  sampleRateHz: z.literal(VOICE_MEDIA_AGENT_REALTIME_PCM_FORMAT_V1.sampleRateHz),
  channelCount: z.literal(VOICE_MEDIA_AGENT_REALTIME_PCM_FORMAT_V1.channelCount),
  bytesPerSample: z.literal(VOICE_MEDIA_AGENT_REALTIME_PCM_FORMAT_V1.bytesPerSample),
}).strict();
export type VoiceMediaAgentRealtimePcmFormatV1 = z.infer<
  typeof VoiceMediaAgentRealtimePcmFormatV1Schema
>;

const VoiceMediaAgentRealtimePcmFrameV1Schema = z.object({
  v: z.literal(VOICE_MEDIA_VERSION_V1),
  applicationSequence: SafeSequenceSchema,
  format: VoiceMediaAgentRealtimePcmFormatV1Schema,
  samplesPerChannel: PositiveByteCountSchema,
  payload: z.instanceof(Uint8Array),
}).strict().superRefine((value, context) => {
  const expectedBytes = value.samplesPerChannel
    * value.format.channelCount
    * value.format.bytesPerSample;
  if (value.payload.byteLength !== expectedBytes) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['payload'],
      message: `PCM byte length ${value.payload.byteLength} does not match ${expectedBytes}`,
    });
  }
});

const InputAudioFrameV1Schema = VoiceMediaAgentRealtimePcmFrameV1Schema
  .safeExtend({ kind: z.literal('input_audio') });
const OutputAudioFrameV1Schema = VoiceMediaAgentRealtimePcmFrameV1Schema
  .safeExtend({
    kind: z.literal('output_audio'),
    upstreamItemId: z.string().min(1).max(512).optional(),
  });
const ApplicationCreditFrameV1Schema = z.object({
  v: z.literal(VOICE_MEDIA_VERSION_V1),
  applicationSequence: SafeSequenceSchema,
  acceptedBytes: PositiveByteCountSchema,
}).strict();
const InputAcceptedFrameV1Schema = ApplicationCreditFrameV1Schema.extend({
  kind: z.literal('input_accepted'),
}).strict();
const OutputAcceptedFrameV1Schema = ApplicationCreditFrameV1Schema.extend({
  kind: z.literal('output_accepted'),
}).strict();
const TranscriptFrameV1Schema = z.object({
  v: z.literal(VOICE_MEDIA_VERSION_V1),
  kind: z.literal('transcript'),
  applicationSequence: SafeSequenceSchema,
  role: z.enum(['user', 'assistant']),
  phase: z.enum(['delta', 'final']),
  text: z.string(),
  upstreamItemId: z.string().min(1).max(512).optional(),
}).strict();
const StatusFrameV1Schema = z.object({
  v: z.literal(VOICE_MEDIA_VERSION_V1),
  kind: z.literal('status'),
  applicationSequence: SafeSequenceSchema,
  status: z.enum(['ready', 'listening', 'responding', 'interrupted']),
}).strict();
const ActivityFrameV1Schema = z.object({
  v: z.literal(VOICE_MEDIA_VERSION_V1),
  kind: z.literal('activity'),
  applicationSequence: SafeSequenceSchema,
  activity: z.enum([
    'delegation_requested',
    'delegation_started',
    'delegation_completed',
    'delegation_failed',
  ]),
  upstreamItemId: z.string().min(1).max(512).optional(),
}).strict();
const ErrorFrameV1Schema = z.object({
  v: z.literal(VOICE_MEDIA_VERSION_V1),
  kind: z.literal('error'),
  applicationSequence: SafeSequenceSchema,
  code: z.string().min(1).max(128),
  message: z.string().min(1).max(4096),
}).strict();
const TerminalFrameV1Schema = z.object({
  v: z.literal(VOICE_MEDIA_VERSION_V1),
  kind: z.literal('terminal'),
  applicationSequence: SafeSequenceSchema,
  reason: z.enum(['completed', 'cancelled', 'failed', 'disconnected']),
}).strict();

export const VoiceMediaAgentRealtimeFrameV1Schema = z.union([
  InputAudioFrameV1Schema,
  OutputAudioFrameV1Schema,
  InputAcceptedFrameV1Schema,
  OutputAcceptedFrameV1Schema,
  TranscriptFrameV1Schema,
  StatusFrameV1Schema,
  ActivityFrameV1Schema,
  ErrorFrameV1Schema,
  TerminalFrameV1Schema,
]);
export type VoiceMediaAgentRealtimeFrameV1 = z.infer<
  typeof VoiceMediaAgentRealtimeFrameV1Schema
>;

const VOICE_MEDIA_AGENT_REALTIME_FRAME_MAX_BYTES_V1 = 512 * 1024;

function encodeJsonValue(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

export function encodeVoiceMediaAgentRealtimeFrameV1(
  frame: VoiceMediaAgentRealtimeFrameV1,
): Uint8Array {
  const parsed = VoiceMediaAgentRealtimeFrameV1Schema.parse(frame);
  const encoded = encodeJsonValue(
    'payload' in parsed
      ? {
        ...parsed,
        payload: Array.from(parsed.payload),
      }
      : parsed,
  );
  if (encoded.byteLength > VOICE_MEDIA_AGENT_REALTIME_FRAME_MAX_BYTES_V1) {
    throw new Error('Voice media Agent realtime frame exceeds the wire limit');
  }
  return encoded;
}

export function decodeVoiceMediaAgentRealtimeFrameV1(
  bytes: Uint8Array,
): VoiceMediaAgentRealtimeFrameV1 | null {
  if (bytes.byteLength > VOICE_MEDIA_AGENT_REALTIME_FRAME_MAX_BYTES_V1) return null;
  try {
    const candidate = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
    if (
      candidate !== null
      && typeof candidate === 'object'
      && 'payload' in candidate
      && Array.isArray(candidate.payload)
    ) {
      const payload = candidate.payload;
      if (!payload.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)) return null;
      return VoiceMediaAgentRealtimeFrameV1Schema.parse({
        ...candidate,
        payload: Uint8Array.from(payload),
      });
    }
    const parsed = VoiceMediaAgentRealtimeFrameV1Schema.safeParse(candidate);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
