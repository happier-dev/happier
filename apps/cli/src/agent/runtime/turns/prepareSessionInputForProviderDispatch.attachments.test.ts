import { describe, expect, it } from 'vitest';
import { HappierStructuredInputV1Schema } from '@happier-dev/protocol';
import { PluginError } from '@happier-dev/plugin-sdk';

import {
  prepareSessionInputForProviderDispatch,
  readStructuredInputPreparationFailure,
  type SessionInputDispatchServices,
} from './prepareSessionInputForProviderDispatch';
import { StructuredInputComposerAttachmentResolutionError } from './resolveStructuredInputProviderContext';
import { createNativeAgentSessionEffectBoundaryError } from '@/agent/runtime/registry/engineRegistry/nativeAgentSessionBoundaryError';
import { classifyPrimarySessionRuntimeIssue } from '@/agent/runtime/session/errors/classifyPrimarySessionRuntimeIssue';

const structuredInput = HappierStructuredInputV1Schema.parse({
  v: 1,
  composerAttachments: [{
    v: 1,
    instanceId: 'issue-1',
    attachment: { pluginId: 'acme.issue-context', localId: 'issue' },
    key: 'issue-42',
    value: { issueId: '42' },
    presentation: { label: 'Issue #42', typeLabel: 'Issue' },
  }],
});

function prepare(services: SessionInputDispatchServices) {
  return prepareSessionInputForProviderDispatch({
    prompt: { text: 'Review this issue', localId: 'input-1', structuredInput },
    transformedUserText: 'Review this issue',
    providerNativeCommand: false,
    signal: new AbortController().signal,
    localId: 'input-1',
    services,
  });
}

describe('Composer attachment dispatch failure classification', () => {
  it('holds a protected Discussion original when target hydration is unavailable', async () => {
    const failed = await prepareSessionInputForProviderDispatch({
      prompt: { text: 'Read the committed file', localId: 'original-input', discussionAddressing: {
        discussionId: 'discussion-1', messageId: 'question', throughSeq: 2, participantSessionId: 'session-1',
      } }, transformedUserText: 'Read the committed file', providerNativeCommand: false,
      signal: new AbortController().signal, localId: 'original-input', services: { sessionId: 'session-1' },
    }).then(() => null, error => error);
    expect(readStructuredInputPreparationFailure(failed)).toMatchObject({ code: 'discussion_attachment_preparation_unavailable', retryable: true });
  });
  // Only the daemon turn-contribution RPC is substituted. Projection, envelope
  // validation, failure classification and provider context rendering stay real.
  it('distinguishes an absent dispatch service from a resolver that throws', async () => {
    const absent = await prepare({ sessionId: 'session-1' }).catch(error => error);
    expect(readStructuredInputPreparationFailure(absent)).toMatchObject({
      code: 'composer_attachment_resolution_unavailable', retryable: true,
    });

    const privateCause = 'PRIVATE attachment context /private/fixture';
    const failed = await prepare({
      sessionId: 'session-1',
      resolveComposerAttachmentForDispatch: async () => { throw new Error(privateCause); },
    }).catch(error => error);
    const diagnostic = readStructuredInputPreparationFailure(failed);
    expect(diagnostic).toMatchObject({ code: 'composer_attachment_resolution_failed', retryable: true });
    expect(JSON.stringify(diagnostic)).not.toContain(privateCause);
    expect(failed).not.toHaveProperty('cause');
  });

  it('preserves an already classified refusal and cancellation', async () => {
    const refusal = new StructuredInputComposerAttachmentResolutionError(
      'composer_attachment_resolution_invalid', false, 'Invalid selected attachment',
    );
    const cancellation = new DOMException('Cancelled', 'AbortError');
    for (const error of [refusal, cancellation]) {
      await expect(prepare({
        sessionId: 'session-1',
        resolveComposerAttachmentForDispatch: async () => { throw error; },
      })).rejects.toBe(error);
    }
  });

  it('retains code-only daemon refusal evidence without the private exception', async () => {
    const privateText = 'PRIVATE_ACCOUNT_CONTENT_AND_CREDENTIAL';
    const failed = await prepare({ sessionId: 'session-1',
      resolveComposerAttachmentForDispatch: async () => { throw new PluginError({
        code: 'triage_account_storage_unavailable', message: privateText, retryable: true,
        details: { credential: privateText, cause: { code: 'triage_account_storage_unavailable', stage: 'dispatch', requestId: 'preparation-request-132' } },
      }); },
    }).catch((error: unknown) => error);
    expect(readStructuredInputPreparationFailure(failed)).toMatchObject({
      code: 'composer_attachment_resolution_failed', retryable: true,
      preparationCause: { code: 'triage_account_storage_unavailable', stage: 'dispatch', requestId: 'preparation-request-132' },
    });
    expect(classifyPrimarySessionRuntimeIssue({ cause: 'session_error', error: failed, preparingPrompt: true }))
      .toMatchObject({ source: 'dependency_failure', failureCause: { preparationCause: { requestId: 'preparation-request-132' } } });
    expect(JSON.stringify(failed)).not.toContain(privateText);
    expect(failed).not.toHaveProperty('cause');
  });

  it.each([
    createNativeAgentSessionEffectBoundaryError('authority_unavailable_before_effect'),
    new PluginError({ code: 'triage_account_storage_unavailable', message: 'PRIVATE_CREDENTIAL',
      details: { cause: { code: 'PRIVATE_CREDENTIAL', stage: 'not_a_stage' } } }),
  ])('retains a typed refusal when no valid nested cause is available ($code)', async error => {
    const failed = await prepare({ sessionId: 'session-1',
      resolveComposerAttachmentForDispatch: async () => { throw error; },
    }).catch((failure: unknown) => failure);
    expect(readStructuredInputPreparationFailure(failed)).toMatchObject({
      preparationCause: { code: error.code, stage: 'dispatch' },
    });
    expect(JSON.stringify(failed)).not.toContain('PRIVATE_CREDENTIAL');
  });

  it('retains a definitive connected-account refusal instead of making it transient', async () => {
    const failed = await prepare({ sessionId: 'session-1',
      resolveComposerAttachmentForDispatch: async () => { throw new PluginError({
        code: 'github_credential_unavailable', message: 'PRIVATE_CREDENTIAL', retryable: false,
      }); },
    }).catch((failure: unknown) => failure);
    expect(readStructuredInputPreparationFailure(failed)).toMatchObject({ retryable: false,
      preparationCause: { code: 'github_credential_unavailable', stage: 'dispatch' } });
    expect(JSON.stringify(failed)).not.toContain('PRIVATE_CREDENTIAL');
  });

  it('projects an external declared attachment through the real provider preparation', async () => {
    const prepared = await prepare({
      sessionId: 'session-1',
      resolveComposerAttachmentForDispatch: async input => {
        expect(input).toMatchObject({
          sessionId: 'session-1',
          attachment: { pluginId: 'acme.issue-context', localId: 'issue' },
          request: { sessionId: 'session-1', localId: 'input-1' },
        });
        return { attachments: input.request.attachments.map(attachment => ({
          instanceId: attachment.instanceId, status: 'ready', context: 'Authoritative issue context',
        })) };
      },
    });
    expect(prepared.requiredPrompt).toContain('Authoritative issue context');
    expect(prepared.structuredInput).toMatchObject({ resolvedComposerAttachments: [{
      attachment: { pluginId: 'acme.issue-context', localId: 'issue' }, instanceId: 'issue-1',
    }] });
    expect(prepared.structuredInput).not.toHaveProperty('composerAttachments');
  });
});
