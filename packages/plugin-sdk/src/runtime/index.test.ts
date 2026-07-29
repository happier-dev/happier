import { describe, expect, expectTypeOf, it } from 'vitest';

import * as runtime from './index.js';
import type {
  PluginServices,
  PluginVoiceHostedConversationService,
  PluginVoiceProviderRuntimeRegistration,
  PluginVoiceSpeechRuntimeRegistration,
} from './index.js';
import type { PluginApi, PluginInvocationContext } from '../index.js';
// @ts-expect-error -- activation uses the canonical root PluginApi; the migration alias is not normal API.
import type { PluginActivationApi } from './index.js';

describe('stable runtime entrypoint', () => {
  it('exports the public activation, invocation, service, error, and lifecycle contract', () => {
    expect(runtime).not.toHaveProperty('PluginError');
    expectTypeOf<PluginApi>().not.toHaveProperty('services');
    expectTypeOf<PluginApi>().toHaveProperty('voiceProviders');
    expectTypeOf<PluginApi>().not.toHaveProperty('registerAction');
    expectTypeOf<PluginApi>().not.toHaveProperty('registerAgentRuntime');
    expectTypeOf<PluginApi>().not.toHaveProperty('onDispose');
    expectTypeOf<PluginApi>().toHaveProperty('actions');
    expectTypeOf<PluginApi>().toHaveProperty('hooks');
    expectTypeOf<PluginApi>().toHaveProperty('mcp');
    expectTypeOf<PluginApi>().toHaveProperty('scm');
    expectTypeOf<PluginInvocationContext>().toHaveProperty('services');
    expectTypeOf<PluginServices>().toHaveProperty('availability');
  });

  it('exposes only the provider-native Voice leaf rather than a host controller', () => {
    expectTypeOf<PluginVoiceHostedConversationService>().toHaveProperty('start');
    expectTypeOf<PluginVoiceHostedConversationService>().toHaveProperty('complete');
    expectTypeOf<PluginVoiceHostedConversationService>().toHaveProperty('abort');
    expectTypeOf<PluginVoiceProviderRuntimeRegistration>().toHaveProperty('protocol');
    expectTypeOf<PluginVoiceProviderRuntimeRegistration>().toHaveProperty('createConnection');
    expectTypeOf<PluginVoiceProviderRuntimeRegistration>().not.toHaveProperty('start');
    expectTypeOf<PluginVoiceProviderRuntimeRegistration>().not.toHaveProperty('stop');
    expectTypeOf<PluginVoiceProviderRuntimeRegistration>().not.toHaveProperty('getSnapshot');
  });

  it('exposes the speech leaf as operations and schemas without a host controller', () => {
    expectTypeOf<PluginVoiceSpeechRuntimeRegistration>().toHaveProperty('catalogProviders');
    expectTypeOf<PluginVoiceSpeechRuntimeRegistration>().toHaveProperty('operations');
    expectTypeOf<PluginVoiceSpeechRuntimeRegistration>().toHaveProperty('speechProviderIds');
    expectTypeOf<PluginVoiceSpeechRuntimeRegistration>().toHaveProperty('schemas');
    expectTypeOf<PluginVoiceSpeechRuntimeRegistration>().not.toHaveProperty('start');
    expectTypeOf<PluginVoiceSpeechRuntimeRegistration>().not.toHaveProperty('stop');
  });

  it('does not expose retired runtime controllers or unpublished measured limits', () => {
    const publicRuntime = runtime as Readonly<Record<string, unknown>>;
    for (const removed of [
      'RuntimeCore',
      'RuntimeCoreV1',
      'AcpSessionRuntimeV1',
      'createSessionRuntime',
      'createExecutionRunBackend',
      'AGENT_SESSION_RUNTIME_LIMITS_V1',
      'AGENT_SESSION_RUNTIME_LIMITS_CANDIDATE_V1',
      'MAX_MANAGED_SERVER_HANDLES_PER_GENERATION',
      'MAX_PLUGIN_FETCH_HEADER_BYTES',
      'MAX_PLUGIN_FETCH_REDIRECTS',
      'MAX_PLUGIN_FETCH_REQUEST_BODY_BYTES',
      'MAX_PLUGIN_FETCH_RESPONSE_BODY_BYTES',
      'PLUGIN_NOTIFICATION_IDEMPOTENCY_RETENTION_MS',
      'MAX_PLUGIN_SESSION_SEND_IDEMPOTENCY_RECORDS',
      'PLUGIN_SESSION_SEND_IDEMPOTENCY_RETENTION_MS',
      'MAX_PLUGIN_SUBAGENT_IDEMPOTENCY_RECORDS',
      'PLUGIN_SUBAGENT_IDEMPOTENCY_RETENTION_MS',
      'redactBugReportSensitiveText',
      'trimBugReportTextToMaxBytes',
      'RuntimeErrorKindV1',
      'ClassifiedRuntimeErrorV1',
      'ErrorRuntimeServiceV1',
    ]) {
      expect(publicRuntime[removed], removed).toBeUndefined();
    }
  });
});
