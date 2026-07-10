import { describe, expect, it } from 'vitest';

describe('browser context protocol contracts', () => {
  it('parses screenshot context as media reference metadata without inline bytes', async () => {
    const mod = await import('./v1.js').catch(() => null);

    expect(mod).not.toBeNull();
    if (!mod) return;

    const parsed = mod.BrowserContextItemV1Schema.parse({
      v: 1,
      contextId: 'ctx_1',
      kind: 'browserScreenshot',
      sourceViewId: 'view_1',
      sourceAdapterKind: 'chromiumSidecar',
      fidelity: 'cdp',
      capturedAtMs: 1_900_000,
      navigationGeneration: 3,
      lifecycleState: 'available',
      redactionLevel: 'metadataOnly',
      media: {
        mediaId: 'media_1',
        mediaKind: 'image',
        width: 1280,
        height: 720,
        sizeBytes: 200_000,
      },
    });

    expect(parsed.kind).toBe('browserScreenshot');
    expect(parsed.media.mediaId).toBe('media_1');
  });

  it('rejects context payloads with inline bytes or sensitive storage fields', async () => {
    const mod = await import('./v1.js').catch(() => null);

    expect(mod).not.toBeNull();
    if (!mod) return;

    const result = mod.BrowserContextItemV1Schema.safeParse({
      v: 1,
      contextId: 'ctx_unsafe',
      kind: 'browserPageTextSummary',
      sourceViewId: 'view_1',
      sourceAdapterKind: 'nativeWebView',
      fidelity: 'injectedPage',
      capturedAtMs: 1,
      navigationGeneration: 1,
      lifecycleState: 'available',
      redactionLevel: 'none',
      inlineBytesBase64: 'abcd',
      localStorage: { token: 'secret' },
      summary: 'safe summary',
    });

    expect(result.success).toBe(false);
  });

  it('rejects screenshot media context when capture is blocked by sensitive or private state', async () => {
    const mod = await import('./v1.js').catch(() => null);

    expect(mod).not.toBeNull();
    if (!mod) return;

    const result = mod.BrowserContextItemV1Schema.safeParse({
      v: 1,
      contextId: 'ctx_screenshot_blocked',
      kind: 'browserScreenshot',
      sourceViewId: 'view_1',
      sourceAdapterKind: 'chromiumSidecar',
      fidelity: 'cdp',
      capturedAtMs: 1_900_000,
      navigationGeneration: 3,
      lifecycleState: 'sensitiveOrigin',
      redactionLevel: 'blocked',
      disabledReason: 'Sensitive origin blocks screenshot capture.',
      media: {
        mediaId: 'media_1',
        mediaKind: 'image',
        width: 1280,
        height: 720,
        sizeBytes: 200_000,
      },
    });

    expect(result.success).toBe(false);
  });

  it('requires a disabled reason for non-available context states', async () => {
    const mod = await import('./v1.js').catch(() => null);

    expect(mod).not.toBeNull();
    if (!mod) return;

    const result = mod.BrowserContextItemV1Schema.safeParse({
      v: 1,
      contextId: 'ctx_policy_denied',
      kind: 'browserPageReference',
      sourceViewId: 'view_1',
      sourceAdapterKind: 'localPreview',
      fidelity: 'previewProxy',
      capturedAtMs: 2_000,
      navigationGeneration: 4,
      lifecycleState: 'policyDenied',
      redactionLevel: 'blocked',
      url: 'https://preview.localhost.test/',
    });

    expect(result.success).toBe(false);
  });

  it('requires stale navigation state to be explicit before context send', async () => {
    const mod = await import('./v1.js').catch(() => null);

    expect(mod).not.toBeNull();
    if (!mod) return;

    const parsed = mod.BrowserContextAttachmentV1Schema.parse({
      v: 1,
      attachmentId: 'attachment_1',
      contextId: 'ctx_1',
      sourceViewId: 'view_1',
      capturedNavigationGeneration: 2,
      currentNavigationGeneration: 3,
      state: 'navigationStale',
      requiresReconfirmBeforeSend: true,
    });

    expect(parsed.requiresReconfirmBeforeSend).toBe(true);
  });

  it('carries bounded page-reference target metadata without storage or body data', async () => {
    const mod = await import('./v1.js').catch(() => null);

    expect(mod).not.toBeNull();
    if (!mod) return;

    const parsed = mod.BrowserContextItemV1Schema.parse({
      v: 1,
      contextId: 'ctx_page_1',
      kind: 'browserPageReference',
      sourceViewId: 'view_1',
      sourceAdapterKind: 'localPreview',
      fidelity: 'previewProxy',
      capturedAtMs: 2_000,
      navigationGeneration: 4,
      lifecycleState: 'available',
      redactionLevel: 'metadataOnly',
      targetId: 'preview_1',
      targetKind: 'localServicePreview',
      display: {
        title: 'Kitchen Sink',
        addressLabel: 'localhost:5173',
        folderLabel: 'happier',
      },
      url: 'https://preview.localhost.test/',
      title: 'Kitchen Sink',
      faviconUrl: 'https://preview.localhost.test/favicon.ico',
      origin: 'https://preview.localhost.test',
    });

    expect(parsed).toMatchObject({
      kind: 'browserPageReference',
      targetId: 'preview_1',
      targetKind: 'localServicePreview',
      display: { title: 'Kitchen Sink' },
      redactionLevel: 'metadataOnly',
    });
  });

  it('rejects selected-element context with inline HTML previews', async () => {
    const mod = await import('./v1.js').catch(() => null);

    expect(mod).not.toBeNull();
    if (!mod) return;

    const result = mod.BrowserContextItemV1Schema.safeParse({
      v: 1,
      contextId: 'ctx_selected_1',
      kind: 'browserSelectedElement',
      sourceViewId: 'view_1',
      sourceAdapterKind: 'localPreview',
      fidelity: 'injectedPage',
      capturedAtMs: 2_100,
      navigationGeneration: 4,
      lifecycleState: 'available',
      redactionLevel: 'metadataOnly',
      selectorPath: 'html > body > main > button',
      outerHTMLPreview: '<button data-token="secret">Launch</button>',
    });

    expect(result.success).toBe(false);
  });

  it('parses browser annotation context with media-backed region metadata and bounded comments', async () => {
    const mod = await import('./v1.js').catch(() => null);

    expect(mod).not.toBeNull();
    if (!mod) return;

    const parsed = mod.BrowserContextItemV1Schema.parse({
      v: 1,
      contextId: 'ctx_annotation_1',
      kind: 'browserAnnotation',
      sourceViewId: 'view_1',
      sourceAdapterKind: 'localPreview',
      fidelity: 'injectedPage',
      capturedAtMs: 2_200,
      navigationGeneration: 5,
      lifecycleState: 'available',
      redactionLevel: 'metadataOnly',
      annotationId: 'annotation_1',
      browserSessionId: 'browser_session_1',
      media: {
        mediaId: 'media_annotation_1',
        mediaKind: 'image',
        width: 1280,
        height: 720,
        sizeBytes: 250_000,
      },
      target: {
        kind: 'region',
        rect: {
          x: 120,
          y: 160,
          width: 320,
          height: 180,
        },
      },
      comment: 'The CTA overlaps the pricing card.',
      pageUrl: 'https://preview.localhost.test/pricing',
      pageTitle: 'Pricing',
    });

    expect(parsed).toMatchObject({
      kind: 'browserAnnotation',
      annotationId: 'annotation_1',
      browserSessionId: 'browser_session_1',
      media: { mediaId: 'media_annotation_1' },
      target: {
        kind: 'region',
        rect: { width: 320, height: 180 },
      },
      comment: 'The CTA overlaps the pricing card.',
      pageUrl: 'https://preview.localhost.test/pricing',
      pageTitle: 'Pricing',
    });
  });

  it('parses browser annotation context with a style intent and bounded vector stroke', async () => {
    const mod = await import('./v1.js').catch(() => null);

    expect(mod).not.toBeNull();
    if (!mod) return;

    const parsed = mod.BrowserContextItemV1Schema.parse({
      v: 1,
      contextId: 'ctx_annotation_styled',
      kind: 'browserAnnotation',
      sourceViewId: 'view_1',
      sourceAdapterKind: 'localPreview',
      fidelity: 'injectedPage',
      capturedAtMs: 2_400,
      navigationGeneration: 6,
      lifecycleState: 'available',
      redactionLevel: 'metadataOnly',
      annotationId: 'annotation_styled',
      browserSessionId: 'browser_session_1',
      media: {
        mediaId: 'media_annotation_styled',
        mediaKind: 'image',
        width: 1280,
        height: 720,
        sizeBytes: 250_000,
      },
      target: {
        kind: 'region',
        rect: { x: 10, y: 20, width: 100, height: 80 },
      },
      styleIntent: 'callout',
      stroke: {
        shape: 'freehand',
        points: [
          { x: 0.1, y: 0.2 },
          { x: 0.3, y: 0.4 },
        ],
      },
    });

    expect(parsed).toMatchObject({
      kind: 'browserAnnotation',
      styleIntent: 'callout',
      stroke: {
        shape: 'freehand',
        points: [
          { x: 0.1, y: 0.2 },
          { x: 0.3, y: 0.4 },
        ],
      },
    });
  });

  it('rejects an annotation stroke with out-of-range normalized points', async () => {
    const mod = await import('./v1.js').catch(() => null);

    expect(mod).not.toBeNull();
    if (!mod) return;

    const result = mod.BrowserContextItemV1Schema.safeParse({
      v: 1,
      contextId: 'ctx_annotation_bad_stroke',
      kind: 'browserAnnotation',
      sourceViewId: 'view_1',
      sourceAdapterKind: 'localPreview',
      fidelity: 'injectedPage',
      capturedAtMs: 2_500,
      navigationGeneration: 6,
      lifecycleState: 'available',
      redactionLevel: 'metadataOnly',
      annotationId: 'annotation_bad_stroke',
      browserSessionId: 'browser_session_1',
      media: {
        mediaId: 'media_annotation_bad_stroke',
        mediaKind: 'image',
        width: 1280,
        height: 720,
        sizeBytes: 250_000,
      },
      target: { kind: 'region', rect: { x: 10, y: 20, width: 100, height: 80 } },
      stroke: {
        shape: 'freehand',
        points: [{ x: 1.5, y: -0.2 }],
      },
    });

    expect(result.success).toBe(false);
  });

  it('rejects an unknown annotation style intent', async () => {
    const mod = await import('./v1.js').catch(() => null);

    expect(mod).not.toBeNull();
    if (!mod) return;

    const result = mod.BrowserContextItemV1Schema.safeParse({
      v: 1,
      contextId: 'ctx_annotation_bad_intent',
      kind: 'browserAnnotation',
      sourceViewId: 'view_1',
      sourceAdapterKind: 'localPreview',
      fidelity: 'injectedPage',
      capturedAtMs: 2_600,
      navigationGeneration: 6,
      lifecycleState: 'available',
      redactionLevel: 'metadataOnly',
      annotationId: 'annotation_bad_intent',
      browserSessionId: 'browser_session_1',
      media: {
        mediaId: 'media_annotation_bad_intent',
        mediaKind: 'image',
        width: 1280,
        height: 720,
        sizeBytes: 250_000,
      },
      target: { kind: 'region', rect: { x: 10, y: 20, width: 100, height: 80 } },
      styleIntent: 'definitely-not-a-style',
    });

    expect(result.success).toBe(false);
  });

  it('exposes annotation stroke and style-intent commands', async () => {
    const mod = await import('./v1.js').catch(() => null);

    expect(mod).not.toBeNull();
    if (!mod) return;

    expect(mod.BrowserContextCommandV1Schema.parse('attachAnnotationStroke')).toBe('attachAnnotationStroke');
    expect(mod.BrowserContextCommandV1Schema.parse('attachAnnotationStyleIntent')).toBe('attachAnnotationStyleIntent');
  });

  it('rejects blocked annotation context with captured media attached', async () => {
    const mod = await import('./v1.js').catch(() => null);

    expect(mod).not.toBeNull();
    if (!mod) return;

    const result = mod.BrowserContextItemV1Schema.safeParse({
      v: 1,
      contextId: 'ctx_annotation_blocked',
      kind: 'browserAnnotation',
      sourceViewId: 'view_1',
      sourceAdapterKind: 'localPreview',
      fidelity: 'injectedPage',
      capturedAtMs: 2_300,
      navigationGeneration: 5,
      lifecycleState: 'sensitiveOrigin',
      redactionLevel: 'blocked',
      disabledReason: 'Sensitive origin blocks annotation capture.',
      annotationId: 'annotation_2',
      browserSessionId: 'browser_session_1',
      media: {
        mediaId: 'media_annotation_blocked',
        mediaKind: 'image',
        width: 1280,
        height: 720,
        sizeBytes: 250_000,
      },
      target: {
        kind: 'region',
        rect: {
          x: 120,
          y: 160,
          width: 320,
          height: 180,
        },
      },
    });

    expect(result.success).toBe(false);
  });

  it('exposes annotation commands and events without widening raw payload contracts', async () => {
    const mod = await import('./v1.js').catch(() => null);

    expect(mod).not.toBeNull();
    if (!mod) return;

    expect(mod.BrowserContextCommandV1Schema.parse('startAnnotation')).toBe('startAnnotation');
    expect(mod.BrowserContextCommandV1Schema.parse('cancelAnnotation')).toBe('cancelAnnotation');
    expect(mod.BrowserContextCommandV1Schema.parse('captureAnnotationRegion')).toBe('captureAnnotationRegion');
    expect(mod.BrowserContextCommandV1Schema.parse('captureAnnotationElement')).toBe('captureAnnotationElement');
    expect(mod.BrowserContextCommandV1Schema.parse('attachAnnotationComment')).toBe('attachAnnotationComment');
    expect(mod.BrowserContextEventV1Schema.parse('annotationStarted')).toBe('annotationStarted');
    expect(mod.BrowserContextEventV1Schema.parse('annotationCanceled')).toBe('annotationCanceled');
    expect(mod.BrowserContextEventV1Schema.parse('annotationCaptured')).toBe('annotationCaptured');
    expect(mod.BrowserContextEventV1Schema.parse('annotationCommentAttached')).toBe('annotationCommentAttached');
  });

  it('parses annotation runtime mutation results on the browser context route result contract', async () => {
    const mod = await import('./v1.js').catch(() => null);

    expect(mod).not.toBeNull();
    if (!mod) return;

    expect(mod.BrowserContextRouteResultV1Schema.parse({
      v: 1,
      actionId: 'browser.context.annotation.start',
      status: 'started',
    })).toMatchObject({ status: 'started' });
    expect(mod.BrowserContextRouteResultV1Schema.parse({
      v: 1,
      actionId: 'browser.context.annotation.attachComment',
      status: 'updated',
      contextId: 'ctx_annotation_1',
    })).toMatchObject({ status: 'updated', contextId: 'ctx_annotation_1' });

    expect(mod.BrowserContextRouteResultV1Schema.safeParse({
      v: 1,
      actionId: 'browser.context.annotation.attachComment',
      status: 'unknown',
      contextId: 'ctx_annotation_1',
    }).success).toBe(false);
  });

  it('parses browser recording evidence context as artifact references without owning media bytes', async () => {
    const mod = await import('./v1.js').catch(() => null);

    expect(mod).not.toBeNull();
    if (!mod) return;

    const parsed = mod.BrowserContextItemV1Schema.parse({
      v: 1,
      contextId: 'ctx_recording_evidence_1',
      kind: 'browserRecordingEvidence',
      sourceViewId: 'view_1',
      sourceAdapterKind: 'localPreview',
      fidelity: 'streamFrame',
      capturedAtMs: 5_000,
      navigationGeneration: 7,
      lifecycleState: 'available',
      redactionLevel: 'metadataOnly',
      recordingId: 'recording_1',
      artifactId: 'artifact_recording_1',
      mediaRef: {
        refKind: 'sessionMedia',
        mediaId: 'media_recording_1',
        mediaKind: 'video',
        mimeType: 'video/webm',
        sizeBytes: 800_000,
      },
      sourceNavigationGenerationRange: { start: 7, end: 8 },
      actionChapterRefs: ['chapter_1'],
    });

    expect(parsed).toMatchObject({
      kind: 'browserRecordingEvidence',
      recordingId: 'recording_1',
      artifactId: 'artifact_recording_1',
      mediaRef: { mediaId: 'media_recording_1' },
    });
    expect(JSON.stringify(parsed)).not.toContain('base64');
    expect(mod.BrowserContextItemV1Schema.safeParse({
      ...parsed,
      inlineBytesBase64: 'AAAA',
    }).success).toBe(false);
  });

  // ANNO-2: a multi-target editor session is represented as N `browserAnnotation` items that SHARE
  // one `annotationId` group + one cropped `media` + one `comment`. Round-trip the grouped shape and
  // assert the grouping invariant the composer + agent turn rely on (one card per annotationId).
  it('round-trips a multi-target annotation group sharing one annotationId + one media (ANNO-2)', async () => {
    const mod = await import('./v1.js').catch(() => null);
    expect(mod).not.toBeNull();
    if (!mod) return;

    const media = {
      mediaId: 'media_union_crop_group_1',
      mediaKind: 'image' as const,
      width: 260,
      height: 110,
      sizeBytes: 4_096,
    };
    const base = {
      v: 1 as const,
      kind: 'browserAnnotation' as const,
      sourceViewId: 'view_1',
      sourceAdapterKind: 'localPreview' as const,
      fidelity: 'injectedPage' as const,
      capturedAtMs: 3_000,
      navigationGeneration: 7,
      lifecycleState: 'available' as const,
      redactionLevel: 'metadataOnly' as const,
      annotationId: 'annotation_group_1',
      browserSessionId: 'browser_session_1',
      media,
      comment: 'needs spacing',
    };
    const itemA = mod.BrowserContextItemV1Schema.parse({
      ...base,
      contextId: 'browser_context_annotation_group_1_0',
      target: { kind: 'element', selectorPath: '#a', rect: { x: 0, y: 0, width: 20, height: 20 } },
    });
    const itemB = mod.BrowserContextItemV1Schema.parse({
      ...base,
      contextId: 'browser_context_annotation_group_1_1',
      target: { kind: 'element', selectorPath: '#b', rect: { x: 90, y: 40, width: 30, height: 30 } },
    });
    const itemRegion = mod.BrowserContextItemV1Schema.parse({
      ...base,
      contextId: 'browser_context_annotation_group_1_2',
      target: { kind: 'region', rect: { x: 190, y: 70, width: 60, height: 40 } },
      stroke: { shape: 'freehand', points: [{ x: 0.1, y: 0.2 }, { x: 0.9, y: 0.95 }] },
    });

    const group = [itemA, itemB, itemRegion];
    // All grouped items share exactly one annotationId + one media = one logical annotation.
    expect(new Set(group.map((i) => (i.kind === 'browserAnnotation' ? i.annotationId : '')))).toEqual(
      new Set(['annotation_group_1']),
    );
    expect(new Set(group.map((i) => (i.kind === 'browserAnnotation' ? i.media.mediaId : '')))).toEqual(
      new Set(['media_union_crop_group_1']),
    );
    // Distinct contextIds so each marked target round-trips, but one shared comment.
    expect(new Set(group.map((i) => i.contextId)).size).toBe(3);
    expect(group.every((i) => i.kind === 'browserAnnotation' && i.comment === 'needs spacing')).toBe(true);
  });

  it('exposes exactly one annotation schema in the context discriminated union (no second annotation schema, ANNO-2)', async () => {
    const mod = await import('./v1.js').catch(() => null);
    expect(mod).not.toBeNull();
    if (!mod) return;
    // The canonical context schema is the single owner; an `annotationId`/`media`-bearing item must
    // parse only as `browserAnnotation` (no parallel annotation schema accepting a different kind).
    const accepted = mod.BrowserContextItemV1Schema.safeParse({
      v: 1,
      contextId: 'ctx_dup_probe',
      kind: 'browserScreenshot',
      sourceViewId: 'view_1',
      sourceAdapterKind: 'localPreview',
      fidelity: 'injectedPage',
      capturedAtMs: 1,
      navigationGeneration: 1,
      lifecycleState: 'available',
      redactionLevel: 'metadataOnly',
      annotationId: 'annotation_x',
      media: { mediaId: 'm', mediaKind: 'image', width: 10, height: 10, sizeBytes: 10 },
    });
    // `annotationId` is a strict-mode unknown key on `browserScreenshot` → rejected. Grouping fields
    // live only on the single `browserAnnotation` schema.
    expect(accepted.success).toBe(false);
  });

  // BA-2 combined rich agent snapshot (standalone schema, NOT a context-item union member).
  it('parses a combined snapshot bundling AX tree, interactive elements, text, console and media', async () => {
    const mod = await import('./v1.js').catch(() => null);
    expect(mod).not.toBeNull();
    if (!mod) return;

    const parsed = mod.BrowserContextSnapshotV1Schema.parse({
      v: 1,
      contextId: 'ctx_snap',
      sourceViewId: 'view_1',
      sourceAdapterKind: 'chromiumSidecar',
      fidelity: 'cdp',
      capturedAtMs: 1_900_000,
      navigationGeneration: 4,
      redactionLevel: 'none',
      url: 'https://example.test/app',
      title: 'App',
      media: { mediaId: 'm', mediaKind: 'image', width: 800, height: 600, sizeBytes: 4096 },
      visibleText: 'welcome',
      axNodes: [{ role: 'button', name: 'Go' }],
      interactiveElements: [
        { role: 'button', name: 'Go', selector: '#go', rect: { x: 1, y: 2, width: 30, height: 12 } },
      ],
      consoleSummary: '[error] 1 message',
    });

    expect(parsed.visibleText).toBe('welcome');
    expect(parsed.axNodes).toHaveLength(1);
    expect(parsed.interactiveElements[0].selector).toBe('#go');
    // Defaulted truncation flags.
    expect(parsed.visibleTextTruncated).toBe(false);
    expect(parsed.interactiveElementsTruncated).toBe(false);
  });

  it('rejects a combined snapshot that smuggles a sensitive key (egress-safety net)', async () => {
    const mod = await import('./v1.js').catch(() => null);
    expect(mod).not.toBeNull();
    if (!mod) return;

    const result = mod.BrowserContextSnapshotV1Schema.safeParse({
      v: 1,
      contextId: 'ctx_snap',
      sourceViewId: 'view_1',
      sourceAdapterKind: 'chromiumSidecar',
      fidelity: 'cdp',
      capturedAtMs: 1,
      navigationGeneration: 0,
      redactionLevel: 'none',
      visibleText: '',
      axNodes: [],
      interactiveElements: [],
      // A nested unsafe key (a cookie value) must be rejected by rejectUnsafeBrowserContextKeys.
      cookie: 'session=secret',
    });
    expect(result.success).toBe(false);
  });

  it('caps the snapshot collections (a hostile DOM cannot produce an unbounded payload)', async () => {
    const mod = await import('./v1.js').catch(() => null);
    expect(mod).not.toBeNull();
    if (!mod) return;

    const tooManyAx = Array.from({ length: 513 }, () => ({ role: 'generic' }));
    const result = mod.BrowserContextSnapshotV1Schema.safeParse({
      v: 1,
      contextId: 'ctx_snap',
      sourceViewId: 'view_1',
      sourceAdapterKind: 'chromiumSidecar',
      fidelity: 'cdp',
      capturedAtMs: 1,
      navigationGeneration: 0,
      redactionLevel: 'none',
      visibleText: '',
      axNodes: tooManyAx,
      interactiveElements: [],
    });
    expect(result.success).toBe(false);
  });
});
