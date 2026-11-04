import { PROVIDER_ENDPOINT_SAFETY_LIMITS } from '@happier-dev/protocol';
import { describe, expect, it } from 'vitest';
import type { TeamCredentialRequestPolicyV1 } from '@happier-dev/protocol/teams';
import { classifyTeamCredentialRequestRouteV1, evaluateTeamCredentialRequestPolicyV1, projectTeamCredentialNativeRequestMatchesV1 } from './requestPolicyV1';

// Fixtures use the canonical wire shape the schema parses (mutable arrays),
// not a narrower readonly literal, so the test exercises the real input type.
const policy: TeamCredentialRequestPolicyV1 = {
  allowedProtocolKinds: ['openai_responses', 'openai_chat_completions', 'anthropic_messages'],
  allowedModelIds: ['gpt-5', 'claude'],
  reasoningEffort: { allowedValues: ['low', 'high'], defaultValue: 'low' },
};

function request(pathAndQuery: string, body: unknown) {
  return { pathAndQuery, method: 'POST' as const, body: new TextEncoder().encode(JSON.stringify(body)) };
}

function bodyOf(result: ReturnType<typeof evaluateTeamCredentialRequestPolicyV1>) {
  if (!result.ok || !result.request.body) throw new Error('expected admitted request');
  return JSON.parse(new TextDecoder().decode(result.request.body)) as Record<string, unknown>;
}

describe('projectTeamCredentialNativeRequestMatchesV1', () => {
  it('preserves the admitted Vercel base when projecting exact native Agent requests', () => {
    expect(projectTeamCredentialNativeRequestMatchesV1({
      protocol: 'openai-responses', normalizedUrl: 'https://ai-gateway.vercel.sh/codex/v1',
    })).toEqual([
      { methods: ['POST'], path: '/codex/v1/responses' },
      { methods: ['GET'], path: '/codex/v1/models' },
    ]);
    expect(projectTeamCredentialNativeRequestMatchesV1({
      protocol: 'anthropic', normalizedUrl: 'https://ai-gateway.vercel.sh/claude-code/',
    })).toEqual([
      { methods: ['POST'], path: '/claude-code/v1/messages' },
      { methods: ['POST'], path: '/claude-code/v1/messages/count_tokens' },
    ]);
    // Native URL projection must not widen the existing managed broker routes.
    expect(classifyTeamCredentialRequestRouteV1('/codex/v1/responses')).toBeNull();
    expect(classifyTeamCredentialRequestRouteV1('/v1/messages?beta=true'))
      .toEqual({ kind: 'anthropic_messages', generation: true });
  });

  it('refuses unsupported protocols and unsafe or noncanonical endpoint bases', () => {
    expect(projectTeamCredentialNativeRequestMatchesV1({
      protocol: 'openai-chat', normalizedUrl: 'https://ai-gateway.vercel.sh/coding-agent/v1',
    })).toBeNull();
    for (const normalizedUrl of [
      'http://ai-gateway.vercel.sh/codex/v1',
      'https://key@ai-gateway.vercel.sh/codex/v1',
      'https://ai-gateway.vercel.sh/codex/v1?route=one',
      'https://ai-gateway.vercel.sh/codex/v1#fragment',
      'https://ai-gateway.vercel.sh/codex/%2e%2e/v1',
      'https://ai-gateway.vercel.sh/codex%2fv1',
      'https://ai-gateway.vercel.sh/codex/v1\\other',
    ]) expect(projectTeamCredentialNativeRequestMatchesV1({ protocol: 'openai-responses', normalizedUrl })).toBeNull();
  });
});

describe('evaluateTeamCredentialRequestPolicyV1', () => {
  it('admits inference bodies beyond the unrelated catalog response ceiling', () => {
    const input = 'x'.repeat(8 * 1024 * 1024);
    const result = evaluateTeamCredentialRequestPolicyV1({
      policy,
      request: request('/v1/responses', { model: 'gpt-5', input }),
    });
    expect(result).toMatchObject({ ok: true, modelId: 'gpt-5' });
    expect(bodyOf(result).input).toBe(input);
  });

  it('enforces and rewrites Responses, Chat Completions, and Messages through one owner', () => {
    const responses = evaluateTeamCredentialRequestPolicyV1({ policy, request: request('/v1/responses', { model: 'gpt-5', max_output_tokens: 2048 }) });
    expect(bodyOf(responses)).toMatchObject({ model: 'gpt-5', max_output_tokens: 2048, reasoning: { effort: 'low' } });

    // A request policy carries no token ceiling, so the owner never injects or
    // rewrites an output bound: the caller's own request passes through.
    const chat = evaluateTeamCredentialRequestPolicyV1({ policy, request: request('/v1/chat/completions', { model: 'gpt-5' }) });
    expect(bodyOf(chat)).toEqual({ model: 'gpt-5', reasoning_effort: 'low' });

    const messages = evaluateTeamCredentialRequestPolicyV1({ policy, request: request('/v1/messages', {
      model: 'claude', max_tokens: 4096, thinking: { type: 'enabled', budget_tokens: 3000 },
    }) });
    expect(bodyOf(messages)).toMatchObject({ max_tokens: 4096, output_config: { effort: 'low' }, thinking: { budget_tokens: 3000 } });
  });

  it('rejects malformed, disallowed, conflicting, and unenforceable requests before admission', () => {
    expect(evaluateTeamCredentialRequest('/v1/responses', { model: 'other' })).toMatchObject({ ok: false, reasonCode: 'model_not_allowed' });
    expect(evaluateTeamCredentialRequestPolicyV1({ policy, request: request('/v1/chat/completions', {
      model: 'gpt-5', max_tokens: 1, max_completion_tokens: 1,
    }) })).toMatchObject({ ok: false, reasonCode: 'request_malformed' });
    // Adaptive thinking was refused only because a policy could cap the budget;
    // with no such field it is an ordinary Provider-owned request.
    expect(evaluateTeamCredentialRequestPolicyV1({ policy, request: request('/v1/messages', {
      model: 'claude', max_tokens: 10, thinking: { type: 'adaptive' },
    }) })).toMatchObject({ ok: true });
    expect(evaluateTeamCredentialRequestPolicyV1({ policy, request: request('/v1/messages', {
      model: 'claude', max_tokens: 4096, thinking: { type: 'enabled', budget_tokens: 8192 },
    }) })).toMatchObject({ ok: false, reasonCode: 'request_constraint_unsupported' });
  });

  it('applies the allowlist to the catalog-resolved canonical model', () => {
    const aliasPolicy: TeamCredentialRequestPolicyV1 = {
      ...policy,
      allowedModelIds: ['model-alias', 'canonical-model'],
    };
    const resolveCanonicalModelId = (modelId: string) => modelId === 'model-alias' ? 'canonical-model' : null;

    expect(evaluateTeamCredentialRequestPolicyV1({
      policy: aliasPolicy,
      request: request('/v1/responses', { model: 'model-alias' }),
      resolveCanonicalModelId,
    })).toMatchObject({ ok: true, modelId: 'canonical-model' });
    expect(evaluateTeamCredentialRequestPolicyV1({
      policy: { ...aliasPolicy, allowedModelIds: ['canonical-model'] },
      request: request('/v1/responses', { model: 'model-alias' }),
      resolveCanonicalModelId,
    })).toMatchObject({ ok: true, modelId: 'canonical-model' });
    expect(evaluateTeamCredentialRequestPolicyV1({
      policy: { ...aliasPolicy, allowedModelIds: ['model-alias'] },
      request: request('/v1/responses', { model: 'model-alias' }),
      resolveCanonicalModelId,
    })).toEqual({ ok: false, reasonCode: 'model_not_allowed' });
  });

  it('rejects a model the catalog resolver does not recognize', () => {
    expect(evaluateTeamCredentialRequestPolicyV1({
      policy: { ...policy, allowedModelIds: null },
      request: request('/v1/responses', { model: 'unknown-alias' }),
      resolveCanonicalModelId: () => null,
    })).toEqual({ ok: false, reasonCode: 'model_not_allowed' });
  });

  it('accepts no-thinking Messages without rewriting the caller-authored token budget', () => {
    const result = evaluateTeamCredentialRequestPolicyV1({ policy, request: request('/v1/messages', {
      model: 'claude',
      max_tokens: 8192,
      messages: [{ role: 'user', content: 'hello' }],
      tools: [{ name: 'lookup' }],
    }) });
    expect(bodyOf(result)).toMatchObject({
      model: 'claude',
      max_tokens: 8192,
      output_config: { effort: 'low' },
      messages: [{ role: 'user', content: 'hello' }],
      tools: [{ name: 'lookup' }],
    });
  });

  it('rejects invalid route-specific shapes and Provider-invalid manual thinking before admission', () => {
    expect(evaluateTeamCredentialRequest('/v1/responses/extra', { model: 'gpt-5' }))
      .toMatchObject({ ok: false, reasonCode: 'route_not_allowed' });
    expect(evaluateTeamCredentialRequest('/v1/responses', { model: 'gpt-5', reasoning: [] }))
      .toMatchObject({ ok: false, reasonCode: 'request_malformed' });
    expect(evaluateTeamCredentialRequest('/v1/chat/completions', { model: 'gpt-5', reasoning_effort: 3 }))
      .toMatchObject({ ok: false, reasonCode: 'request_malformed' });
    expect(evaluateTeamCredentialRequest('/v1/messages', { model: 'claude' }))
      .toMatchObject({ ok: false, reasonCode: 'request_malformed' });
    expect(evaluateTeamCredentialRequest('/v1/messages', {
      model: 'claude', max_tokens: 4096, thinking: { type: 'enabled', budget_tokens: 512 },
    })).toMatchObject({ ok: false, reasonCode: 'request_malformed' });
    expect(evaluateTeamCredentialRequest('/v1/messages', {
      model: 'claude', max_tokens: 4096, thinking: { type: 'adaptive', budget_tokens: 2048 },
    })).toMatchObject({ ok: false, reasonCode: 'request_malformed' });
  });

  it('authorizes Anthropic token-count helpers by model without injecting generation constraints', () => {
    const tokenCount = evaluateTeamCredentialRequestPolicyV1({
      policy,
      request: request('/v1/messages/count_tokens', { model: 'claude', messages: [{ role: 'user', content: 'hello' }] }),
    });

    expect(tokenCount).toMatchObject({ ok: true, generation: false, modelId: 'claude' });
    expect(bodyOf(tokenCount)).toEqual({ model: 'claude', messages: [{ role: 'user', content: 'hello' }] });
  });

  it('publishes one normalized request without caller credentials, forwarding metadata, or connection-nominated headers', () => {
    const result = evaluateTeamCredentialRequestPolicyV1({
      policy,
      request: {
        ...request('/v1/responses', { model: 'gpt-5' }),
        headers: {
          Authorization: 'Bearer caller-secret',
          Cookie: 'session=caller-secret',
          Forwarded: 'for=192.0.2.10',
          'X-Forwarded-For': '192.0.2.10',
          Connection: 'X-Remove, keep-alive',
          'X-Remove': 'connection-scoped',
          'X-Happier-Provider-Broker-Authority': 'caller-control',
          'Content-Type': 'application/json',
          'X-Request-Trace': 'trace-1',
        },
      },
    });

    expect(result).toMatchObject({ ok: true });
    if (!result.ok) throw new Error('expected admitted request');
    expect(result.request.headers).toEqual({
      'content-type': 'application/json',
      'x-request-trace': 'trace-1',
    });
  });

  it('rejects malformed or over-bound request metadata before admission', () => {
    expect(evaluateTeamCredentialRequestPolicyV1({
      policy,
      request: {
        ...request('/v1/responses', { model: 'gpt-5' }),
        headers: { 'X-Trace': 'safe', 'x-trace': 'duplicate' },
      },
    })).toEqual({ ok: false, reasonCode: 'request_malformed' });
    expect(evaluateTeamCredentialRequestPolicyV1({
      policy,
      request: {
        ...request('/v1/responses', { model: 'gpt-5' }),
        headers: { 'X-Trace': 'line-one\nline-two' },
      },
    })).toEqual({ ok: false, reasonCode: 'request_malformed' });
    expect(evaluateTeamCredentialRequestPolicyV1({
      policy,
      request: {
        ...request('/v1/responses', { model: 'gpt-5' }),
        headers: { 'X-Upstream-Api-Token': 'caller-secret' },
      },
    })).toEqual({ ok: false, reasonCode: 'request_malformed' });
    expect(evaluateTeamCredentialRequestPolicyV1({
      policy,
      request: request('/v1/responses\\escape', { model: 'gpt-5' }),
    })).toEqual({ ok: false, reasonCode: 'request_malformed' });
    expect(evaluateTeamCredentialRequestPolicyV1({
      policy,
      request: {
        ...request('/v1/responses', { model: 'gpt-5' }),
        headers: { 'X-Trace': 'x'.repeat(PROVIDER_ENDPOINT_SAFETY_LIMITS.maxHeaderValueChars + 1) },
      },
    })).toEqual({ ok: false, reasonCode: 'request_malformed' });
    expect(evaluateTeamCredentialRequestPolicyV1({
      policy,
      request: {
        pathAndQuery: '/v1/responses',
        method: 'POST',
        body: Uint8Array.from([
          ...new TextEncoder().encode('{"model":"gpt-5","input":"'),
          0xff,
          ...new TextEncoder().encode('"}'),
        ]),
      },
    })).toEqual({ ok: false, reasonCode: 'request_malformed' });
  });

});

function evaluateTeamCredentialRequest(pathAndQuery: string, body: unknown) {
  return evaluateTeamCredentialRequestPolicyV1({ policy, request: request(pathAndQuery, body) });
}
