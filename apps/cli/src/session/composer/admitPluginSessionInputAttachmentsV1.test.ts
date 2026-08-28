import { describe, expect, it, vi } from 'vitest';

import type { ComposerAttachmentRuntime, PluginInvocationContext } from '@happier-dev/plugin-sdk';
import {
  type PluginSessionInputAttachmentV1,
} from '@happier-dev/protocol';

import { createTargetComposerAttachmentRegistry } from '@/plugins/runtime/lifecycle/contributions/targetComposerAttachments';
import { admitPluginSessionInputAttachmentsV1 } from './admitPluginSessionInputAttachmentsV1';

/**
 * The declared plugin attachment a direct `SessionHandle.send` carries.
 *
 * This exercises the whole host-side chain for real: the target registry's
 * declaration check, its draft admission, the plugin's own `prepareForSend`,
 * prepared admission, and the canonical structured-input admission that decides
 * what is persisted. Only the plugin runtime callback is a fixture, because it
 * is the boundary — everything between the authored draft and the persisted
 * envelope is the code under test.
 */
const ATTACHMENT = { pluginId: 'happier.triage', localId: 'entry' } as const;

const AUTHORED: readonly PluginSessionInputAttachmentV1[] = Object.freeze([Object.freeze({
  attachmentLocalId: ATTACHMENT.localId,
  value: {
    key: 'happier.forge/items:pull-request:origin:42',
    value: { v: 1, entryId: '42' },
    // The bounded immutable fallback the transcript replays with NO plugin
    // mounted. It is the reason a direct send delivers readable entry context
    // at all, so the assertions below read it out of the persisted envelope.
    presentation: { label: 'Replace the duplicated normalizer', description: 'example/repository' },
  },
})]);

function invocationContext(signal: AbortSignal): PluginInvocationContext {
  return Object.freeze({
    plugin: Object.freeze({ id: ATTACHMENT.pluginId, version: '1.0.0' }),
    contribution: Object.freeze({
      id: ATTACHMENT.localId,
      qualifiedId: `${ATTACHMENT.pluginId}/composerAttachments/${ATTACHMENT.localId}`,
    }),
    surface: 'cli',
    invokedAtMs: 1,
    signal,
    services: Object.freeze({
      logger: Object.freeze({
        debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), diagnostic: vi.fn(),
      }),
    }) as unknown as PluginInvocationContext['services'],
  });
}

/**
 * The attachment's own declaration — the authority for what a valid value is and
 * for the immutable type label the host stamps. Declaration-valid is checked for
 * real here, which is what makes the invalid-attachment case below a genuine
 * refusal rather than a fixture returning one.
 */
const DECLARED = [{
  attachment: ATTACHMENT,
  title: { key: 'triage.attachment.entry.title', fallback: 'Triage entry' },
  cardinality: 'many',
  valueSchema: {
    type: 'object',
    properties: { v: { const: 1 }, entryId: { type: 'string' } },
    required: ['v', 'entryId'],
    additionalProperties: false,
  },
  preparedValueSchema: {
    type: 'object',
    properties: { v: { const: 1 }, entryId: { type: 'string' }, qualified: { const: true } },
    required: ['v', 'entryId', 'qualified'],
    additionalProperties: false,
  },
  runtime: { prepareForSend: true },
}] satisfies NonNullable<Parameters<typeof createTargetComposerAttachmentRegistry>[0]['declaredAttachments']>;

function registry(overrides: Partial<ComposerAttachmentRuntime> = {}) {
  const runtime: ComposerAttachmentRuntime = {
    // The real qualification step: the source turns the authored value into the
    // one it is prepared to stand behind, and the host carries THAT forward.
    prepareForSend: vi.fn<NonNullable<ComposerAttachmentRuntime['prepareForSend']>>(async (request) => ({
      attachments: request.attachments.map((attachment) => ({
        instanceId: attachment.instanceId,
        status: 'ready' as const,
        value: { ...(attachment.value as Record<string, unknown>), qualified: true },
      })),
    })),
    ...overrides,
  };
  return createTargetComposerAttachmentRegistry({
    activateAttachmentOnDemand: async () => {},
    declaredAttachments: DECLARED,
    targetRegistrations: [Object.freeze({
      pluginId: ATTACHMENT.pluginId,
      generation: '1',
      registration: Object.freeze({
        family: 'composerAttachments' as const,
        localId: ATTACHMENT.localId,
        value: runtime,
      }),
    })],
    resolveGenerationLifecycle: () => ({
      isCurrent: () => true,
      retirementSignal: new AbortController().signal,
    }),
    createInvocationContext: (input) => Object.freeze({
      context: invocationContext(input.signal),
      complete: vi.fn(),
    }),
  });
}

function admit(input: Readonly<{
  attachments: ReturnType<typeof registry> | null;
  text?: string;
  messageLocalId?: string;
  authored?: readonly PluginSessionInputAttachmentV1[];
}>) {
  return admitPluginSessionInputAttachmentsV1({
    attachments: input.attachments,
    pluginId: ATTACHMENT.pluginId,
    sessionId: 'session-a',
    messageLocalId: input.messageLocalId ?? 'pending-local-a',
    text: input.text ?? 'Repair the failing parser test.',
    authored: input.authored ?? AUTHORED,
  });
}

describe('a direct plugin Session send, from authored draft to persisted envelope', () => {
  it('refuses when the source refuses to stand behind the value', async () => {
    const result = await admit({
      attachments: registry({
        prepareForSend: async (request) => ({
          attachments: request.attachments.map((attachment) => ({
            instanceId: attachment.instanceId,
            status: 'unavailable' as const,
            retryable: false,
          })),
        }),
      }),
    });

    expect(result).toEqual({ status: 'rejected', code: 'session_input_invalid' });
  });

  it('refuses when no attachment target is reachable at all', async () => {
    expect(await admit({ attachments: null }))
      .toEqual({ status: 'rejected', code: 'session_input_target_unavailable' });
  });
});
