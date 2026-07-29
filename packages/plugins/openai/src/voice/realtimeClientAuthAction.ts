import type { ActionHandler } from '@happier-dev/plugin-sdk/runtime';
import {
  classifyVoiceProviderHttpFailure,
  containsProviderRegisteredSensitiveValue,
} from '@happier-dev/protocol';
import { z } from 'zod';

import { OpenAiRealtimeClientAuthProviderResponseSchema } from '../protocol/voice/clientAuth.js';

export const OPENAI_REALTIME_CONNECTED_ACCOUNT_PURPOSE = 'realtime-openai-account';
export const OPENAI_REALTIME_CODEX_CONNECTED_ACCOUNT_PURPOSE =
  'realtime-openai-codex-account';
export const OPENAI_REALTIME_CLIENT_AUTH_ACTION_ID = 'mint-realtime-client-auth';
export const OPENAI_REALTIME_CODEX_CLIENT_AUTH_ACTION_ID =
  'mint-realtime-client-auth-with-codex-oauth';

const TurnDetectionSchema = z.union([
  z.null(),
  z.object({
    type: z.enum(['server_vad', 'semantic_vad']),
    create_response: z.literal(false),
    interrupt_response: z.literal(false),
  }).strict(),
]);

const ClientAuthRequestBodySchema = z.object({
  session: z.object({
    type: z.literal('realtime'),
    model: z.string().trim().min(1).max(128),
    audio: z.object({
      input: z.object({
        turn_detection: TurnDetectionSchema,
        transcription: z.object({
          model: z.string().trim().min(1).max(128),
        }).strict().optional(),
      }).strict(),
      output: z.object({
        voice: z.string().trim().min(1).max(128),
      }).strict(),
    }).strict(),
    instructions: z.string().trim().max(16_384).optional(),
  }).strict(),
}).strict();

const ClientAuthActionInputSchema = z.object({
  operationId: z.literal('client-auth'),
  parameters: z.object({
    body: ClientAuthRequestBodySchema,
  }).strict(),
}).strict();

const OPENAI_API_ORIGIN = 'https://api.openai.com';
const OPENAI_REALTIME_CLIENT_AUTH_URL =
  `${OPENAI_API_ORIGIN}/v1/realtime/client_secrets`;
const MAX_CLIENT_AUTH_RESPONSE_BYTES = 64 * 1024;

function actionError(code: string): Error {
  return Object.assign(new Error(code), { code });
}

function parseJsonBody(
  body: Uint8Array,
): ReturnType<typeof OpenAiRealtimeClientAuthProviderResponseSchema.parse> {
  if (body.byteLength > MAX_CLIENT_AUTH_RESPONSE_BYTES) {
    throw actionError('provider_response_invalid');
  }
  try {
    return OpenAiRealtimeClientAuthProviderResponseSchema.parse(JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(body),
    ));
  } catch {
    throw actionError('provider_response_invalid');
  }
}

type ClientAuthSource = Readonly<{
  purpose: string;
  service: Readonly<{ pluginId: string; localId: string }>;
  selectionReason: string;
  headerNames: readonly string[];
}>;

function createMintOpenAiRealtimeClientAuth(source: ClientAuthSource): ActionHandler {
  return async (input, context) => {
    const parsed = ClientAuthActionInputSchema.safeParse(input);
    if (!parsed.success) throw actionError('invalid_parameters');
    const signal = context.signal;
    let binding = await context.services.connectedAccounts.getBinding(
      source.purpose,
      { signal },
    );
    if (!binding) {
      binding = await context.services.connectedAccounts.requestSelection({
        purpose: source.purpose,
        reason: source.selectionReason,
      }, { signal });
    }
    if (
      binding.service.pluginId !== source.service.pluginId
      || binding.service.localId !== source.service.localId
    ) {
      throw actionError('credential_unavailable');
    }
    const attemptController = new AbortController();
    let initialResyncObserved = false;
    let authorityInvalidated = false;
    let resolveInitialResync!: () => void;
    const initialResync = new Promise<void>((resolve) => {
      resolveInitialResync = resolve;
    });
    const abortFromContext = () => {
      attemptController.abort(context.signal.reason);
      resolveInitialResync();
    };
    context.signal.addEventListener('abort', abortFromContext, { once: true });
    if (context.signal.aborted) abortFromContext();
    let subscription: ReturnType<
      typeof context.services.connectedAccounts.watch
    > | null = null;
    const attemptSignal = attemptController.signal;
    const assertAuthorityCurrent = () => {
      if (authorityInvalidated) throw actionError('credential_unavailable');
      attemptSignal.throwIfAborted();
    };
    try {
      subscription = context.services.connectedAccounts.watch(
        source.purpose,
        () => {
          if (!initialResyncObserved) {
            initialResyncObserved = true;
            resolveInitialResync();
            return;
          }
          authorityInvalidated = true;
          attemptController.abort(actionError('credential_unavailable'));
        },
      );
      await initialResync;
      assertAuthorityCurrent();
      let materialized: Awaited<
        ReturnType<typeof context.services.connectedAccounts.materialize>
      >;
      try {
        materialized = await context.services.connectedAccounts.materialize(
          source.purpose,
          {
            kind: 'httpHeaders',
            origin: OPENAI_API_ORIGIN,
            headerNames: source.headerNames,
          },
          { signal: attemptSignal },
        );
      } catch (error) {
        if (authorityInvalidated) throw actionError('credential_unavailable');
        if (context.signal.aborted) throw error;
        throw actionError('credential_unavailable');
      }
      assertAuthorityCurrent();
      if (materialized.kind !== 'httpHeaders') {
        throw actionError('credential_unavailable');
      }
      const authorization = Object.entries(materialized.headers).find(
        ([name]) => name.toLowerCase() === 'authorization',
      )?.[1];
      if (!authorization) throw actionError('credential_unavailable');
      const requestBody = new TextEncoder().encode(JSON.stringify(parsed.data.parameters.body));
      let response: Awaited<ReturnType<typeof context.services.fetch.request>>;
      try {
        response = await context.services.fetch.request({
          url: OPENAI_REALTIME_CLIENT_AUTH_URL,
          method: 'POST',
          headers: {
            ...materialized.headers,
            Accept: 'application/json',
            'Content-Type': 'application/json',
          },
          body: requestBody,
          redirect: 'error',
        }, { signal: attemptSignal });
      } catch (error) {
        if (authorityInvalidated) throw actionError('credential_unavailable');
        throw error;
      }
      assertAuthorityCurrent();
      if (response.finalUrl !== OPENAI_REALTIME_CLIENT_AUTH_URL) {
        throw actionError('provider_response_invalid');
      }
      const httpFailure = classifyVoiceProviderHttpFailure(response.status);
      if (httpFailure) throw actionError(httpFailure);
      const body = parseJsonBody(response.body);
      const serialized = JSON.stringify(body);
      const sensitiveValues = Object.values(materialized.headers).flatMap((value) => [
        value,
        value.replace(/^Bearer\s+/iu, ''),
      ]).filter((value) => value.length > 0);
      if (containsProviderRegisteredSensitiveValue(serialized, sensitiveValues)) {
        throw actionError('provider_response_invalid');
      }
      return {
        status: response.status,
        finalUrl: response.finalUrl,
        headers: {},
        body: {
          value: body.value,
          expires_at: body.expires_at,
        },
      };
    } finally {
      context.signal.removeEventListener('abort', abortFromContext);
      subscription?.dispose();
    }
  };
}

export const mintOpenAiRealtimeClientAuth = createMintOpenAiRealtimeClientAuth({
  purpose: OPENAI_REALTIME_CONNECTED_ACCOUNT_PURPOSE,
  service: { pluginId: 'happier.voice.openai', localId: 'openai' },
  selectionReason: 'Choose the OpenAI account used for Realtime voice.',
  headerNames: ['authorization'],
});

export const mintOpenAiRealtimeClientAuthWithCodexOAuth =
  createMintOpenAiRealtimeClientAuth({
    purpose: OPENAI_REALTIME_CODEX_CONNECTED_ACCOUNT_PURPOSE,
    service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' },
    selectionReason:
      'Choose the experimental OpenAI Codex OAuth account used for Realtime voice.',
    headerNames: ['authorization', 'chatgpt-account-id'],
  });
