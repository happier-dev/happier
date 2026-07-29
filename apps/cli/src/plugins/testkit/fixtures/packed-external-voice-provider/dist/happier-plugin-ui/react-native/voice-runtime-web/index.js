const MAX_CATALOG_METADATA_PROPERTIES = 32;
const FIXTURE_VOICE_ID = 'packed-voice-primary';
const fixtureEvents = [];

globalThis.__HAPPIER_PACKED_VOICE_FIXTURE_EVENTS__ = fixtureEvents;

function readRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function readJsonResponse(response, errorCode) {
  if (response.status !== 200) {
    throw new Error(errorCode);
  }
  try {
    return JSON.parse(new TextDecoder().decode(response.body));
  } catch {
    throw new Error(errorCode);
  }
}

function readProviderConfig(value) {
  const config = readRecord(value);
  if (
    config?.mode !== 'default'
    || (config.profile !== 'balanced' && config.profile !== 'expressive')
    || typeof config.enableProvisioning !== 'boolean'
    || Object.keys(config).some((key) => (
      key !== 'mode' && key !== 'profile' && key !== 'enableProvisioning'
    ))
  ) {
    throw new Error('invalid_provider_config');
  }
  return {
    mode: config.mode,
    profile: config.profile,
    enableProvisioning: config.enableProvisioning,
  };
}

function readCatalog(response) {
  const wire = readJsonResponse(response, 'invalid_voice_catalog');
  if (!Array.isArray(wire?.voices) || wire.voices.length < 1 || wire.voices.length > 500) {
    throw new Error('invalid_voice_catalog');
  }
  return wire.voices.map((candidate) => {
    const id = typeof candidate?.voice_id === 'string' ? candidate.voice_id.trim() : '';
    const name = typeof candidate?.name === 'string' ? candidate.name.trim() : '';
    if (id.length < 1 || id.length > 256 || name.length < 1 || name.length > 256) {
      throw new Error('invalid_voice_catalog');
    }
    const metadata = {};
    if (typeof candidate.language === 'string' && candidate.language.length <= 512) {
      metadata.language = candidate.language;
    }
    if (Object.keys(metadata).length > MAX_CATALOG_METADATA_PROPERTIES) {
      throw new Error('invalid_voice_catalog');
    }
    return { id, name, metadata };
  });
}

function readProvisioning(response, selectedVoiceId, profile) {
  const wire = readJsonResponse(response, 'invalid_voice_provisioning');
  if (wire?.provisioned_voice_id !== selectedVoiceId || wire?.profile !== profile) {
    throw new Error('invalid_voice_provisioning');
  }
  return {
    selectedVoiceId,
    profile,
  };
}

function readClientAuth(response) {
  const wire = readJsonResponse(response, 'invalid_voice_client_auth_artifact');
  const value = wire?.client_secret?.value;
  const expiresAtMs = wire?.client_secret?.expires_at_ms;
  if (
    typeof value !== 'string'
    || value.length < 1
    || value.length > 16_384
    || !Number.isInteger(expiresAtMs)
    || expiresAtMs <= 0
  ) {
    throw new Error('invalid_voice_client_auth_artifact');
  }
  return {
    kind: 'bearer_token',
    value,
    expiresAtMs,
    placement: 'authorization_header',
  };
}

export function activate(api) {
  fixtureEvents.push({ kind: 'activated' });
  api.voiceProviders.register('conversation', {
    settingsOperations: {
      async listCatalog(input) {
        readProviderConfig(input.providerConfig);
        if (input.catalog !== 'voices') {
          throw new Error('unsupported_voice_catalog');
        }
        const catalog = readCatalog(await input.accountOperations.request({
          operationId: 'list-voices',
          parameters: {},
          signal: input.signal,
        }));
        fixtureEvents.push({
          kind: 'catalog',
          selectedVoiceId: catalog[0].id,
        });
        return catalog;
      },
      async provision(input) {
        const providerConfig = readProviderConfig(input.providerConfig);
        const request = readRecord(input.request);
        if (
          request?.kind !== 'provision_selected_voice'
          || typeof request.voiceId !== 'string'
          || request.voiceId.length < 1
          || request.voiceId.length > 256
        ) {
          throw new Error('invalid_voice_provisioning_request');
        }
        if (!providerConfig.enableProvisioning) {
          throw new Error('voice_provisioning_disabled');
        }
        const provisioning = readProvisioning(
          await input.accountOperations.request({
            operationId: 'provision-voice',
            parameters: {
              voiceId: request.voiceId,
              body: { profile: providerConfig.profile },
            },
            signal: input.signal,
          }),
          request.voiceId,
          providerConfig.profile,
        );
        fixtureEvents.push({ kind: 'provisioned', ...provisioning });
        return {
          ...provisioning,
          disabledActionIds: [...input.disabledActionIds],
          extraSystemAppendBlockCount: input.extraSystemAppendBlocks.length,
        };
      },
    },
    protocol: {
      async prepare(input) {
        const providerConfig = readProviderConfig(input.providerConfig);
        const clientAuth = readClientAuth(await input.accountOperations.request({
          operationId: 'client-auth',
          parameters: {
            body: {
              audience: 'realtime',
              voiceId: FIXTURE_VOICE_ID,
            },
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
        fixtureEvents.push({
          kind: 'prepared',
          profile: providerConfig.profile,
        });
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
        if (event?.kind === 'fixture_transcript') {
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
        if (event?.kind === 'fixture_tool') {
          return [{
            type: 'tool_calls',
            responseId: 'packed-response-1',
            calls: [{
              v: 1,
              responseId: 'packed-response-1',
              callId: 'packed-call-1',
              toolName: 'listMachines',
              order: 0,
              arguments: { limit: 10 },
            }],
          }];
        }
        if (event?.kind === 'fixture_output_started') {
          return [{ type: 'assistant_output_started' }];
        }
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
      const listMachines = input.tools.find((tool) => tool.name === 'listMachines');
      if (!listMachines) {
        throw new Error('required_attempt_tool_unavailable');
      }
      const attemptToolResult = await listMachines.execute({ limit: 10 });
      fixtureEvents.push({
        kind: 'attempt_tool',
        toolName: listMachines.name,
        result: attemptToolResult,
      });
      fixtureEvents.push({ kind: 'connection_created' });
      return input.media.createSdkHandleConnection({
        driver: {
          async open({ onControl }) {
            fixtureEvents.push({ kind: 'host_media_opened' });
            onControl({ kind: 'fixture_transcript' });
            onControl({ kind: 'fixture_tool' });
            onControl({ kind: 'fixture_output_started' });
          },
          async sendControl(event) {
            fixtureEvents.push({ kind: 'sent', event });
          },
          async close(reason) {
            fixtureEvents.push({ kind: 'closed', reason });
          },
        },
      });
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
    requiresMicForConnection: false,
  });
}
