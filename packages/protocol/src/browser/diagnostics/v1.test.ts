import { describe, expect, it } from 'vitest';

describe('browser diagnostics protocol contracts', () => {
  it('parses daemon browser diagnostics snapshot RPC payloads', async () => {
    const mod = await import('./v1.js').catch(() => null);

    expect(mod).not.toBeNull();
    if (!mod) return;

    const event = {
      v: 1,
      eventId: 'evt_cdp_1',
      browserSessionId: 'browser_session_1',
      viewId: 'view_1',
      navigationGeneration: 3,
      capturedAtMs: 10_000,
      family: 'network',
      kind: 'network.requestStarted',
      fidelity: 'cdp',
      trusted: true,
      data: {
        method: 'GET',
        url: 'https://example.test/assets/app.js',
      },
      redaction: {
        level: 'metadataOnly',
        queryRedacted: true,
        headersRedacted: true,
        truncated: false,
      },
    };

    expect(mod.DaemonBrowserDiagnosticsSnapshotRequestV1Schema.parse({
      machineId: 'machine_1',
    })).toEqual({ machineId: 'machine_1' });

    const parsed = mod.DaemonBrowserDiagnosticsSnapshotResponseV1Schema.parse({
      protocolVersion: 1,
      snapshot: {
        v: 1,
        machineId: 'machine_1',
        generatedAt: 20_000,
        refreshState: 'idle',
        events: [event],
        diagnostics: [],
      },
    });

    expect(parsed.snapshot.events).toEqual([expect.objectContaining({
      eventId: 'evt_cdp_1',
      fidelity: 'cdp',
      trusted: true,
    })]);
  });

  it('parses untrusted injected events with navigation-generation and nonce metadata', async () => {
    const mod = await import('./v1.js').catch(() => null);

    expect(mod).not.toBeNull();
    if (!mod) return;

    const parsed = mod.BrowserDiagnosticEventV1Schema.parse({
      v: 1,
      eventId: 'evt_1',
      browserSessionId: 'bs_1',
      viewId: 'view_1',
      navigationGeneration: 4,
      capturedAtMs: 1_900_000,
      family: 'console',
      kind: 'console.entry',
      fidelity: 'injectedPage',
      trusted: false,
      collector: {
        collectorId: 'collector_1',
        nonce: 'nonce_1',
        version: '1.0.0',
      },
      data: {
        level: 'error',
        argCount: 1,
        textAvailable: true,
      },
      redaction: {
        level: 'valuesRedacted',
        truncated: false,
      },
    });

    expect(parsed.trusted).toBe(false);
    expect(parsed.collector?.nonce).toBe('nonce_1');
  });

  it('accepts an injected console.entry carrying length-capped owner text', async () => {
    const mod = await import('./v1.js').catch(() => null);
    expect(mod).not.toBeNull();
    if (!mod) return;

    const parsed = mod.BrowserDiagnosticEventV1Schema.parse({
      v: 1,
      eventId: 'evt_console_text',
      browserSessionId: 'bs_1',
      viewId: 'view_1',
      navigationGeneration: 4,
      capturedAtMs: 1_900_000,
      family: 'console',
      kind: 'console.entry',
      fidelity: 'injectedPage',
      trusted: false,
      collector: { collectorId: 'collector_1', nonce: 'nonce_1', version: '1.0.0' },
      data: {
        level: 'log',
        argCount: 1,
        textAvailable: true,
        text: 'hello from the page console',
      },
      redaction: { level: 'none', truncated: false },
    });

    expect(parsed.data.text).toBe('hello from the page console');
  });

  it('rejects an injected console.entry whose text exceeds the owner cap', async () => {
    const mod = await import('./v1.js').catch(() => null);
    const egress = await import('./egress/index.js').catch(() => null);
    expect(mod).not.toBeNull();
    expect(egress).not.toBeNull();
    if (!mod || !egress) return;

    const result = mod.BrowserDiagnosticEventV1Schema.safeParse({
      v: 1,
      eventId: 'evt_console_text_over',
      browserSessionId: 'bs_1',
      viewId: 'view_1',
      navigationGeneration: 4,
      capturedAtMs: 1_900_000,
      family: 'console',
      kind: 'console.entry',
      fidelity: 'injectedPage',
      trusted: false,
      collector: { collectorId: 'collector_1', nonce: 'nonce_1', version: '1.0.0' },
      data: {
        level: 'log',
        argCount: 1,
        textAvailable: true,
        text: 'x'.repeat(egress.INJECTED_CONSOLE_TEXT_MAX_LENGTH + 1),
      },
      redaction: { level: 'none', truncated: true },
    });

    expect(result.success).toBe(false);
  });

  it('parses injected sendBeacon metadata (url + queued byte count only)', async () => {
    const mod = await import('./v1.js').catch(() => null);

    expect(mod).not.toBeNull();
    if (!mod) return;

    const parsed = mod.BrowserDiagnosticEventV1Schema.parse({
      v: 1,
      eventId: 'evt_beacon_1',
      browserSessionId: 'bs_1',
      viewId: 'view_1',
      navigationGeneration: 2,
      capturedAtMs: 5_000,
      family: 'network',
      kind: 'network.sendBeacon',
      fidelity: 'injectedPage',
      trusted: false,
      collector: { collectorId: 'collector_1', nonce: 'nonce_1', version: '1.0.0' },
      data: {
        requestId: 'beacon_1',
        url: 'https://example.test/collect',
        bytesQueued: 42,
        accepted: true,
      },
      redaction: { level: 'metadataOnly', truncated: false },
    });

    expect(parsed.kind).toBe('network.sendBeacon');
    expect(parsed.data.bytesQueued).toBe(42);
  });

  it('accepts injected local-owner network headers and body previews when bounded', async () => {
    const mod = await import('./v1.js').catch(() => null);

    expect(mod).not.toBeNull();
    if (!mod) return;

    const parsed = mod.BrowserDiagnosticEventV1Schema.parse({
      v: 1,
      eventId: 'evt_network_owner_values',
      browserSessionId: 'bs_1',
      viewId: 'view_1',
      navigationGeneration: 2,
      capturedAtMs: 5_100,
      family: 'network',
      kind: 'network.response',
      fidelity: 'injectedPage',
      trusted: false,
      collector: { collectorId: 'collector_1', nonce: 'nonce_1', version: '1.0.0' },
      data: {
        requestId: 'req_1',
        method: 'POST',
        url: 'https://example.test/api/session',
        statusCode: 201,
        requestHeaders: { 'content-type': 'application/json', 'x-request-id': 'req-1' },
        responseHeaders: { 'content-type': 'application/json' },
        requestBodyText: '{"name":"local owner"}',
        responseBodyText: '{"ok":true}',
        requestBodyTruncated: false,
        responseBodyTruncated: false,
      },
      redaction: { level: 'none', truncated: false },
    });

    expect(parsed.data.requestBodyText).toBe('{"name":"local owner"}');
    expect(parsed.data.responseHeaders).toEqual({ 'content-type': 'application/json' });
  });

  it('rejects injected local-owner network values carrying sensitive headers', async () => {
    const mod = await import('./v1.js').catch(() => null);

    expect(mod).not.toBeNull();
    if (!mod) return;

    const result = mod.BrowserDiagnosticEventV1Schema.safeParse({
      v: 1,
      eventId: 'evt_network_owner_sensitive_header',
      browserSessionId: 'bs_1',
      viewId: 'view_1',
      navigationGeneration: 2,
      capturedAtMs: 5_100,
      family: 'network',
      kind: 'network.response',
      fidelity: 'injectedPage',
      trusted: false,
      collector: { collectorId: 'collector_1', nonce: 'nonce_1', version: '1.0.0' },
      data: {
        requestId: 'req_1',
        method: 'GET',
        url: 'https://example.test/api/session',
        statusCode: 200,
        requestHeaders: { 'sec-websocket-protocol': 'base64url.bearer.authorization.k8s.io.secret' },
      },
      redaction: { level: 'none', truncated: false },
    });

    expect(result.success).toBe(false);
  });

  it('rejects injected sendBeacon events carrying the beacon payload', async () => {
    const mod = await import('./v1.js').catch(() => null);

    expect(mod).not.toBeNull();
    if (!mod) return;

    const result = mod.BrowserDiagnosticEventV1Schema.safeParse({
      v: 1,
      eventId: 'evt_beacon_unsafe',
      browserSessionId: 'bs_1',
      viewId: 'view_1',
      navigationGeneration: 2,
      capturedAtMs: 5_000,
      family: 'network',
      kind: 'network.sendBeacon',
      fidelity: 'injectedPage',
      trusted: false,
      collector: { collectorId: 'collector_1', nonce: 'nonce_1', version: '1.0.0' },
      data: {
        requestId: 'beacon_1',
        url: 'https://example.test/collect',
        bytesQueued: 42,
        body: 'secret-telemetry',
      },
      redaction: { level: 'metadataOnly', truncated: false },
    });

    expect(result.success).toBe(false);
  });

  it('parses injected storage key-inventory local-owner values when bounded', async () => {
    const mod = await import('./v1.js').catch(() => null);

    expect(mod).not.toBeNull();
    if (!mod) return;

    const parsed = mod.BrowserDiagnosticEventV1Schema.parse({
      v: 1,
      eventId: 'evt_storage_keys_1',
      browserSessionId: 'bs_1',
      viewId: 'view_1',
      navigationGeneration: 1,
      capturedAtMs: 6_000,
      family: 'storage',
      kind: 'storage.keyInventory',
      fidelity: 'injectedPage',
      trusted: false,
      collector: { collectorId: 'collector_1', nonce: 'nonce_1', version: '1.0.0' },
      data: {
        storageType: 'localStorage',
        keyCount: 3,
        keysTruncated: false,
        keys: ['theme', 'lastRoute', 'featureFlags'],
        entries: [
          { key: 'theme', value: 'dark', valueTruncated: false },
          { key: 'featureFlags', value: '{"beta":true}', valueTruncated: false },
        ],
      },
      redaction: { level: 'none', truncated: false },
    });

    expect(parsed.kind).toBe('storage.keyInventory');
    expect(parsed.data.keys).toEqual(['theme', 'lastRoute', 'featureFlags']);
    expect(parsed.data.entries).toEqual([
      { key: 'theme', value: 'dark', valueTruncated: false },
      { key: 'featureFlags', value: '{"beta":true}', valueTruncated: false },
    ]);
  });

  it('rejects over-cap injected storage values', async () => {
    const mod = await import('./v1.js').catch(() => null);

    expect(mod).not.toBeNull();
    if (!mod) return;

    const result = mod.BrowserDiagnosticEventV1Schema.safeParse({
      v: 1,
      eventId: 'evt_storage_keys_unsafe',
      browserSessionId: 'bs_1',
      viewId: 'view_1',
      navigationGeneration: 1,
      capturedAtMs: 6_000,
      family: 'storage',
      kind: 'storage.keyInventory',
      fidelity: 'injectedPage',
      trusted: false,
      collector: { collectorId: 'collector_1', nonce: 'nonce_1', version: '1.0.0' },
      data: {
        storageType: 'localStorage',
        keyCount: 1,
        keys: ['theme'],
        entries: [{ key: 'theme', value: 'x'.repeat(4097), valueTruncated: true }],
      },
      redaction: { level: 'none', truncated: true },
    });

    expect(result.success).toBe(false);
  });

  it('parses injected DOM-snapshot structural counts (no text/attribute values)', async () => {
    const mod = await import('./v1.js').catch(() => null);

    expect(mod).not.toBeNull();
    if (!mod) return;

    const parsed = mod.BrowserDiagnosticEventV1Schema.parse({
      v: 1,
      eventId: 'evt_dom_snapshot_1',
      browserSessionId: 'bs_1',
      viewId: 'view_1',
      navigationGeneration: 1,
      capturedAtMs: 7_000,
      family: 'pageInfo',
      kind: 'pageInfo.domSnapshot',
      fidelity: 'injectedPage',
      trusted: false,
      collector: { collectorId: 'collector_1', nonce: 'nonce_1', version: '1.0.0' },
      data: {
        nodeCount: 412,
        elementCount: 318,
        maxDepth: 14,
        readyState: 'complete',
      },
      redaction: { level: 'metadataOnly', truncated: false },
    });

    expect(parsed.kind).toBe('pageInfo.domSnapshot');
    expect(parsed.data.elementCount).toBe(318);
  });

  it('rejects injected DOM-snapshot events carrying page text/attribute content', async () => {
    const mod = await import('./v1.js').catch(() => null);

    expect(mod).not.toBeNull();
    if (!mod) return;

    const result = mod.BrowserDiagnosticEventV1Schema.safeParse({
      v: 1,
      eventId: 'evt_dom_snapshot_unsafe',
      browserSessionId: 'bs_1',
      viewId: 'view_1',
      navigationGeneration: 1,
      capturedAtMs: 7_000,
      family: 'pageInfo',
      kind: 'pageInfo.domSnapshot',
      fidelity: 'injectedPage',
      trusted: false,
      collector: { collectorId: 'collector_1', nonce: 'nonce_1', version: '1.0.0' },
      data: {
        nodeCount: 412,
        elementCount: 318,
        outerHtml: '<body>secret</body>',
      },
      redaction: { level: 'metadataOnly', truncated: false },
    });

    expect(result.success).toBe(false);
  });

  it('rejects diagnostic data that carries body or cookie material', async () => {
    const mod = await import('./v1.js').catch(() => null);

    expect(mod).not.toBeNull();
    if (!mod) return;

    const result = mod.BrowserDiagnosticEventV1Schema.safeParse({
      v: 1,
      eventId: 'evt_unsafe',
      browserSessionId: 'bs_1',
      viewId: 'view_1',
      navigationGeneration: 1,
      capturedAtMs: 1,
      family: 'network',
      kind: 'network.response',
      fidelity: 'previewProxy',
      trusted: true,
      data: {
        responseBody: 'secret',
        cookie: 'sid=secret',
      },
      redaction: {
        level: 'metadataOnly',
        truncated: false,
      },
    });

    expect(result.success).toBe(false);
  });

  it('rejects diagnostic data with mixed-case secret header keys', async () => {
    const mod = await import('./v1.js').catch(() => null);

    expect(mod).not.toBeNull();
    if (!mod) return;

    const result = mod.BrowserDiagnosticEventV1Schema.safeParse({
      v: 1,
      eventId: 'evt_unsafe_header',
      browserSessionId: 'bs_1',
      viewId: 'view_1',
      navigationGeneration: 1,
      capturedAtMs: 1,
      family: 'network',
      kind: 'network.requestStarted',
      fidelity: 'previewProxy',
      trusted: true,
      data: {
        headers: {
          Authorization: 'Bearer secret',
          'X-API-Key': 'secret',
        },
      },
      redaction: {
        level: 'metadataOnly',
        truncated: false,
      },
    });

    expect(result.success).toBe(false);
  });

  it('rejects untrusted injected diagnostics that include raw value-bearing fields', async () => {
    const mod = await import('./v1.js').catch(() => null);

    expect(mod).not.toBeNull();
    if (!mod) return;

    const result = mod.BrowserDiagnosticEventV1Schema.safeParse({
      v: 1,
      eventId: 'evt_injected_unsafe',
      browserSessionId: 'bs_1',
      viewId: 'view_1',
      navigationGeneration: 1,
      capturedAtMs: 1,
      family: 'console',
      kind: 'console.entry',
      fidelity: 'injectedPage',
      trusted: false,
      collector: {
        collectorId: 'collector_1',
        nonce: 'nonce_1',
        version: '1.0.0',
      },
      data: {
        level: 'error',
        args: [{ type: 'string', value: 'secret' }],
        message: 'secret',
        stack: 'secret',
      },
      redaction: {
        level: 'metadataOnly',
        truncated: false,
      },
    });

    expect(result.success).toBe(false);
  });

  it('rejects untrusted injected diagnostics with raw failed-network identifiers', async () => {
    const mod = await import('./v1.js').catch(() => null);

    expect(mod).not.toBeNull();
    if (!mod) return;

    const result = mod.BrowserDiagnosticEventV1Schema.safeParse({
      v: 1,
      eventId: 'evt_injected_network_unsafe',
      browserSessionId: 'bs_1',
      viewId: 'view_1',
      navigationGeneration: 1,
      capturedAtMs: 1,
      family: 'network',
      kind: 'network.failed',
      fidelity: 'injectedPage',
      trusted: false,
      collector: {
        collectorId: 'collector_1',
        nonce: 'nonce_1',
        version: '1.0.0',
      },
      data: {
        requestId: 'request_1',
        errorCode: 'Failed https://example.test?token=secret',
      },
      redaction: {
        level: 'metadataOnly',
        truncated: false,
      },
    });

    expect(result.success).toBe(false);
  });

  it('parses gated eval results as remote-object references', async () => {
    const mod = await import('./v1.js').catch(() => null);

    expect(mod).not.toBeNull();
    if (!mod) return;

    const parsed = mod.BrowserDiagnosticsEvalResultV1Schema.parse({
      v: 1,
      evalRequestId: 'eval_1',
      viewId: 'view_1',
      navigationGeneration: 7,
      status: 'completed',
      tier: 'injectedPage',
      audited: true,
      result: {
        type: 'object',
        objectId: 'obj_1',
        className: 'Object',
        description: 'Object',
        preview: [{ name: 'ok', valuePreview: 'true' }],
      },
    });

    expect(parsed.result?.objectId).toBe('obj_1');
  });

  it('rejects primitive string eval results above the inline cap', async () => {
    const mod = await import('./v1.js').catch(() => null);

    expect(mod).not.toBeNull();
    if (!mod) return;

    const result = mod.BrowserDiagnosticsEvalResultV1Schema.safeParse({
      v: 1,
      evalRequestId: 'eval_string_1',
      viewId: 'view_1',
      navigationGeneration: 7,
      status: 'completed',
      tier: 'injectedPage',
      audited: true,
      result: {
        type: 'string',
        value: 'x'.repeat(1025),
      },
    });

    expect(result.success).toBe(false);
  });

  it('parses redacted injected eval audit events without raw result values', async () => {
    const mod = await import('./v1.js').catch(() => null);

    expect(mod).not.toBeNull();
    if (!mod) return;

    const parsed = mod.BrowserDiagnosticEventV1Schema.safeParse({
      v: 1,
      eventId: 'evt_eval_requested_1',
      browserSessionId: 'bs_1',
      viewId: 'view_1',
      navigationGeneration: 7,
      capturedAtMs: 2_000,
      family: 'console',
      kind: 'eval.requested',
      fidelity: 'injectedPage',
      trusted: false,
      collector: {
        collectorId: 'collector_1',
        nonce: 'nonce_1',
        version: '1.0.0',
      },
      data: {
        evalRequestId: 'eval_1',
        tier: 'injectedPage',
        expressionPreview: 'document.querySelector("main")',
        expressionTruncated: false,
      },
      redaction: {
        level: 'valuesRedacted',
        truncated: false,
      },
    });

    expect(parsed.success).toBe(true);
  });

  it('parses nonce-bound injected eval command and result envelopes', async () => {
    const mod = await import('./v1.js').catch(() => null);

    expect(mod).not.toBeNull();
    expect(mod?.BrowserDiagnosticsEvalCommandMessageV1Schema).toBeTruthy();
    expect(mod?.BrowserDiagnosticsEvalResultMessageV1Schema).toBeTruthy();
    if (!mod?.BrowserDiagnosticsEvalCommandMessageV1Schema || !mod.BrowserDiagnosticsEvalResultMessageV1Schema) return;

    const collector = {
      collectorId: 'collector_1',
      nonce: 'nonce_1',
      version: '1.0.0',
    };
    const request = {
      v: 1,
      evalRequestId: 'eval_1',
      viewId: 'view_1',
      navigationGeneration: 7,
      tier: 'injectedPage',
      expression: '({ ok: true })',
      timeoutMs: 2000,
      objectGroupId: 'group_1',
      diagnosticsInteractionEnabled: true,
    };

    expect(mod.BrowserDiagnosticsEvalCommandMessageV1Schema.parse({
      v: 1,
      kind: 'browser.diagnostics.evalRequest',
      browserSessionId: 'bs_1',
      viewId: 'view_1',
      navigationGeneration: 7,
      collector,
      request,
    }).request.evalRequestId).toBe('eval_1');

    expect(mod.BrowserDiagnosticsEvalResultMessageV1Schema.parse({
      v: 1,
      kind: 'browser.diagnostics.evalResult',
      browserSessionId: 'bs_1',
      viewId: 'view_1',
      navigationGeneration: 7,
      collector,
      result: {
        v: 1,
        evalRequestId: 'eval_1',
        viewId: 'view_1',
        navigationGeneration: 7,
        status: 'completed',
        tier: 'injectedPage',
        audited: true,
        result: {
          type: 'object',
          objectId: 'obj_1',
          className: 'Object',
          description: 'Object',
          preview: [{ name: 'ok', valuePreview: 'true' }],
        },
      },
    }).result.result?.objectId).toBe('obj_1');
  });

  it('parses nonce-bound injected object-property and release-object-group envelopes', async () => {
    const mod = await import('./v1.js').catch(() => null);

    expect(mod).not.toBeNull();
    expect(mod?.BrowserDiagnosticsGetPropertiesCommandMessageV1Schema).toBeTruthy();
    expect(mod?.BrowserDiagnosticsGetPropertiesResultMessageV1Schema).toBeTruthy();
    expect(mod?.BrowserDiagnosticsReleaseObjectGroupCommandMessageV1Schema).toBeTruthy();
    expect(mod?.BrowserDiagnosticsReleaseObjectGroupResultMessageV1Schema).toBeTruthy();
    if (
      !mod?.BrowserDiagnosticsGetPropertiesCommandMessageV1Schema ||
      !mod.BrowserDiagnosticsGetPropertiesResultMessageV1Schema ||
      !mod.BrowserDiagnosticsReleaseObjectGroupCommandMessageV1Schema ||
      !mod.BrowserDiagnosticsReleaseObjectGroupResultMessageV1Schema
    ) return;

    const collector = {
      collectorId: 'collector_1',
      nonce: 'nonce_1',
      version: '1.0.0',
    };

    expect(mod.BrowserDiagnosticsGetPropertiesCommandMessageV1Schema.parse({
      v: 1,
      kind: 'browser.diagnostics.getPropertiesRequest',
      browserSessionId: 'bs_1',
      viewId: 'view_1',
      navigationGeneration: 7,
      collector,
      request: {
        v: 1,
        propertyRequestId: 'props_1',
        viewId: 'view_1',
        navigationGeneration: 7,
        tier: 'injectedPage',
        objectId: 'obj_1',
        objectGroupId: 'group_1',
        diagnosticsInteractionEnabled: true,
      },
    }).request.objectId).toBe('obj_1');

    expect(mod.BrowserDiagnosticsGetPropertiesResultMessageV1Schema.parse({
      v: 1,
      kind: 'browser.diagnostics.getPropertiesResult',
      browserSessionId: 'bs_1',
      viewId: 'view_1',
      navigationGeneration: 7,
      collector,
      result: {
        v: 1,
        propertyRequestId: 'props_1',
        viewId: 'view_1',
        navigationGeneration: 7,
        tier: 'injectedPage',
        status: 'completed',
        audited: true,
        objectId: 'obj_1',
        properties: [
          {
            name: 'ok',
            value: {
              type: 'boolean',
              value: true,
            },
            enumerable: true,
          },
        ],
      },
    }).result.properties[0]?.name).toBe('ok');

    expect(mod.BrowserDiagnosticsGetPropertiesResultMessageV1Schema.parse({
      v: 1,
      kind: 'browser.diagnostics.getPropertiesResult',
      browserSessionId: 'bs_1',
      viewId: 'view_1',
      navigationGeneration: 7,
      collector,
      result: {
        v: 1,
        propertyRequestId: 'props_2',
        viewId: 'view_1',
        navigationGeneration: 7,
        tier: 'injectedPage',
        status: 'completed',
        audited: true,
        objectId: 'obj_1',
        properties: [
          {
            name: 'longText',
            value: {
              type: 'string',
              value: 'x'.repeat(65_536),
            },
            enumerable: true,
          },
        ],
      },
    }).result.properties[0]?.value.value).toHaveLength(65_536);

    expect(mod.BrowserDiagnosticsReleaseObjectGroupCommandMessageV1Schema.parse({
      v: 1,
      kind: 'browser.diagnostics.releaseObjectGroupRequest',
      browserSessionId: 'bs_1',
      viewId: 'view_1',
      navigationGeneration: 7,
      collector,
      request: {
        v: 1,
        releaseRequestId: 'release_1',
        viewId: 'view_1',
        navigationGeneration: 7,
        tier: 'injectedPage',
        objectGroupId: 'group_1',
        diagnosticsInteractionEnabled: true,
      },
    }).request.objectGroupId).toBe('group_1');

    expect(mod.BrowserDiagnosticsReleaseObjectGroupResultMessageV1Schema.parse({
      v: 1,
      kind: 'browser.diagnostics.releaseObjectGroupResult',
      browserSessionId: 'bs_1',
      viewId: 'view_1',
      navigationGeneration: 7,
      collector,
      result: {
        v: 1,
        releaseRequestId: 'release_1',
        viewId: 'view_1',
        navigationGeneration: 7,
        tier: 'injectedPage',
        status: 'completed',
        audited: true,
        objectGroupId: 'group_1',
      },
    }).result.status).toBe('completed');
  });

  it('parses nonce-bound injected element-picker command and result envelopes', async () => {
    const mod = await import('./v1.js').catch(() => null);

    expect(mod).not.toBeNull();
    expect(mod?.BrowserDiagnosticsElementPickerCommandMessageV1Schema).toBeTruthy();
    expect(mod?.BrowserDiagnosticsElementPickerResultMessageV1Schema).toBeTruthy();
    if (!mod?.BrowserDiagnosticsElementPickerCommandMessageV1Schema || !mod.BrowserDiagnosticsElementPickerResultMessageV1Schema) return;

    const collector = {
      collectorId: 'collector_1',
      nonce: 'nonce_1',
      version: '1.0.0',
    };
    const request = {
      v: 1,
      pickerRequestId: 'picker_1',
      viewId: 'view_1',
      navigationGeneration: 7,
      tier: 'injectedPage',
      action: 'start',
      diagnosticsInteractionEnabled: true,
    };

    expect(mod.BrowserDiagnosticsElementPickerCommandMessageV1Schema.parse({
      v: 1,
      kind: 'browser.diagnostics.elementPickerRequest',
      browserSessionId: 'bs_1',
      viewId: 'view_1',
      navigationGeneration: 7,
      collector,
      request,
    }).request.pickerRequestId).toBe('picker_1');

    expect(mod.BrowserDiagnosticsElementPickerResultMessageV1Schema.parse({
      v: 1,
      kind: 'browser.diagnostics.elementPickerResult',
      browserSessionId: 'bs_1',
      viewId: 'view_1',
      navigationGeneration: 7,
      collector,
      result: {
        v: 1,
        pickerRequestId: 'picker_1',
        viewId: 'view_1',
        navigationGeneration: 7,
        tier: 'injectedPage',
        status: 'selected',
        audited: true,
        backendNodeRef: 'node_1',
        selectorPath: 'html > body > main:nth-of-type(1)',
        rect: {
          x: 10,
          y: 20,
          width: 300,
          height: 40,
        },
        accessibleName: 'Run',
      },
    }).result.backendNodeRef).toBe('node_1');
  });

  it('parses collector event batches only when batch metadata matches each event', async () => {
    const mod = await import('./v1.js').catch(() => null);

    expect(mod).not.toBeNull();
    expect(mod?.BrowserDiagnosticEventBatchV1Schema).toBeTruthy();
    if (!mod?.BrowserDiagnosticEventBatchV1Schema) return;

    const event = {
      v: 1,
      eventId: 'evt_console_1',
      browserSessionId: 'bs_1',
      viewId: 'view_1',
      navigationGeneration: 4,
      capturedAtMs: 1_900_000,
      family: 'console',
      kind: 'console.entry',
      fidelity: 'injectedPage',
      trusted: false,
      collector: {
        collectorId: 'collector_1',
        nonce: 'nonce_1',
        version: '1.0.0',
      },
      data: {
        level: 'log',
        argCount: 1,
        textAvailable: true,
      },
      redaction: {
        level: 'valuesRedacted',
        truncated: false,
      },
    };

    const parsed = mod.BrowserDiagnosticEventBatchV1Schema.parse({
      v: 1,
      kind: 'browser.diagnostics.events',
      browserSessionId: 'bs_1',
      viewId: 'view_1',
      navigationGeneration: 4,
      collector: {
        collectorId: 'collector_1',
        nonce: 'nonce_1',
        version: '1.0.0',
      },
      events: [event],
    });

    expect(parsed.events).toHaveLength(1);

    const mismatched = mod.BrowserDiagnosticEventBatchV1Schema.safeParse({
      v: 1,
      kind: 'browser.diagnostics.events',
      browserSessionId: 'bs_1',
      viewId: 'view_1',
      navigationGeneration: 5,
      collector: {
        collectorId: 'collector_1',
        nonce: 'nonce_1',
        version: '1.0.0',
      },
      events: [event],
    });

    expect(mismatched.success).toBe(false);
  });

  function injectedNetworkEvent(
    kind: string,
    data: Record<string, unknown>,
  ): Record<string, unknown> {
    return {
      v: 1,
      eventId: `evt_${kind}`,
      browserSessionId: 'bs_1',
      viewId: 'view_1',
      navigationGeneration: 1,
      capturedAtMs: 1,
      family: 'network',
      kind,
      fidelity: 'injectedPage',
      trusted: false,
      collector: {
        collectorId: 'collector_1',
        nonce: 'nonce_1',
        version: '1.0.0',
      },
      data,
      redaction: {
        level: 'metadataOnly',
        truncated: false,
      },
    };
  }

  it('parses injected websocket lifecycle metadata counters without payloads', async () => {
    const mod = await import('./v1.js').catch(() => null);

    expect(mod).not.toBeNull();
    if (!mod) return;

    // The raw WS subprotocol value is a credential-egress vector (clients smuggle bearer tokens
    // through it). The injected producer now reports presence/count only, never the value.
    const opened = mod.BrowserDiagnosticEventV1Schema.safeParse(injectedNetworkEvent('network.websocketOpened', {
      socketId: 'ws_1',
      url: 'https://example.test/socket',
      hasProtocol: true,
      protocolCount: 1,
    }));
    expect(opened.success).toBe(true);

    // The previously-allowlisted raw `protocol` value must now be REJECTED (D4/DUP-2 leak fix).
    const leakedProtocol = mod.BrowserDiagnosticEventV1Schema.safeParse(injectedNetworkEvent('network.websocketOpened', {
      socketId: 'ws_1',
      url: 'https://example.test/socket',
      protocol: 'base64url.bearer.authorization.k8s.io.eyJhbGciOi',
    }));
    expect(leakedProtocol.success).toBe(false);

    const summary = mod.BrowserDiagnosticEventV1Schema.safeParse(injectedNetworkEvent('network.websocketSummary', {
      socketId: 'ws_1',
      state: 'open',
      framesSent: 4,
      framesReceived: 6,
      bytesSent: 128,
      bytesReceived: 256,
      messageCount: 10,
    }));
    expect(summary.success).toBe(true);

    const closed = mod.BrowserDiagnosticEventV1Schema.safeParse(injectedNetworkEvent('network.websocketClosed', {
      socketId: 'ws_1',
      code: 1000,
      wasClean: true,
    }));
    expect(closed.success).toBe(true);
  });

  it('rejects injected websocket events that smuggle message payloads', async () => {
    const mod = await import('./v1.js').catch(() => null);

    expect(mod).not.toBeNull();
    if (!mod) return;

    const result = mod.BrowserDiagnosticEventV1Schema.safeParse(injectedNetworkEvent('network.websocketSummary', {
      socketId: 'ws_1',
      state: 'open',
      lastMessage: 'secret frame body',
    }));
    expect(result.success).toBe(false);
  });

  it('parses injected EventSource lifecycle metadata without stream values', async () => {
    const mod = await import('./v1.js').catch(() => null);

    expect(mod).not.toBeNull();
    if (!mod) return;

    const opened = mod.BrowserDiagnosticEventV1Schema.safeParse(injectedNetworkEvent('network.eventSourceOpened', {
      sourceId: 'es_1',
      url: 'https://example.test/stream',
    }));
    expect(opened.success).toBe(true);

    const summary = mod.BrowserDiagnosticEventV1Schema.safeParse(injectedNetworkEvent('network.eventSourceSummary', {
      sourceId: 'es_1',
      state: 'open',
      messageCount: 5,
      bytesReceived: 512,
    }));
    expect(summary.success).toBe(true);

    const closed = mod.BrowserDiagnosticEventV1Schema.safeParse(injectedNetworkEvent('network.eventSourceClosed', {
      sourceId: 'es_1',
      state: 'closed',
    }));
    expect(closed.success).toBe(true);

    const leaked = mod.BrowserDiagnosticEventV1Schema.safeParse(injectedNetworkEvent('network.eventSourceSummary', {
      sourceId: 'es_1',
      data: 'secret event data',
    }));
    expect(leaked.success).toBe(false);
  });

  it('parses injected performance vitals as pure numeric metadata', async () => {
    const mod = await import('./v1.js').catch(() => null);

    expect(mod).not.toBeNull();
    if (!mod) return;

    const vitals = mod.BrowserDiagnosticEventV1Schema.safeParse({
      v: 1,
      eventId: 'evt_perf_1',
      browserSessionId: 'bs_1',
      viewId: 'view_1',
      navigationGeneration: 1,
      capturedAtMs: 1,
      family: 'performance',
      kind: 'performance.vitals',
      fidelity: 'injectedPage',
      trusted: false,
      collector: { collectorId: 'collector_1', nonce: 'nonce_1', version: '1.0.0' },
      data: {
        lcpMs: 1200,
        clsScore: 0.05,
        inpMs: 80,
        fcpMs: 600,
        longTaskCount: 2,
        longTaskTotalMs: 140,
        navResponseEndMs: 320,
        navDomContentLoadedMs: 900,
        navLoadEventEndMs: 1500,
      },
      redaction: { level: 'metadataOnly', truncated: false },
    });
    expect(vitals.success).toBe(true);

    const tampered = mod.BrowserDiagnosticEventV1Schema.safeParse({
      v: 1,
      eventId: 'evt_perf_2',
      browserSessionId: 'bs_1',
      viewId: 'view_1',
      navigationGeneration: 1,
      capturedAtMs: 1,
      family: 'performance',
      kind: 'performance.vitals',
      fidelity: 'injectedPage',
      trusted: false,
      collector: { collectorId: 'collector_1', nonce: 'nonce_1', version: '1.0.0' },
      data: { lcpMs: 'secret', userEmail: 'a@b.test' },
      redaction: { level: 'metadataOnly', truncated: false },
    });
    expect(tampered.success).toBe(false);
  });

  it('parses injected page capability probes as boolean-only metadata', async () => {
    const mod = await import('./v1.js').catch(() => null);

    expect(mod).not.toBeNull();
    if (!mod) return;

    const capabilities = mod.BrowserDiagnosticEventV1Schema.safeParse({
      v: 1,
      eventId: 'evt_caps_1',
      browserSessionId: 'bs_1',
      viewId: 'view_1',
      navigationGeneration: 1,
      capturedAtMs: 1,
      family: 'pageInfo',
      kind: 'pageInfo.capabilities',
      fidelity: 'injectedPage',
      trusted: false,
      collector: { collectorId: 'collector_1', nonce: 'nonce_1', version: '1.0.0' },
      data: {
        serviceWorker: true,
        webgl: true,
        webrtc: false,
        clipboard: true,
        webShare: false,
        indexedDbApi: true,
        notifications: false,
        geolocation: true,
      },
      redaction: { level: 'metadataOnly', truncated: false },
    });
    expect(capabilities.success).toBe(true);

    const tampered = mod.BrowserDiagnosticEventV1Schema.safeParse({
      v: 1,
      eventId: 'evt_caps_2',
      browserSessionId: 'bs_1',
      viewId: 'view_1',
      navigationGeneration: 1,
      capturedAtMs: 1,
      family: 'pageInfo',
      kind: 'pageInfo.capabilities',
      fidelity: 'injectedPage',
      trusted: false,
      collector: { collectorId: 'collector_1', nonce: 'nonce_1', version: '1.0.0' },
      data: { serviceWorker: 'enabled', userAgent: 'secret' },
      redaction: { level: 'metadataOnly', truncated: false },
    });
    expect(tampered.success).toBe(false);
  });
});

describe('browser diagnostics egress classifier + header SSOT', () => {
  it('classifies the WS subprotocol and credential fields as always-strip', async () => {
    const mod = await import('./egress/index.js').catch(() => null);
    expect(mod).not.toBeNull();
    if (!mod) return;

    expect(mod.classifyBrowserDiagnosticField('network.websocketOpened', 'protocol')).toBe('always-strip');
    expect(mod.classifyBrowserDiagnosticField('network.requestStarted', 'cookie')).toBe('always-strip');
    expect(mod.classifyBrowserDiagnosticField('network.requestStarted', 'Authorization')).toBe('always-strip');
  });

  it('keeps allowlisted fields and drops unknown ones per kind', async () => {
    const mod = await import('./egress/index.js').catch(() => null);
    expect(mod).not.toBeNull();
    if (!mod) return;

    expect(mod.classifyBrowserDiagnosticField('network.websocketOpened', 'hasProtocol')).toBe('keep');
    expect(mod.classifyBrowserDiagnosticField('network.websocketOpened', 'protocolCount')).toBe('keep');
    expect(mod.classifyBrowserDiagnosticField('network.websocketOpened', 'socketId')).toBe('keep');
    expect(mod.classifyBrowserDiagnosticField('network.requestStarted', 'lastMessage')).toBe('drop');
  });

  it('SAFE_TELEMETRY_HEADER_NAMES excludes sec-websocket-protocol (token-smuggling vector)', async () => {
    const mod = await import('./egress/index.js').catch(() => null);
    expect(mod).not.toBeNull();
    if (!mod) return;

    expect(mod.SAFE_TELEMETRY_HEADER_NAMES.has('sec-websocket-protocol')).toBe(false);
    expect(mod.isSafeTelemetryHeaderName('Sec-WebSocket-Protocol')).toBe(false);
    expect(mod.isSafeTelemetryHeaderName('authorization')).toBe(false);
    expect(mod.isSafeTelemetryHeaderName('Content-Type')).toBe(true);
  });

  it('redactDiagnosticsHeaders drops everything but the allowlist and never surfaces the subprotocol', async () => {
    const mod = await import('./egress/index.js').catch(() => null);
    expect(mod).not.toBeNull();
    if (!mod) return;

    const out = mod.redactDiagnosticsHeaders({
      authorization: 'Bearer secret-token',
      cookie: 'session=abc',
      'sec-websocket-protocol': 'base64url.bearer.authorization.k8s.io.eyJhbGciOi',
      'content-type': 'application/json',
      'x-request-id': 'req_1',
    });
    expect(out).toEqual({ 'content-type': 'application/json', 'x-request-id': 'req_1' });
    expect(JSON.stringify(out)).not.toContain('secret-token');
    expect(JSON.stringify(out)).not.toContain('bearer');
  });

  it('redactDiagnosticsUrl surfaces only safe query-param NAMES, never token values', async () => {
    const mod = await import('./egress/index.js').catch(() => null);
    expect(mod).not.toBeNull();
    if (!mod) return;

    const out = mod.redactDiagnosticsUrl('https://example.test/p?token=secret&page=2&api_key=k');
    expect(out.origin).toBe('https://example.test');
    expect(out.path).toBe('/p');
    expect(out.queryKeys).toEqual(['page']);
    expect(JSON.stringify(out)).not.toContain('secret');
  });

  it('resolveRedactionLevel grants full fidelity to the local owner for injected owner-value events', async () => {
    const mod = await import('./egress/index.js').catch(() => null);
    expect(mod).not.toBeNull();
    if (!mod) return;

    // DEV-2 reconcile: the injected console collector surfaces length-capped text to the LOCAL owner.
    // The over-gating bug forced EVERY injected event to metadata-only even for the owner; console
    // text is now full ('none') for the local owner with owner-full fidelity.
    expect(mod.resolveRedactionLevel('console.entry', 'localOwner', { injected: true, ownerFull: true })).toBe('none');
    // ...but only when owner-full fidelity is actually granted (fail-closed otherwise).
    expect(mod.resolveRedactionLevel('console.entry', 'localOwner', { injected: true, ownerFull: false })).toBe('metadataOnly');
    // ...and NEVER at an agent/remote destination (the WS-leak / secret model is preserved).
    expect(mod.resolveRedactionLevel('console.entry', 'agentContext', { injected: true, ownerFull: true })).toBe('metadataOnly');
    expect(mod.resolveRedactionLevel('console.entry', 'remoteSnapshot', { injected: true, ownerFull: true })).toBe('metadataOnly');
    expect(mod.resolveRedactionLevel('network.response', 'localOwner', { injected: true, ownerFull: true })).toBe('none');
    expect(mod.resolveRedactionLevel('storage.keyInventory', 'localOwner', { injected: true, ownerFull: true })).toBe('none');
    // Non-injected (cdp) fidelity is unchanged: full for the owner, metadata for agent/remote.
    expect(mod.resolveRedactionLevel('network.response', 'localOwner', { injected: false, ownerFull: true })).toBe('none');
    expect(mod.resolveRedactionLevel('network.response', 'agentContext', { injected: false, ownerFull: true })).toBe('metadataOnly');
    expect(mod.resolveRedactionLevel('network.response', 'remoteSnapshot', { injected: false, ownerFull: true })).toBe('metadataOnly');
  });

  it('classifies injected value-bearing fields as owner-only (keep for owner, drop for agent/remote)', async () => {
    const mod = await import('./egress/index.js').catch(() => null);
    expect(mod).not.toBeNull();
    if (!mod) return;

    // Destination-agnostic classify is fail-closed: an owner-only field reads as 'drop' so any egress
    // path that does not explicitly pass a destination strips the console text.
    expect(mod.classifyBrowserDiagnosticField('console.entry', 'text')).toBe('drop');
    // Destination-aware classify keeps it ONLY for the local owner.
    expect(mod.classifyBrowserDiagnosticFieldForDestination('console.entry', 'text', 'localOwner')).toBe('keep');
    expect(mod.classifyBrowserDiagnosticFieldForDestination('console.entry', 'text', 'agentContext')).toBe('drop');
    expect(mod.classifyBrowserDiagnosticFieldForDestination('console.entry', 'text', 'remoteSnapshot')).toBe('drop');
    expect(mod.classifyBrowserDiagnosticField('network.response', 'requestBodyText')).toBe('drop');
    expect(mod.classifyBrowserDiagnosticFieldForDestination('network.response', 'requestBodyText', 'localOwner')).toBe('keep');
    expect(mod.classifyBrowserDiagnosticFieldForDestination('network.response', 'requestBodyText', 'agentContext')).toBe('drop');
    expect(mod.classifyBrowserDiagnosticFieldForDestination('network.response', 'responseHeaders', 'remoteSnapshot')).toBe('drop');
    expect(mod.classifyBrowserDiagnosticField('storage.keyInventory', 'entries')).toBe('drop');
    expect(mod.classifyBrowserDiagnosticFieldForDestination('storage.keyInventory', 'entries', 'localOwner')).toBe('keep');
    expect(mod.classifyBrowserDiagnosticFieldForDestination('storage.keyInventory', 'entries', 'remoteSnapshot')).toBe('drop');
    // The always-strip vectors stay stripped even for the local owner.
    expect(mod.classifyBrowserDiagnosticFieldForDestination('console.entry', 'cookie', 'localOwner')).toBe('always-strip');
    expect(mod.classifyBrowserDiagnosticFieldForDestination('console.entry', 'authorization', 'localOwner')).toBe('always-strip');
    // Ordinary metadata fields keep at every destination.
    expect(mod.classifyBrowserDiagnosticFieldForDestination('console.entry', 'level', 'agentContext')).toBe('keep');
  });
});
