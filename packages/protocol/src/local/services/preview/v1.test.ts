import { describe, expect, it } from 'vitest';

type PreviewModule = typeof import('./v1.js');

async function loadPreviewModule(): Promise<PreviewModule | null> {
  return import('./v1.js').catch(() => null);
}

describe('local service preview v1 protocol', () => {
  it('preserves query strings and maps previews to browser targets', async () => {
    const mod = await loadPreviewModule();

    const result = mod?.LocalServicePreviewResourceV1Schema.safeParse({
      previewId: 'preview_123',
      sessionId: 'session_123',
      machineId: 'machine_123',
      owner: { kind: 'agent', id: 'agent_1' },
      target: { host: '127.0.0.1', port: 5173, scheme: 'http' },
      initialPath: { pathname: '/dashboard', search: '?tab=preview&filter=open' },
      display: {
        title: 'Kitchen Sink',
        addressLabel: 'localhost:5173',
        folderLabel: 'happier',
        iconToken: 'browser',
        tone: 'info',
      },
      originMode: 'host',
      policy: {
        allowedMethods: ['GET', 'HEAD', 'POST'],
        cookiePolicy: 'isolate',
        compressionPolicy: 'identity',
        redirectPolicy: 'preserve_host_origin',
        maxRequestBodyBytes: 1_048_576,
        maxResponseBodyBytes: 8_388_608,
      },
      browserTarget: {
        kind: 'localServicePreview',
        targetId: 'preview_123',
        sessionId: 'session_123',
        machineId: 'machine_123',
      },
    });

    expect(result?.success).toBe(true);
    if (result?.success) {
      expect(result.data.initialPath.search).toBe('?tab=preview&filter=open');
      expect(result.data.browserTarget.kind).toBe('localServicePreview');
    }
  });

  it('rejects public exposure fields from private preview resources', async () => {
    const mod = await loadPreviewModule();

    const result = mod?.LocalServicePreviewResourceV1Schema.safeParse({
      previewId: 'preview_123',
      sessionId: 'session_123',
      machineId: 'machine_123',
      owner: { kind: 'user', id: 'user_1' },
      target: { host: '127.0.0.1', port: 5173, scheme: 'http' },
      initialPath: { pathname: '/', search: '' },
      display: { title: 'Kitchen Sink', addressLabel: 'localhost:5173' },
      originMode: 'host',
      publicUrl: 'https://public.example.test/preview_123',
    });

    expect(result?.success).toBe(false);
  });

  it('defaults preview policy methods to browser-safe read and preflight methods', async () => {
    const mod = await loadPreviewModule();

    const result = mod?.LocalServicePreviewPolicyV1Schema.safeParse({
      cookiePolicy: 'drop',
      compressionPolicy: 'identity',
      redirectPolicy: 'preserve_host_origin',
      maxRequestBodyBytes: 1_048_576,
      maxResponseBodyBytes: 8_388_608,
    });

    expect(result?.success).toBe(true);
    expect(result?.success ? result.data.allowedMethods : []).toEqual(['GET', 'HEAD', 'OPTIONS']);
  });

  it('rejects wildcard hosts as private preview connection targets', async () => {
    const mod = await loadPreviewModule();

    const result = mod?.LocalServicePreviewResourceV1Schema.safeParse({
      previewId: 'preview_123',
      sessionId: 'session_123',
      machineId: 'machine_123',
      owner: { kind: 'session', id: 'session_123' },
      target: { host: '0.0.0.0', port: 5173, scheme: 'http' },
      initialPath: { pathname: '/', search: '' },
      display: { title: 'Kitchen Sink', addressLabel: '0.0.0.0:5173' },
      originMode: 'host',
      policy: {
        allowedMethods: ['GET', 'HEAD'],
        cookiePolicy: 'drop',
        compressionPolicy: 'identity',
        redirectPolicy: 'preserve_host_origin',
        maxRequestBodyBytes: 1_048_576,
        maxResponseBodyBytes: 8_388_608,
      },
    });

    expect(result?.success).toBe(false);
  });
});
