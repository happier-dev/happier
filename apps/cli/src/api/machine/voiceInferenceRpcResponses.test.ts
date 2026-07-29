import { describe, expect, it } from 'vitest';

import { toVoiceInferenceError } from './voiceInferenceRpcResponses';

describe('voiceInferenceRpcResponses', () => {
  it('preserves unsupported_runtime_family as a typed public daemon error', () => {
    expect(toVoiceInferenceError(Object.assign(new Error('private detail'), {
      code: 'unsupported_runtime_family',
    }))).toEqual({
      ok: false,
      errorCode: 'unsupported_runtime_family',
      error: 'voice_inference_unsupported_runtime_family',
    });
  });

  it('normalizes a private runtime deadline to the public request timeout contract', () => {
    expect(toVoiceInferenceError(Object.assign(new Error('worker deadline detail'), {
      code: 'runtime_timeout',
    }))).toEqual({
      ok: false,
      errorCode: 'request_timeout',
      error: 'voice_inference_request_timeout',
    });
  });
});
