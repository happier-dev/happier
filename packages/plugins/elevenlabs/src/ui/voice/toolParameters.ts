import type { VoiceRealtimeJsonValue } from '@happier-dev/plugin-sdk/voice/client';

/**
 * ElevenLabs API 1.0 (2026-11-06) accepts a restricted property model, not
 * arbitrary JSON Schema (unions, references and unconstrained JSON included).
 * Encode the entire host argument object rather than silently narrowing it.
 * The host remains the validation and approval authority after decoding.
 */
export function toElevenLabsToolParameters(schema: Record<string, unknown>): VoiceRealtimeJsonValue {
  // GET materializes these neutral defaults. Author the same canonical shape so
  // the provisioning owner's exact comparison reuses its selected tools.
  return { type: 'object', description: '', dynamic_variable: '', is_omitted: false,
    required: ['arguments_json'], properties: {
    arguments_json: { type: 'string', enum: null, is_system_provided: false,
      dynamic_variable: '', allowed_values: null, allowed_values_dynamic_variable: '',
      constant_value: '', is_omitted: false, description:
      `A JSON-encoded argument object matching this JSON Schema: ${JSON.stringify(schema)}` },
  } };
}

/** Retained agents authored before this adapter still send native arguments. */
export function readElevenLabsToolArguments(parameters: Record<string, unknown>): unknown {
  if (Object.keys(parameters).length !== 1 || typeof parameters.arguments_json !== 'string') return parameters;
  try { return JSON.parse(parameters.arguments_json); } catch { return null; }
}
