import { describe, expect, it } from 'vitest';

import {
  LocalServicePreviewDiagnosticV1Schema,
  redactLocalServicePreviewDiagnosticDetails,
} from './v1.js';

describe('local service preview diagnostics protocol', () => {
  it('accepts stable preview diagnostic reason codes with safe contextual metadata', () => {
    const parsed = LocalServicePreviewDiagnosticV1Schema.safeParse({
      v: 1,
      code: 'path_mode_degraded',
      severity: 'warning',
      scope: 'privatePreview',
      previewId: 'preview_1',
      details: {
        originMode: 'path',
        unsupportedFeature: 'service_worker',
      },
    });

    expect(parsed.success).toBe(true);
    expect(parsed.success ? parsed.data : null).toMatchObject({
      code: 'path_mode_degraded',
      severity: 'warning',
      details: {
        originMode: 'path',
        unsupportedFeature: 'service_worker',
      },
    });
  });

  it('rejects recursive token, cookie, header, and body material in diagnostics', () => {
    const parsed = LocalServicePreviewDiagnosticV1Schema.safeParse({
      v: 1,
      code: 'cookie_stripped',
      severity: 'warning',
      scope: 'privatePreview',
      previewId: 'preview_1',
      details: {
        nested: {
          previewToken: 'raw-preview-token',
          cookie: 'happier_preview_token=raw-preview-token',
          requestBody: 'secret-body',
        },
      },
    });

    expect(parsed.success).toBe(false);
  });

  it('redacts diagnostic details before they are projected into UI state', () => {
    const redacted = redactLocalServicePreviewDiagnosticDetails({
      url: 'https://preview.example.test/app?previewToken=raw-preview-token&tab=network',
      headers: {
        authorization: 'Bearer raw-session-token',
        cookie: 'raw-cookie',
        'content-type': 'text/html',
        'sec-websocket-protocol': 'vite-hmr, bearer.raw-subprotocol-secret',
      },
      nested: {
        responseBody: 'secret-body',
        safeCounter: 3,
      },
    });

    expect(JSON.stringify(redacted)).not.toContain('raw-preview-token');
    expect(JSON.stringify(redacted)).not.toContain('raw-session-token');
    expect(JSON.stringify(redacted)).not.toContain('raw-cookie');
    expect(JSON.stringify(redacted)).not.toContain('secret-body');
    expect(JSON.stringify(redacted)).not.toContain('raw-subprotocol-secret');
    expect(JSON.stringify(redacted)).not.toContain('sec-websocket-protocol');
    expect(redacted).toMatchObject({
      url: {
        origin: 'https://preview.example.test',
        path: '/app',
        queryKeys: ['tab'],
      },
      headers: ['content-type'],
      nested: {
        safeCounter: 3,
      },
    });
  });
});
