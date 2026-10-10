import { describe, expect, it } from 'vitest';
import { prepareSessionInputForProviderDispatch } from './prepareSessionInputForProviderDispatch';
import { prepareSessionEventMessageViaPort } from '@/api/session/client/transcript/sendMessages';
import { openSessionMessageContent, sealSessionStoredContent } from '@/session/transport/encryption/sessionEncryptionContext';
import { normalizeStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { agentEventLocalIdAttentionImpact } from '@happier-dev/protocol/sessions/messages/transcriptRawRecordV1';
import { createPromptCompositionScope } from '@/agent/prompting/promptComposition';

describe('host dispatch composition evidence', () => {
  it('matches identical dispatched requests only inside the same private host scope, preserving model identity separately', async () => {
    const scope = createPromptCompositionScope();
    const prepare = async (text: string, modelId: string, startup = 'startup policy', requestScope = scope) => {
      const prepared = await prepareSessionInputForProviderDispatch({
        prompt: { text, localId: 'input' }, transformedUserText: text, providerNativeCommand: false,
        signal: new AbortController().signal, localId: 'input', services: { sessionId: 'session',
          modelRequest: { scope: requestScope, startupInstructions: startup,
            selection: { agentTargetKey: 'agent:happier.agent.codex:codex', providerConnectionId: null, modelId } },
        },
      });
      return prepared.readComposition({ deliveryKind: 'newTurn', observedAtMs: 100, turnId: null });
    };
    const first = await prepare('PRIVATE request', 'model-heavy');
    const same = await prepare('PRIVATE request', 'model-light');
    expect(first?.requestIdentity).toMatchObject({ selection: { modelId: 'model-heavy' } });
    expect(same?.requestIdentity).toMatchObject({ digest: first?.requestIdentity?.digest,
      scopeKey: first?.requestIdentity?.scopeKey, selection: { modelId: 'model-light' } });
    expect((await prepare('PRIVATE changed', 'model-heavy'))?.requestIdentity?.digest).not.toBe(first?.requestIdentity?.digest);
    expect((await prepare('PRIVATE request', 'model-heavy', 'changed startup'))?.requestIdentity?.digest).not.toBe(first?.requestIdentity?.digest);
    expect((await prepare('PRIVATE request', 'model-heavy', 'startup policy', createPromptCompositionScope()))?.requestIdentity?.digest).not.toBe(first?.requestIdentity?.digest);
    expect(JSON.stringify(first)).not.toMatch(/PRIVATE|startup policy/);
  });
  it.each(['newTurn', 'steer'] as const)('measures only the final %s request without retaining content', async (deliveryKind) => {
    const prepared = await prepareSessionInputForProviderDispatch({
      prompt: { text: 'PRIVATE user 🦉', localId: 'input-1', inputContextBlock: 'PRIVATE provenance' },
      transformedUserText: 'PRIVATE user 🦉', providerNativeCommand: false,
      signal: new AbortController().signal, localId: 'input-1',
      services: { sessionId: 'session-1' },
    });
    const finalPrompt = prepared.renderPrompt({ workerUpdates: [{ v: 1, workerKind: 'session',
      workerId: 'worker-1', ownerState: 'published', wake: 'published', canInspect: false,
      headline: 'PRIVATE final worker 🦉 /private/repo', }] });
    expect(finalPrompt).not.toBe(prepared.requiredPrompt);
    expect(prepared).toHaveProperty('readComposition');
    // The owner creates the projection from the actually rendered request, after optional context.
    const result = prepared.readComposition({ deliveryKind, observedAtMs: 100, turnId: null });
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
    expect(result).toMatchObject({ boundary: 'host_pre_dispatch', coverage: 'host_only', nativePrefix: null,
      contextWindowTokens: null, deliveryKind,
      components: expect.arrayContaining([expect.objectContaining({ tokenCount: null, tokenizerId: null,
        byteLength: Buffer.byteLength(finalPrompt), cacheClass: 'unknown', location: 'user' })]),
    });
  });
  it.each(['plain', 'e2ee'] as const)('retains only the projected record through the existing %s Session channel and refuses the opposite mode', async mode => {
    const prepared = await prepareSessionInputForProviderDispatch({
      prompt: { text: 'PRIVATE source /private/repo', localId: 'input-1' },
      transformedUserText: 'PRIVATE source /private/repo', providerNativeCommand: false,
      signal: new AbortController().signal, localId: 'input-1', services: { sessionId: 'session-1' },
    });
    expect(prepared).toHaveProperty('readComposition');
    const composition = prepared.readComposition({ deliveryKind: 'newTurn', observedAtMs: 100, turnId: null });
    if (!composition) throw new Error('Session-scoped preparation must produce composition');
    const event = { type: 'prompt-composition' as const,
      composition };
    const ctx = { encryptionKey: new Uint8Array(32).fill(9), encryptionVariant: 'dataKey' as const };
    const crypto = mode === 'plain' ? { mode, ctx: null } : { mode, ctx };
    const retained = prepareSessionEventMessageViaPort({ buildOutboundSessionMessagePayload: payload => {
      const sealed = sealSessionStoredContent({ ...crypto, payload: normalizeStrictJsonValue(payload) });
      return sealed.t === 'encrypted' ? sealed.c : sealed;
    } }, event);
    expect(retained.messageRole).toBe('event');
    expect(agentEventLocalIdAttentionImpact(retained.localId)).toEqual({ affectsUnread: false,
      affectsMeaningfulActivity: false });
    const content = typeof retained.payload === 'string' ? { t: 'encrypted' as const, c: retained.payload } : retained.payload;
    expect(openSessionMessageContent({ ...crypto, content })).toMatchObject({ role: 'agent',
      content: { type: 'event', data: event } });
    expect(JSON.stringify(openSessionMessageContent({ ...crypto, content }))).not.toMatch(/PRIVATE|\/private\/repo/);
    expect(() => openSessionMessageContent({ ...(mode === 'plain' ? { mode: 'e2ee' as const, ctx } : { mode: 'plain' as const, ctx: null }),
      content })).toThrowError(expect.objectContaining({ code: 'session_content_mode_mismatch' }));
  });
});
