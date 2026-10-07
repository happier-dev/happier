import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';

import { createEnvKeyScope } from '@/testkit/env/envScope';
import { createTempDirSync, removeTempDirSync } from '@/testkit/fs/tempDir';

import {
  HappierStructuredInputV1Schema,
  MENTION_BOUNDS,
  MENTION_KIND_V1,
  buildComposerReferenceMentionPayloadV1,
  buildMentionRefForKindV1,
  renderSessionInputContextPromptV1,
  type HappierStructuredInputV1,
} from '@happier-dev/protocol';

import { buildCodexAppServerTurnInput } from '@happier-dev/plugins-codex/agent/runtime/appServer/turnInput';
import { SessionSkillCatalogListResponseV1Schema } from '@happier-dev/protocol/sessions/work/state/sessionWorkStateRpc';
import { buildOpenCodePromptParts } from '../../../../../../packages/plugins/opencode/src/agent/runtime/server/promptParts';
import { createOpenCodeServerClient, type OpenCodeRuntimeFetch } from '../../../../../../packages/plugins/opencode/src/agent/runtime/server/openCodeServerClient';
import {
  ResolvedMentionContextTooLargeError,
  StructuredInputMentionResolutionError,
  resolveStructuredInputProviderDispatchContext,
  type StructuredInputComposerAttachmentResolver,
} from './resolveStructuredInputProviderContext';

function renderPromptContext(
  value: Awaited<ReturnType<typeof resolveStructuredInputProviderDispatchContext>>,
): string {
  return renderSessionInputContextPromptV1({
    ...value.promptContext,
    transformedUserText: '',
  });
}

it('dispatches selected browser context once with real-image references, not metadata-only success', async () => {
  const media = {
    mediaId: 'shot', mediaKind: 'image', width: 2, height: 2, sizeBytes: 8,
    file: { sessionId: 'session-1', storage: 'session', path: '.happier/uploads/artifacts/session-1/capture/screen.png',
      sha256: 'a'.repeat(64), mimeType: 'image/png' },
  } as const;
  const structuredInput = HappierStructuredInputV1Schema.parse({
    v: 1, browserContext: {
      contexts: [{ v: 1, contextId: 'shot-1', sourceViewId: 'view-1', sourceAdapterKind: 'chromiumSidecar',
        fidelity: 'cdp', capturedAtMs: 1, navigationGeneration: 2, lifecycleState: 'available',
        redactionLevel: 'metadataOnly', kind: 'browserScreenshot', media }],
      attachments: [{ v: 1, attachmentId: 'attachment-1', contextId: 'shot-1', sourceViewId: 'view-1',
        capturedNavigationGeneration: 2, currentNavigationGeneration: 2, state: 'available' }],
    },
  });
  const result = await resolveStructuredInputProviderDispatchContext({ structuredInput });
  expect(result.structuredInput?.imageInputs).toMatchObject([{ kind: 'localImage', path: media.file.path,
    sha256: media.file.sha256, provenance: { kind: 'browserSessionMedia', sessionId: 'session-1' } }]);
  expect(renderPromptContext(result)).toContain('shot-1');
  expect(renderPromptContext(result).match(/<happier_browser_context>/g)).toHaveLength(1);
  const missing = HappierStructuredInputV1Schema.parse({ ...structuredInput, browserContext: {
    ...structuredInput.browserContext, contexts: structuredInput.browserContext!.contexts.map((item) => ({ ...item, media: { ...media, file: undefined } })),
  } });
  await expect(resolveStructuredInputProviderDispatchContext({ structuredInput: missing })).rejects.toMatchObject({ code: 'browser_media_unavailable' });
});

/** Catalog items in the shape `session.skill_catalog.list` / `session.vendor_plugin_catalog.list` return. */
const SKILL_ITEM = {
  name: 'review',
  displayName: 'Review',
  description: 'Review a diff',
  path: '/w/.codex/skills/review/SKILL.md',
  enabled: true,
  origin: 'codex_native',
};

const OTHER_SKILL_ITEM = {
  name: 'plan',
  path: '/w/.codex/skills/plan/SKILL.md',
  enabled: true,
  origin: 'codex_native',
};

const VENDOR_ITEM = {
  vendorPluginRef: 'plugin://linear@happier',
  name: 'linear',
  displayName: 'Linear',
  installed: true,
  enabled: true,
};

const SKILL_REF = buildMentionRefForKindV1(MENTION_KIND_V1.skill, 'vendor:codex:review');
const VENDOR_REF = buildMentionRefForKindV1(MENTION_KIND_V1.vendorPlugin, VENDOR_ITEM.vendorPluginRef);
const TEXT = 'run $review with @linear';

const SKILL_MENTION = { kind: MENTION_KIND_V1.skill, ref: SKILL_REF, token: '$review', start: 4, end: 11 };
const VENDOR_MENTION = { kind: MENTION_KIND_V1.vendorPlugin, ref: VENDOR_REF, token: '@linear', start: 17, end: 24 };
const COMPOSER_REFERENCE = { pluginId: 'acme.issues', localId: 'issues' } as const;
const COMPOSER_MENTION = {
  ...buildComposerReferenceMentionPayloadV1({
    reference: COMPOSER_REFERENCE,
    candidate: { id: 'issue:42', label: 'Issue 42', description: 'Issue selected in the composer' },
  }),
  token: '@issue-42',
  start: 0,
  end: 9,
};
const SESSION_REF = buildMentionRefForKindV1(MENTION_KIND_V1.session, 'source-session');
const SESSION_MENTION = {
  kind: MENTION_KIND_V1.session,
  ref: SESSION_REF,
  token: '@session:source',
  start: 0,
  end: 15,
};
const COMPOSER_ATTACHMENT = {
  v: 1,
  instanceId: 'review-comment-1',
  attachment: { pluginId: 'acme.review-comments', localId: 'review-comment' },
  key: 'comment-1',
  value: { reviewId: 'review-1' },
  presentation: { label: 'Review comment', typeLabel: 'Review comment' },
} as const;
const OTHER_COMPOSER_ATTACHMENT = {
  ...COMPOSER_ATTACHMENT,
  instanceId: 'issue-1',
  attachment: { pluginId: 'acme.issues', localId: 'issue-context' },
  key: 'issue-42',
  value: { issueId: '42' },
  presentation: { label: 'Issue 42', typeLabel: 'Issue' },
} as const;
const SECOND_COMPOSER_ATTACHMENT = {
  ...COMPOSER_ATTACHMENT,
  instanceId: 'review-comment-2',
  key: 'comment-2',
  value: { reviewId: 'review-2' },
  presentation: { label: 'Second review comment', typeLabel: 'Review comment' },
} as const;
const SESSION_MEDIA_IMAGE = {
  id: 'media-image-1',
  role: 'input',
  category: 'attachment',
  mediaKind: 'image',
  mimeType: 'image/png',
  name: 'review.png',
  path: '.happier/uploads/messages/session-1/local-1/review.png',
  sizeBytes: 67,
  sha256: 'a'.repeat(64),
  origin: { source: 'user-upload' },
} as const;
const SESSION_MEDIA_VIDEO = {
  id: 'media-video-1',
  role: 'input',
  category: 'attachment',
  mediaKind: 'video',
  mimeType: 'video/webm',
  name: 'review.webm',
  path: '.happier/uploads/messages/session-1/local-1/review.webm',
  sizeBytes: 67,
  sha256: 'b'.repeat(64),
  origin: { source: 'user-upload' },
} as const;

function catalogs(overrides: Partial<{ listSkills: () => Promise<unknown>; listVendorPlugins: () => Promise<unknown> }> = {}) {
  return {
    listSkills: async () => ({ skills: [OTHER_SKILL_ITEM, SKILL_ITEM] }),
    listVendorPlugins: async () => ({ vendorPlugins: [VENDOR_ITEM] }),
    ...overrides,
  };
}

function envelope(value: Record<string, unknown>): HappierStructuredInputV1 {
  return HappierStructuredInputV1Schema.parse({ v: 1, ...value });
}

async function resolveStructuredInputProviderContext(
  params: Parameters<typeof resolveStructuredInputProviderDispatchContext>[0],
) {
  return (await resolveStructuredInputProviderDispatchContext(params)).structuredInput;
}

const MENTIONS_ONLY = envelope({ mentions: [SKILL_MENTION, VENDOR_MENTION] });

/** The legacy envelope the composer writes today for the same two selections. */
const LEGACY = envelope({
  skillMentions: [{
    id: 'vendor:codex:review',
    name: 'review',
    path: '/w/.codex/skills/review/SKILL.md',
    displayName: 'Review',
    description: 'Review a diff',
    origin: 'vendor',
    backendId: 'codex',
  }],
  vendorPluginMentions: [{ vendorPluginRef: 'plugin://linear@happier', label: 'Linear' }],
});

describe('structured input catalog diagnostics', () => {
  const envKeys = ['DEBUG', 'HAPPIER_HOME_DIR', 'HAPPIER_LOG_LEVEL'] as const;
  let envScope = createEnvKeyScope(envKeys);
  let tempDir: string;

  beforeEach(() => {
    envScope = createEnvKeyScope(envKeys);
    tempDir = createTempDirSync('happier-structured-dispatch-log-');
    envScope.patch({ HAPPIER_HOME_DIR: tempDir, DEBUG: undefined, HAPPIER_LOG_LEVEL: undefined });
    vi.resetModules();
  });

  afterEach(() => {
    envScope.restore();
    removeTempDirSync(tempDir);
  });

  it.each([
    { catalog: 'skills', reason: 'failed', read: async () => { throw new Error('private catalog failure'); } },
    { catalog: 'skills', reason: 'malformed', read: async () => 'private malformed catalog' },
    { catalog: 'vendorPlugins', reason: 'unsupported', read: async () => ({ supported: false, vendorPlugins: [] }) },
  ] as const)('records $catalog catalog $reason in normal file logs without a caller diagnostic hook', async ({ catalog, reason, read }) => {
    const { resolveStructuredInputProviderDispatchContext: resolveDispatch } = await import('./resolveStructuredInputProviderContext');
    const { logger } = await import('@/ui/logger');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const resolution = await resolveDispatch({
        structuredInput: envelope({ mentions: [catalog === 'skills' ? SKILL_MENTION : VENDOR_MENTION] }),
        catalogs: catalog === 'skills' ? { listSkills: read } : { listVendorPlugins: read },
      });
      logger.flushSync();

      expect(buildCodexAppServerTurnInput({ text: 'private user prompt', structuredInput: resolution.structuredInput })).toEqual([
        { type: 'text', text: 'private user prompt' },
      ]);
      expect(renderPromptContext(resolution)).toBe('');
      expect(logSpy).not.toHaveBeenCalled();
      expect(existsSync(logger.getLogPath())).toBe(true);
      const content = readFileSync(logger.getLogPath(), 'utf8');
      expect(content).toContain(`${catalog} catalog ${reason}`);
      expect(content).toContain('1 composer reference(s) contributed no provider item');
      expect(content).not.toContain('private');
    } finally {
      logSpy.mockRestore();
    }
  });
});

describe('resolveStructuredInputProviderContext', () => {
  it.each([
    { suppliedId: undefined, nativeId: 'native-review-directory' },
    { suppliedId: 'vendor:opencode:Reviewer', nativeId: 'vendor:opencode:Reviewer' },
  ])('resolves a legacy canonical skill reference with supplied ID $suppliedId to its actual V2 native identity before HTTP admission', async ({ suppliedId, nativeId }) => {
    const skillPath = '/repo/.opencode/skills/review/SKILL.md';
    const catalog = SessionSkillCatalogListResponseV1Schema.parse({ skills: [{
      ...(suppliedId ? { id: suppliedId } : {}), name: 'Reviewer', location: skillPath, origin: 'opencode_native',
    }] });
    const result = await resolveStructuredInputProviderDispatchContext({
      structuredInput: envelope({ mentions: [{
        ...SKILL_MENTION,
        ref: buildMentionRefForKindV1(MENTION_KIND_V1.skill, catalog.skills[0]!.id),
      }] }),
      catalogs: { listSkills: async () => catalog },
    });
    const admitted: unknown[] = [];
    // HTTP is the boundary; catalog schemas, resolver, semantic projection and V2 wire stay real.
    const request: OpenCodeRuntimeFetch = async (input) => {
      if (input.method === 'POST') admitted.push(JSON.parse(String(input.body)));
      const payload = input.method === 'GET'
        ? { data: [{ id: nativeId, name: 'Reviewer', path: skillPath },
          { id: 'other-native-review', name: 'Reviewer', path: '/other/SKILL.md' }] }
        : null;
      return { ok: true, status: payload ? 200 : 204, headers: {},
        text: async () => JSON.stringify(payload), json: async () => payload,
        arrayBuffer: async () => new ArrayBuffer(0) };
    };
    const client = createOpenCodeServerClient({
      dialect: 'v2', directory: '/repo', transport: { request, fetch: async () => new Response(null, { status: 204 }) },
    });
    await client.sessionPromptAsync({ sessionId: 'ses-1', text: 'Review this',
      parts: await buildOpenCodePromptParts({ text: 'Review this', structuredInput: result.structuredInput }) });
    expect(admitted).toEqual([{ text: 'Review this', skills: [{ id: nativeId }] }]);
  });

  it('retains the authoritative native skill id when resolving a composer reference', async () => {
    const result = await resolveStructuredInputProviderDispatchContext({
      structuredInput: envelope({ mentions: [{
        ...SKILL_MENTION,
        ref: buildMentionRefForKindV1(MENTION_KIND_V1.skill, 'review-directory'),
      }] }),
      catalogs: catalogs({ listSkills: async () => ({ skills: [{
        id: 'review-directory',
        name: 'security-review',
        path: '/repo/.opencode/skills/review-directory/SKILL.md',
        origin: 'vendor',
        backendId: 'opencode',
      }] }) }),
    });
    expect(result.structuredInput).toMatchObject({ skillMentions: [{
      id: 'review-directory',
      name: 'security-review',
      path: '/repo/.opencode/skills/review-directory/SKILL.md',
    }] });
  });
  it('projects a selected verified SessionMedia image into the canonical trusted image input', async () => {
    const result = await resolveStructuredInputProviderDispatchContext({
      structuredInput: envelope({
        composerAttachments: [{
          ...COMPOSER_ATTACHMENT,
          content: { kind: 'sessionMedia', mediaId: SESSION_MEDIA_IMAGE.id },
        }],
      }),
      sessionMedia: [SESSION_MEDIA_IMAGE],
      composerAttachments: {
        scope: { kind: 'session', sessionId: 'session-1' },
        localId: 'local-1',
        resolve: async (input) => ({
          attachments: input.request.attachments.map((attachment) => ({
            instanceId: attachment.instanceId,
            status: 'ready' as const,
            data: { resolved: true },
          })),
        }),
        signal: new AbortController().signal,
      },
    });

    expect(result.structuredInput?.imageInputs).toEqual([{
      id: `session-media:${SESSION_MEDIA_IMAGE.id}`,
      kind: 'localImage',
      path: SESSION_MEDIA_IMAGE.path,
      mimeType: SESSION_MEDIA_IMAGE.mimeType,
      label: SESSION_MEDIA_IMAGE.name,
      sha256: SESSION_MEDIA_IMAGE.sha256,
      sizeBytes: SESSION_MEDIA_IMAGE.sizeBytes,
      provenance: { kind: 'sessionAttachmentUpload' },
    }]);
  });

  it('rejects selected verified SessionMedia video before Agent dispatch', async () => {
    await expect(resolveStructuredInputProviderDispatchContext({
      structuredInput: envelope({
        composerAttachments: [{
          ...COMPOSER_ATTACHMENT,
          content: { kind: 'sessionMedia', mediaId: SESSION_MEDIA_VIDEO.id },
        }],
      }),
      sessionMedia: [SESSION_MEDIA_VIDEO],
      composerAttachments: {
        scope: { kind: 'session', sessionId: 'session-1' },
        localId: 'local-1',
        resolve: vi.fn(),
        signal: new AbortController().signal,
      },
    })).rejects.toMatchObject({
      code: 'session_media_video_unsupported',
      retryable: false,
    });
  });

  it('resolves attachment groups at dispatch, preserves author order, and removes raw attachment values', async () => {
    const listSkills = vi.fn(async () => ({ skills: [SKILL_ITEM] }));
    const resolve = vi.fn(async (
      input: Parameters<StructuredInputComposerAttachmentResolver['resolve']>[0],
    ) => {
      if ('scope' in input.request) throw new Error('Expected Session V1 attachment request');
      return {
      attachments: input.request.attachments.map((attachment) => ({
        instanceId: attachment.instanceId,
        status: 'ready' as const,
        context: `Fresh context for ${attachment.instanceId}`,
        data: { refreshedKey: attachment.key },
      })),
      };
    });
    const signal = new AbortController().signal;

    const result = await resolveStructuredInputProviderDispatchContext({
      structuredInput: envelope({
        composerAttachments: [COMPOSER_ATTACHMENT, OTHER_COMPOSER_ATTACHMENT, SECOND_COMPOSER_ATTACHMENT],
      }),
      catalogs: { listSkills },
      composerAttachments: {
        scope: { kind: 'session', sessionId: 'session-1' },
        localId: 'local-1',
        resolve,
        signal,
      },
    });

    expect(listSkills).not.toHaveBeenCalled();
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(resolve).toHaveBeenNthCalledWith(1, {
      attachment: { pluginId: 'acme.review-comments', localId: 'review-comment' },
      request: {
        sessionId: 'session-1',
        localId: 'local-1',
        attachments: [
          { instanceId: 'review-comment-1', key: 'comment-1', value: { reviewId: 'review-1' } },
          { instanceId: 'review-comment-2', key: 'comment-2', value: { reviewId: 'review-2' } },
        ],
      },
      signal,
    });
    expect(resolve).toHaveBeenNthCalledWith(2, {
      attachment: { pluginId: 'acme.issues', localId: 'issue-context' },
      request: {
        sessionId: 'session-1',
        localId: 'local-1',
        attachments: [{ instanceId: 'issue-1', key: 'issue-42', value: { issueId: '42' } }],
      },
      signal,
    });
    expect(result.structuredInput).toEqual({
      v: 1,
      resolvedComposerAttachments: [
        { ...COMPOSER_ATTACHMENT, data: { refreshedKey: 'comment-1' } },
        { ...OTHER_COMPOSER_ATTACHMENT, data: { refreshedKey: 'issue-42' } },
        { ...SECOND_COMPOSER_ATTACHMENT, data: { refreshedKey: 'comment-2' } },
      ],
    });
    const contextBlock = renderPromptContext(result);
    expect(contextBlock).toContain('attachment_instance_id="review-comment-1"');
    expect(contextBlock.indexOf('attachment_instance_id="review-comment-1"'))
      .toBeLessThan(contextBlock.indexOf('attachment_instance_id="issue-1"'));
    expect(contextBlock.indexOf('attachment_instance_id="issue-1"'))
      .toBeLessThan(contextBlock.indexOf('attachment_instance_id="review-comment-2"'));
    expect(contextBlock).not.toContain('reviewId');
  });

  it('stamps detached attachment resolution with the exact execution-run scope', async () => {
    const resolve = vi.fn(async (
      input: Parameters<StructuredInputComposerAttachmentResolver['resolve']>[0],
    ) => {
      if (!('scope' in input.request) || input.request.scope.kind !== 'execution_run') {
        throw new Error('Expected detached Execution Run V2 attachment request');
      }
      return {
      attachments: input.request.attachments.map((attachment) => ({
        instanceId: attachment.instanceId,
        status: 'ready' as const,
        context: `Detached context for ${attachment.key}`,
      })),
      };
    });

    await expect(resolveStructuredInputProviderDispatchContext({
      structuredInput: envelope({ composerAttachments: [COMPOSER_ATTACHMENT] }),
      composerAttachments: {
        scope: { kind: 'execution_run', executionRunId: 'run-1' },
        localId: 'local-1',
        resolve,
        signal: new AbortController().signal,
      },
    })).resolves.toMatchObject({
      structuredInput: {
        resolvedComposerAttachments: [expect.objectContaining({ instanceId: 'review-comment-1' })],
      },
    });
    expect(resolve).toHaveBeenCalledWith(expect.objectContaining({
      request: expect.objectContaining({
        scope: { kind: 'execution_run', executionRunId: 'run-1' },
      }),
    }));
  });

  it('rejects SessionMedia before detached provider effects', async () => {
    const resolve = vi.fn();

    await expect(resolveStructuredInputProviderDispatchContext({
      structuredInput: envelope({
        composerAttachments: [{
          ...COMPOSER_ATTACHMENT,
          content: { kind: 'sessionMedia', mediaId: SESSION_MEDIA_IMAGE.id },
        }],
      }),
      sessionMedia: [SESSION_MEDIA_IMAGE],
      composerAttachments: {
        scope: { kind: 'execution_run', executionRunId: 'run-1' },
        localId: 'local-1',
        resolve,
        signal: new AbortController().signal,
      },
    })).rejects.toMatchObject({
      code: 'session_media_scope_unavailable',
      retryable: false,
    });
    expect(resolve).not.toHaveBeenCalled();
  });

  it('keeps a ready textless attachment model-visible when the plugin supplies no context', async () => {
    const resolve = vi.fn(async () => ({
      attachments: [{
        instanceId: 'review-comment-1',
        status: 'ready' as const,
      }],
    }));

    const result = await resolveStructuredInputProviderDispatchContext({
      structuredInput: envelope({ composerAttachments: [COMPOSER_ATTACHMENT] }),
      composerAttachments: {
        scope: { kind: 'session', sessionId: 'session-1' },
        localId: 'local-1',
        resolve,
        signal: new AbortController().signal,
      },
    });

    const contextBlock = renderPromptContext(result);
    expect(contextBlock).toContain('<happier_composer_attachment_context');
    expect(contextBlock).toContain('attachment_plugin_id="acme.review-comments"');
    expect(contextBlock).toContain('attachment_local_id="review-comment"');
    expect(contextBlock).toContain('attachment_instance_id="review-comment-1"');
    expect(contextBlock).toContain('attachment_key="comment-1"');
    expect(contextBlock).not.toContain('context=');
    expect(result.structuredInput).toEqual({
      v: 1,
      resolvedComposerAttachments: [COMPOSER_ATTACHMENT],
    });
  });

  it('does not invoke an attachment resolver after its dispatch scope is already aborted', async () => {
    const controller = new AbortController();
    const cancellation = new Error('turn cancelled before attachment dispatch');
    controller.abort(cancellation);
    const resolve = vi.fn();

    await expect(resolveStructuredInputProviderDispatchContext({
      structuredInput: envelope({ composerAttachments: [COMPOSER_ATTACHMENT] }),
      composerAttachments: {
        scope: { kind: 'session', sessionId: 'session-1' },
        localId: 'local-1',
        resolve,
        signal: controller.signal,
      },
    })).rejects.toBe(cancellation);

    expect(resolve).not.toHaveBeenCalled();
  });

  it('blocks the entire attachment projection when one selected instance is not ready', async () => {
    const resolve = vi.fn(async () => ({
      attachments: [
        { instanceId: 'review-comment-1', status: 'ready' as const, context: 'Ready peer' },
        { instanceId: 'review-comment-2', status: 'failed' as const, retryable: false, message: 'Removed remotely' },
      ],
    }));

    await expect(resolveStructuredInputProviderDispatchContext({
      structuredInput: envelope({ composerAttachments: [COMPOSER_ATTACHMENT, SECOND_COMPOSER_ATTACHMENT] }),
      composerAttachments: {
        scope: { kind: 'session', sessionId: 'session-1' },
        localId: 'local-1',
        resolve,
        signal: new AbortController().signal,
      },
    })).rejects.toMatchObject({
      code: 'composer_attachment_resolution_failed',
      retryable: false,
    });
    expect(resolve).toHaveBeenCalledOnce();
  });

  it('rejects a malformed attachment envelope rather than treating it as absent', async () => {
    await expect(resolveStructuredInputProviderDispatchContext({
      structuredInput: {
        v: 1,
        composerAttachments: { forged: true },
      } as unknown as HappierStructuredInputV1,
    })).rejects.toMatchObject({ code: 'composer_attachment_resolution_invalid', retryable: false });
  });

  it('rejects duplicate attachment semantic identities before dispatch resolution', async () => {
    await expect(resolveStructuredInputProviderDispatchContext({
      structuredInput: envelope({
        composerAttachments: [
          COMPOSER_ATTACHMENT,
          { ...COMPOSER_ATTACHMENT, instanceId: 'review-comment-duplicate' },
        ],
      }),
    })).rejects.toMatchObject({ code: 'composer_attachment_resolution_invalid', retryable: false });
  });

  it('projects a same-server Session reference as an identity-only tool hint at dispatch', async () => {
    const result = await resolveStructuredInputProviderDispatchContext({
      structuredInput: envelope({ mentions: [SESSION_MENTION] }),
    });

    const contextBlock = renderPromptContext(result);
    expect(contextBlock).toContain('<happier_session_reference>');
    expect(contextBlock).toContain('source-session');
    expect(contextBlock).toContain('No transcript content is included');
    expect(contextBlock).not.toContain('<happier_session_reference_context');
    expect(result.structuredInput).toEqual({ v: 1 });
  });

  it('shares one bounded model-context budget across plugin and Session references', async () => {
    const resolveComposerReference = vi.fn(async () => ({
      id: 'issue:42',
      label: 'Issue 42',
      context: 'plugin-context '.repeat(40),
    }));

    const result = await resolveStructuredInputProviderDispatchContext({
      structuredInput: envelope({ mentions: [COMPOSER_MENTION, { ...SESSION_MENTION, start: 10, end: 25 }] }),
      composerReferences: {
        resolve: resolveComposerReference,
        signal: new AbortController().signal,
      },
    });

    expect(resolveComposerReference).toHaveBeenCalledTimes(1);
    expect(Array.from(renderPromptContext(result)).length)
      .toBeLessThanOrEqual(MENTION_BOUNDS.maxResolvedContextChars);
  });

  it('rejects when Session, skill, and vendor context exceed one shared bound', async () => {
    const references = {
      catalogs: {
        listSkills: async () => ({
          skills: [{ ...SKILL_ITEM, description: 'skill-context '.repeat(75) }],
        }),
        listVendorPlugins: async () => ({
          vendorPlugins: [{ ...VENDOR_ITEM, displayName: 'vendor-context '.repeat(75) }],
        }),
      },
    };
    const skillMention = { ...SKILL_MENTION, start: 16, end: 23 };
    const vendorMention = { ...VENDOR_MENTION, start: 24, end: 31 };

    // Neither resolved legacy array is too large with the Session tool hint on its own. The
    // failure is the cross-kind sum, which a per-kind cap or a block-only check would miss.
    await expect(resolveStructuredInputProviderDispatchContext({
      structuredInput: envelope({ mentions: [SESSION_MENTION, skillMention] }),
      ...references,
    })).resolves.toBeDefined();
    await expect(resolveStructuredInputProviderDispatchContext({
      structuredInput: envelope({ mentions: [SESSION_MENTION, vendorMention] }),
      ...references,
    })).resolves.toBeDefined();

    const resolved = resolveStructuredInputProviderDispatchContext({
      structuredInput: envelope({
        mentions: [SESSION_MENTION, skillMention, vendorMention],
      }),
      ...references,
    });

    const error = await resolved.catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(ResolvedMentionContextTooLargeError);
    expect(error).toMatchObject({
      code: 'mention_resolved_context_too_large',
      maxChars: MENTION_BOUNDS.maxResolvedContextChars,
    });
    expect((error as ResolvedMentionContextTooLargeError).totalChars)
      .toBeGreaterThan(MENTION_BOUNDS.maxResolvedContextChars);
  });

  it('resolves a qualified composer reference only into the ephemeral prompt block', async () => {
    const resolve = vi.fn(async () => ({
      id: 'issue:42',
      label: 'Issue 42 (current)',
      description: 'Fresh issue summary',
      context: 'The issue is ready for review.',
    }));
    const result = await resolveStructuredInputProviderDispatchContext({
      structuredInput: envelope({ mentions: [COMPOSER_MENTION, SKILL_MENTION] }),
      catalogs: catalogs(),
      composerReferences: {
        resolve,
        signal: new AbortController().signal,
      },
    });

    expect(resolve).toHaveBeenCalledWith({
      reference: COMPOSER_REFERENCE,
      candidateId: 'issue:42',
      signal: expect.any(AbortSignal),
    });
    expect(result.structuredInput?.skillMentions).toEqual(LEGACY.skillMentions?.map((item) => ({ ...item, idSource: 'generated' })));
    expect(result.structuredInput?.mentions).toBeUndefined();
    expect(JSON.stringify(result.structuredInput)).not.toContain('The issue is ready for review.');
    const contextBlock = renderPromptContext(result);
    expect(contextBlock).toContain('reference_plugin_id="acme.issues"');
    expect(contextBlock).toContain('candidate_id="issue:42"');
    expect(contextBlock).toContain('The issue is ready for review.');
  });

  it('does not attach context when current-generation resolve rejects', async () => {
    const stale = Object.assign(new Error('retired'), { code: 'plugin_generation_stale' });

    await expect(resolveStructuredInputProviderDispatchContext({
      structuredInput: envelope({ mentions: [COMPOSER_MENTION] }),
      composerReferences: {
        resolve: async () => { throw stale; },
        signal: new AbortController().signal,
      },
    })).rejects.toBe(stale);
  });

  it('rejects a late composer-reference result after its dispatch scope is cancelled', async () => {
    const controller = new AbortController();
    const cancellation = new Error('turn cancelled');
    let settleResolver: (() => void) | undefined;
    const resolve = vi.fn(async () => {
      await new Promise<void>((resolvePending) => {
        settleResolver = resolvePending;
      });
      // Deliberately ignore the signal here. The dispatch owner must fence a
      // late result even when a provider boundary settles after cancellation.
      return {
        id: 'issue:42',
        label: 'Issue 42 (late)',
        context: 'This context must not reach the provider.',
      };
    });

    const pending = resolveStructuredInputProviderDispatchContext({
      structuredInput: envelope({ mentions: [COMPOSER_MENTION] }),
      composerReferences: {
        resolve,
        signal: controller.signal,
      },
    });

    await vi.waitFor(() => expect(resolve).toHaveBeenCalledTimes(1));
    controller.abort(cancellation);
    settleResolver?.();

    await expect(pending).rejects.toBe(cancellation);
  });

  it('produces identical Codex turn input from mentions[] alone as the legacy arrays do (R-10)', async () => {
    const resolved = await resolveStructuredInputProviderContext({
      structuredInput: MENTIONS_ONLY,
      catalogs: catalogs(),
    });

    const fromMentions = buildCodexAppServerTurnInput({ text: TEXT, structuredInput: resolved });
    const fromLegacy = buildCodexAppServerTurnInput({ text: TEXT, structuredInput: LEGACY });

    expect(fromMentions).toEqual(fromLegacy);
    expect(fromMentions).toEqual([
      { type: 'text', text: TEXT },
      { type: 'mention', name: 'Linear', path: 'plugin://linear@happier' },
      { type: 'skill', name: 'review', path: '/w/.codex/skills/review/SKILL.md' },
    ]);
  });

  it('resolves to the same mention arrays the legacy envelope carries, for EVERY consumer (R-10)', async () => {
    // Consumer-agnostic form of the parity gate. `packages/plugins/opencode/.../promptParts.ts`
    // reads `vendorPluginRef` VERBATIM as the agent name and the skill's `name` only — a
    // resolver that restored just `path` would be Codex-identical and OpenCode-broken (D-24) —
    // and it lives behind a package boundary this host suite cannot import. Deep-equality on
    // the arrays both consumers read is the stronger statement: it holds for any consumer.
    const resolved = await resolveStructuredInputProviderContext({
      structuredInput: MENTIONS_ONLY,
      catalogs: catalogs(),
    });

    expect(resolved?.skillMentions).toEqual(LEGACY.skillMentions?.map((item) => ({ ...item, idSource: 'generated' })));
    expect(resolved?.vendorPluginMentions).toEqual(LEGACY.vendorPluginMentions);
    expect(resolved?.mentions).toBeUndefined();
  });

  it('keeps the resolved envelope acceptable to the schema OpenCode rejects on (D-24)', async () => {
    const resolved = await resolveStructuredInputProviderContext({
      structuredInput: MENTIONS_ONLY,
      catalogs: catalogs(),
    });
    // `promptParts.ts:27-32` throws `opencode_structured_input_invalid` on an envelope that
    // fails this schema, so both the additive `mentions[]` shape and the resolved shape must
    // parse.
    expect(HappierStructuredInputV1Schema.safeParse(resolved).success).toBe(true);
    expect(HappierStructuredInputV1Schema.safeParse(MENTIONS_ONLY).success).toBe(true);
  });

  it('reconstructs the skill path the reference never carried', async () => {
    const unresolved = buildCodexAppServerTurnInput({
      text: TEXT,
      structuredInput: envelope({ mentions: [SKILL_MENTION] }),
    });
    expect(unresolved).toEqual([{ type: 'text', text: TEXT }]);

    const resolved = await resolveStructuredInputProviderContext({
      structuredInput: envelope({ mentions: [SKILL_MENTION] }),
      catalogs: catalogs(),
    });
    expect(buildCodexAppServerTurnInput({ text: TEXT, structuredInput: resolved })).toEqual([
      { type: 'text', text: TEXT },
      { type: 'skill', name: 'review', path: '/w/.codex/skills/review/SKILL.md' },
    ]);
  });

  it('emits one provider item per unique {kind, ref} in first-occurrence order (D-26)', async () => {
    const resolved = await resolveStructuredInputProviderContext({
      structuredInput: envelope({
        mentions: [
          { kind: MENTION_KIND_V1.skill, ref: buildMentionRefForKindV1(MENTION_KIND_V1.skill, 'vendor:codex:plan'), token: '$plan', start: 0, end: 5 },
          SKILL_MENTION,
          { ...SKILL_MENTION, start: 30, end: 37 },
        ],
      }),
      catalogs: catalogs(),
    });

    expect(buildCodexAppServerTurnInput({ text: TEXT, structuredInput: resolved })).toEqual([
      { type: 'text', text: TEXT },
      { type: 'skill', name: 'plan', path: '/w/.codex/skills/plan/SKILL.md' },
      { type: 'skill', name: 'review', path: '/w/.codex/skills/review/SKILL.md' },
    ]);
  });

  it('rejects the send when the catalog positively lacks a referenced skill (D-27)', async () => {
    await expect(resolveStructuredInputProviderContext({
      structuredInput: envelope({
        mentions: [{ ...SKILL_MENTION, ref: buildMentionRefForKindV1(MENTION_KIND_V1.skill, 'vendor:codex:deleted') }],
      }),
      catalogs: catalogs(),
    })).rejects.toBeInstanceOf(StructuredInputMentionResolutionError);
  });

  it('never reports an unreadable catalog as a missing reference (D-27)', async () => {
    for (const listSkills of [
      async () => ({ supported: false, skills: [] }),
      async () => ({ unsupported: true, skills: [] }),
      async () => { throw new Error('rpc failed'); },
      async () => 'not a catalog',
    ]) {
      const diagnostics: unknown[] = [];
      const resolved = await resolveStructuredInputProviderContext({
        structuredInput: envelope({ mentions: [SKILL_MENTION] }),
        catalogs: catalogs({ listSkills }),
        onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      });
      expect(buildCodexAppServerTurnInput({ text: TEXT, structuredInput: resolved })).toEqual([{ type: 'text', text: TEXT }]);
      expect(diagnostics).toHaveLength(1);
    }
  });

  it('normalizes an envelope without mentions[] through the exact dispatch schema and reads no catalog', async () => {
    const listSkills = vi.fn(async () => ({ skills: [SKILL_ITEM] }));
    const listVendorPlugins = vi.fn(async () => ({ vendorPlugins: [VENDOR_ITEM] }));

    const resolved = await resolveStructuredInputProviderContext({
      structuredInput: LEGACY,
      catalogs: { listSkills, listVendorPlugins },
    });

    expect(resolved).toEqual(LEGACY);
    expect(listSkills).not.toHaveBeenCalled();
    expect(listVendorPlugins).not.toHaveBeenCalled();
  });

  it('reads no catalog when mentions[] carries only kinds that produce no provider item', async () => {
    const listSkills = vi.fn(async () => ({ skills: [SKILL_ITEM] }));
    const listVendorPlugins = vi.fn(async () => ({ vendorPlugins: [VENDOR_ITEM] }));

    const resolved = await resolveStructuredInputProviderContext({
      structuredInput: envelope({
        mentions: [
          { kind: MENTION_KIND_V1.file, ref: buildMentionRefForKindV1(MENTION_KIND_V1.file, 'src/a.ts'), token: '@src/a.ts', start: 0, end: 9 },
          { kind: 'acme.widget', ref: 'widget:42', token: '@widget', start: 10, end: 17 },
        ],
      }),
      catalogs: { listSkills, listVendorPlugins },
    });

    expect(buildCodexAppServerTurnInput({ text: TEXT, structuredInput: resolved })).toEqual([{ type: 'text', text: TEXT }]);
    expect(listSkills).not.toHaveBeenCalled();
    expect(listVendorPlugins).not.toHaveBeenCalled();
  });

  it('never reinterprets a reference whose scheme does not match its kind', async () => {
    const resolved = await resolveStructuredInputProviderContext({
      structuredInput: envelope({
        mentions: [{ ...SKILL_MENTION, ref: buildMentionRefForKindV1(MENTION_KIND_V1.vendorPlugin, 'vendor:codex:review') }],
      }),
      catalogs: catalogs(),
    });
    expect(buildCodexAppServerTurnInput({ text: TEXT, structuredInput: resolved })).toEqual([{ type: 'text', text: TEXT }]);
  });

  it('drops the legacy arrays D-4 had already ruled out', async () => {
    const resolved = await resolveStructuredInputProviderContext({
      structuredInput: envelope({
        mentions: [VENDOR_MENTION],
        skillMentions: [{ name: 'stale', path: '/stale/SKILL.md' }],
      }),
      catalogs: catalogs(),
    });

    expect(buildCodexAppServerTurnInput({ text: TEXT, structuredInput: resolved })).toEqual([
      { type: 'text', text: TEXT },
      { type: 'mention', name: 'Linear', path: 'plugin://linear@happier' },
    ]);
  });
});
