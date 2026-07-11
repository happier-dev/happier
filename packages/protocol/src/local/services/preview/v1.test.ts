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

  it('defines a stable daemon snapshot for registered preview resources', async () => {
    const mod = await loadPreviewModule();

    expect(mod?.LocalServicePreviewSnapshotV1Schema).toBeTruthy();
    if (!mod?.LocalServicePreviewSnapshotV1Schema) return;

    const result = mod.LocalServicePreviewSnapshotV1Schema.safeParse({
      v: 1,
      machineId: 'machine_123',
      generatedAt: 2_000,
      refreshState: 'idle',
      resources: [{
        previewId: 'preview_123',
        sessionId: 'session_123',
        machineId: 'machine_123',
        owner: { kind: 'plugin', id: 'plugin_1' },
        target: { host: '127.0.0.1', port: 5173, scheme: 'http' },
        initialPath: { pathname: '/', search: '' },
        display: { title: 'Plugin Preview', addressLabel: 'localhost:5173' },
        originMode: 'path',
        browserTarget: {
          kind: 'localServicePreview',
          targetId: 'preview_123',
          sessionId: 'session_123',
          machineId: 'machine_123',
        },
      }],
      diagnostics: [],
    });

    expect(result.success).toBe(true);
  });

  it('carries minted private-preview access urls through snapshot rows', async () => {
    const mod = await loadPreviewModule();

    expect(mod?.LocalServicePreviewSnapshotRowV1Schema).toBeTruthy();
    if (!mod?.LocalServicePreviewSnapshotRowV1Schema || !mod?.LocalServicePreviewSnapshotV1Schema) return;

    const row = mod.LocalServicePreviewSnapshotRowV1Schema.safeParse({
      previewId: 'preview_123',
      resource: {
        previewId: 'preview_123',
        sessionId: 'session_123',
        machineId: 'machine_123',
        owner: { kind: 'user', id: 'user_1' },
        target: { host: '127.0.0.1', port: 5173, scheme: 'http' },
        initialPath: { pathname: '/dashboard', search: '?tab=preview' },
        display: { title: 'Dashboard', addressLabel: 'localhost:5173' },
        originMode: 'host',
        browserTarget: {
          kind: 'localServicePreview',
          targetId: 'preview_123',
          sessionId: 'session_123',
          machineId: 'machine_123',
        },
      },
      accessUrl: 'http://127.0.0.1:5173/dashboard?tab=preview',
      expiresAt: null,
      diagnostics: [],
    });

    expect(row.success).toBe(true);
    if (row.success) {
      expect(row.data.accessUrl).toBe('http://127.0.0.1:5173/dashboard?tab=preview');
      expect(row.data.expiresAt).toBeNull();
    }

    // accessUrl is nullable so a row may report "no served dev server" without crashing.
    const nullAccessRow = mod.LocalServicePreviewSnapshotRowV1Schema.safeParse({
      previewId: 'preview_123',
      resource: {
        previewId: 'preview_123',
        sessionId: 'session_123',
        machineId: 'machine_123',
        owner: { kind: 'user', id: 'user_1' },
        target: { host: '127.0.0.1', port: 5173, scheme: 'http' },
        initialPath: { pathname: '/', search: '' },
        display: { title: 'Dashboard', addressLabel: 'localhost:5173' },
        originMode: 'host',
        browserTarget: {
          kind: 'localServicePreview',
          targetId: 'preview_123',
          sessionId: 'session_123',
          machineId: 'machine_123',
        },
      },
      accessUrl: null,
    });
    expect(nullAccessRow.success).toBe(true);
    if (nullAccessRow.success) {
      expect(nullAccessRow.data.accessUrl).toBeNull();
      expect(nullAccessRow.data.diagnostics).toEqual([]);
    }

    // Non-http access urls are rejected (no javascript:/data: smuggling).
    expect(mod.LocalServicePreviewAccessUrlV1Schema.safeParse('javascript:alert(1)').success).toBe(false);
  });

  it('accepts a snapshot with minted preview rows while staying backward compatible with rows-absent payloads', async () => {
    const mod = await loadPreviewModule();
    if (!mod?.LocalServicePreviewSnapshotV1Schema) return;

    const resource = {
      previewId: 'preview_123',
      sessionId: 'session_123',
      machineId: 'machine_123',
      owner: { kind: 'plugin', id: 'plugin_1' } as const,
      target: { host: '127.0.0.1', port: 5173, scheme: 'http' } as const,
      initialPath: { pathname: '/', search: '' },
      display: { title: 'Plugin Preview', addressLabel: 'localhost:5173' },
      originMode: 'path' as const,
      browserTarget: {
        kind: 'localServicePreview' as const,
        targetId: 'preview_123',
        sessionId: 'session_123',
        machineId: 'machine_123',
      },
    };

    // §12.13 old-daemon shape: no `previews` key at all must still parse (fail safe).
    const legacy = mod.LocalServicePreviewSnapshotV1Schema.safeParse({
      v: 1,
      machineId: 'machine_123',
      generatedAt: 2_000,
      refreshState: 'idle',
      resources: [resource],
      diagnostics: [],
    });
    expect(legacy.success).toBe(true);
    if (legacy.success) {
      expect(legacy.data.previews).toBeUndefined();
    }

    const minted = mod.LocalServicePreviewSnapshotV1Schema.safeParse({
      v: 1,
      machineId: 'machine_123',
      generatedAt: 2_000,
      refreshState: 'idle',
      resources: [resource],
      previews: [{
        previewId: 'preview_123',
        resource,
        accessUrl: 'http://127.0.0.1:5173/',
        expiresAt: null,
        diagnostics: [],
      }],
      diagnostics: [],
    });
    expect(minted.success).toBe(true);
    if (minted.success) {
      expect(minted.data.previews?.[0]?.accessUrl).toBe('http://127.0.0.1:5173/');
    }
  });

  it('defines strict daemon snapshot rpc request and response envelopes', async () => {
    const mod = await loadPreviewModule();

    expect(mod?.DaemonLocalServicePreviewSnapshotRequestV1Schema).toBeTruthy();
    expect(mod?.DaemonLocalServicePreviewSnapshotResponseV1Schema).toBeTruthy();
    if (!mod?.DaemonLocalServicePreviewSnapshotRequestV1Schema || !mod?.DaemonLocalServicePreviewSnapshotResponseV1Schema) return;

    expect(mod.DaemonLocalServicePreviewSnapshotRequestV1Schema.parse({
      machineId: 'machine_123',
    })).toEqual({
      machineId: 'machine_123',
    });

    const response = mod.DaemonLocalServicePreviewSnapshotResponseV1Schema.parse({
      protocolVersion: 1,
      snapshot: {
        v: 1,
        machineId: 'machine_123',
        generatedAt: 2_000,
        refreshState: 'idle',
        resources: [],
        diagnostics: [],
      },
    });

    expect(response.snapshot.machineId).toBe('machine_123');
    expect(mod.DaemonLocalServicePreviewSnapshotRequestV1Schema.safeParse({
      machineId: '   ',
    }).success).toBe(false);
    expect(mod.DaemonLocalServicePreviewSnapshotResponseV1Schema.safeParse({
      protocolVersion: 1,
      snapshot: {
        v: 1,
        machineId: 'machine_123',
        generatedAt: 2_000,
        refreshState: 'idle',
        resources: [],
        diagnostics: [],
      },
      controlServerToken: 'must-not-leak',
    }).success).toBe(false);
  });
});
