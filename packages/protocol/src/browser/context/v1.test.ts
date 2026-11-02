import * as z from 'zod/mini';
import { describe, expect, it } from 'vitest';
import { SessionRunStreamReadEnvelopeSchema } from '../../sessions/control/contract.js';
import { zodSchemaToJsonSchemaObject } from '../../actions/actionInputJsonSchema.js';

describe('browser context protocol contracts', () => {
  it('preserves picked element component and source location in generic element context', async () => {
    const { BrowserContextItemV1Schema } = await import('./v1.js');
    const picked = {
      v: 1, kind: 'browserSelectedElement', contextId: 'picked', sourceViewId: 'view',
      sourceAdapterKind: 'localPreview', fidelity: 'injectedPage', capturedAtMs: 1, navigationGeneration: 2,
      lifecycleState: 'available', redactionLevel: 'metadataOnly', selectorPath: '#submit',
      componentName: 'Checkout', sourceLocation: { file: '/src/Checkout.tsx', line: 10, column: 2 },
    };
    expect(BrowserContextItemV1Schema.parse(picked)).toEqual(picked);
  });
  it('exposes a requestable focused credential target without admitting a value carrier', async () => {
    const { BrowserContextSnapshotV1Schema } = await import('./v1.js');
    const snapshot = {
      v: 1, contextId: 'ctx', sourceViewId: 'view', sourceAdapterKind: 'chromiumSidecar',
      fidelity: 'cdp', capturedAtMs: 1, navigationGeneration: 2, redactionLevel: 'metadataOnly',
      visibleText: '', axNodes: [], interactiveElements: [],
      focusedCredentialTarget: {
        browserSessionId: 'browser', viewId: 'view', tabId: 'tab', frameId: 'frame',
        documentId: 'document', navigationGeneration: 2, origin: 'https://example.test',
        field: { fieldId: '4', focusId: '4', locator: '#password' },
      },
    };
    expect(BrowserContextSnapshotV1Schema.safeParse(snapshot).success).toBe(true);
    expect(BrowserContextSnapshotV1Schema.safeParse({ ...snapshot,
      focusedCredentialTarget: { ...snapshot.focusedCredentialTarget, field: { ...snapshot.focusedCredentialTarget.field, value: 'fixture' } },
    }).success).toBe(false);
  });
  it('preserves Browser bounds in composed control JSON in both dialects', () => {
    const object = (value: unknown): Record<string, unknown> => {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected JSON Schema object');
      return value as Record<string, unknown>;
    };
    for (const target of ['draft-7', 'draft-2020-12'] as const) {
      for (const schema of [
        zodSchemaToJsonSchemaObject(SessionRunStreamReadEnvelopeSchema, { target }),
        z.toJSONSchema(SessionRunStreamReadEnvelopeSchema, { io: 'input', target, unrepresentable: 'any' }),
      ]) {
        const definitions = object(target === 'draft-7' ? schema.definitions : schema.$defs);
        const page = Object.values(definitions).map(object).find((node) => {
          if (!node.properties) return false;
          const properties = object(node.properties);
          return properties.kind !== undefined && object(properties.kind).const === 'browserPageReference';
        });
        if (!page) throw new Error('Expected composed Browser page reference');
        const properties = object(page.properties);
        const dereference = (value: unknown): Record<string, unknown> => {
          const node = object(value);
          const prefix = target === 'draft-7' ? '#/definitions/' : '#/$defs/';
          return typeof node.$ref === 'string' && node.$ref.startsWith(prefix)
            ? object(definitions[node.$ref.slice(prefix.length)])
            : node;
        };
        expect(dereference(properties.contextId)).toEqual({ type: 'string', minLength: 1, maxLength: 256 });
        expect(dereference(properties.capturedAtMs)).toEqual({
          type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER,
        });
      }
    }
  });
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
    const withFieldValue = { ...parsed, axNodes: [{ role: 'textbox', name: 'Notes', value: 'QA58' }] };
    expect(mod.BrowserContextSnapshotV1Schema.safeParse(withFieldValue).success).toBe(true);
    expect(mod.BrowserContextSnapshotV1Schema.safeParse({ ...withFieldValue,
      axNodes: [{ role: 'textbox', value: 'x'.repeat(257) }],
    }).success).toBe(true);
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

  it('preserves full snapshot context and rejects malformed controls', async () => {
    const mod = await import('./v1.js').catch(() => null);
    expect(mod).not.toBeNull();
    if (!mod) return;

    const name = 'Accessible label '.repeat(20).trim();
    const elements = Array.from({ length: 513 }, (_, index) => ({ role: 'button', name,
      selector: `#${'long-id'.repeat(200)}-${index}`, rect: { x: 0, y: 0, width: 10, height: 10 } }));
    const snapshot = {
      v: 1,
      contextId: 'ctx_snap',
      sourceViewId: 'view_1',
      sourceAdapterKind: 'chromiumSidecar',
      fidelity: 'cdp',
      capturedAtMs: 1,
      navigationGeneration: 0,
      redactionLevel: 'none',
      visibleText: 'Visible text '.repeat(2_000),
      axNodes: Array.from({ length: 513 }, () => ({ role: 'textbox', name, value: 'x'.repeat(300) })),
      interactiveElements: elements,
    };
    const result = mod.BrowserContextSnapshotV1Schema.safeParse(snapshot);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.axNodes).toEqual(snapshot.axNodes);
      expect(result.data.interactiveElements).toEqual(elements);
      expect(result.data.visibleText).toBe(snapshot.visibleText);
    }
    expect(mod.BrowserContextSnapshotV1Schema.safeParse({ ...snapshot, interactiveElements: [
      { ...elements[0], name: 42 },
    ] }).success).toBe(false);
    expect(mod.BrowserContextSnapshotV1Schema.safeParse({ ...snapshot, axNodes: [
      { role: 'textbox', name, value: 'ordinary', password: 'fixture' },
    ] }).success).toBe(false);
  });
});
