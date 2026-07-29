import { describe, expect, it } from 'vitest';

import {
  BrowserDiagnosticEventV1Schema,
  classifyBrowserDiagnosticFieldForDestination,
  INJECTED_CONSOLE_TEXT_MAX_LENGTH,
  INJECTED_EVENT_ALLOWED_FIELDS,
  INJECTED_OWNER_ONLY_FIELDS,
  redactDiagnosticsHeaders,
  redactDiagnosticsUrl,
  resolveRedactionLevel,
  SAFE_TELEMETRY_HEADER_NAMES,
  type BrowserDiagnosticEventV1,
} from '@happier-dev/protocol';

/**
 * §23 T-E2E-diagnostics-egress (LANE-B, root cause B + the over-gating mandate).
 *
 * The model: capture FULL fidelity → render full to the LOCAL owner → redact ONLY at agent/remote
 * egress. Two failure modes this suite locks down with a SEEDED secret:
 *   1. The WebSocket subprotocol value is a credential-egress vector (clients smuggle bearer tokens
 *      through `sec-websocket-protocol`), so it must NEVER survive to ANY destination — not even the
 *      local owner — and the schema must surface `hasProtocol`/`protocolCount` instead of the raw
 *      value (`D4`/`DUP-2`).
 *   2. The injected console `text` is the local owner's OWN page output and must reach the local
 *      owner at full fidelity, while being dropped for `agentContext`/`remoteSnapshot` (`DEV-2`/B3).
 *
 * It drives the REAL protocol egress SSOT — `classifyBrowserDiagnosticFieldForDestination`,
 * `resolveRedactionLevel`, `redactDiagnosticsHeaders`/`redactDiagnosticsUrl`, and the
 * `INJECTED_EVENT_ALLOWED_FIELDS` schema allowlist — which every production layer (the protocol
 * refine, the daemon sidecar map, the host re-sanitizer, the agent-context summarize, and the
 * cross-device snapshot RPC) delegates to. There are no internal mocks: the projection below is a
 * thin field-by-field application of the production classifier (the exact contract those layers use).
 */

type EgressDestination = 'localOwner' | 'agentContext' | 'remoteSnapshot';
const AGENT_DESTINATIONS: readonly EgressDestination[] = ['agentContext', 'remoteSnapshot'];
const ALL_DESTINATIONS: readonly EgressDestination[] = ['localOwner', 'agentContext', 'remoteSnapshot'];

const WS_SUBPROTOCOL_SECRET = 'base64url.bearer.authorization.k8s.io.SEEDED_TOKEN_do_not_egress';
const CONSOLE_SECRET_TEXT = 'owner console line: api key sk-SEEDED_owner_only_value';

/**
 * Project an event's `data` for a destination using the REAL classifier — the same per-field
 * keep/drop verdict the agent-context summarize and the snapshot RPC apply. `keep` survives;
 * `drop`/`always-strip` are removed.
 */
function projectEventDataForEgress(
  event: BrowserDiagnosticEventV1,
  destination: EgressDestination,
): Readonly<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(event.data as Record<string, unknown>)) {
    const disposition = classifyBrowserDiagnosticFieldForDestination(event.kind, field, destination);
    if (disposition === 'keep') out[field] = value;
  }
  return out;
}

function consoleEntryEvent(): BrowserDiagnosticEventV1 {
  return BrowserDiagnosticEventV1Schema.parse({
    v: 1,
    eventId: 'evt_console_secret',
    browserSessionId: 'bs_egress',
    viewId: 'view_egress',
    navigationGeneration: 1,
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
      text: CONSOLE_SECRET_TEXT,
    },
    redaction: { level: 'none', truncated: false },
  });
}

function websocketOpenedEvent(): BrowserDiagnosticEventV1 {
  return BrowserDiagnosticEventV1Schema.parse({
    v: 1,
    eventId: 'evt_ws_open',
    browserSessionId: 'bs_egress',
    viewId: 'view_egress',
    navigationGeneration: 1,
    capturedAtMs: 1_900_000,
    family: 'network',
    kind: 'network.websocketOpened',
    fidelity: 'injectedPage',
    trusted: false,
    collector: { collectorId: 'collector_1', nonce: 'nonce_1', version: '1.0.0' },
    data: {
      socketId: 'ws_1',
      url: 'wss://example.test/socket',
      hasProtocol: true,
      protocolCount: 1,
    },
    redaction: { level: 'metadataOnly', truncated: false },
  });
}

describe('core e2e: browser diagnostics egress redaction (LANE-B)', () => {
  it('drops the seeded console secret for every agent/remote destination but keeps it for the local owner', () => {
    const event = consoleEntryEvent();
    // The local owner sees the full console text (their own page output).
    const ownerView = projectEventDataForEgress(event, 'localOwner');
    expect(ownerView.text).toBe(CONSOLE_SECRET_TEXT);
    expect(ownerView.level).toBe('log');

    // Agent/remote egress carries metadata only — the value-bearing `text` is gone.
    for (const destination of AGENT_DESTINATIONS) {
      const projected = projectEventDataForEgress(event, destination);
      expect(projected.text).toBeUndefined();
      expect(JSON.stringify(projected)).not.toContain('SEEDED_owner_only_value');
      // Metadata still flows so the agent knows a console entry happened.
      expect(projected.level).toBe('log');
      expect(projected.argCount).toBe(1);
    }

    // The owner-only registry is the SSOT for that asymmetry.
    expect(INJECTED_OWNER_ONLY_FIELDS['console.entry']?.has('text')).toBe(true);
  });

  it('always-strips the WebSocket subprotocol value at EVERY destination (no secret survives anywhere)', () => {
    // The seeded subprotocol secret must never be classifiable as keepable, even for the local owner.
    for (const destination of ALL_DESTINATIONS) {
      expect(classifyBrowserDiagnosticFieldForDestination('network.websocketOpened', 'protocol', destination))
        .toBe('always-strip');
      expect(classifyBrowserDiagnosticFieldForDestination('network.websocketOpened', 'authorization', destination))
        .toBe('always-strip');
      expect(classifyBrowserDiagnosticFieldForDestination('network.websocketOpened', 'cookie', destination))
        .toBe('always-strip');
    }

    // Schema-level proof: the websocketOpened allowlist surfaces presence metadata, never the value.
    const allowed = INJECTED_EVENT_ALLOWED_FIELDS['network.websocketOpened'];
    expect(allowed?.has('protocol')).toBe(false);
    expect(allowed?.has('hasProtocol')).toBe(true);
    expect(allowed?.has('protocolCount')).toBe(true);

    // Even if a tampering producer smuggled the raw `protocol` value into a captured event, the
    // egress projection drops it at every destination.
    const tampered = { ...websocketOpenedEvent(), data: { socketId: 'ws_1', url: 'wss://example.test/socket', hasProtocol: true, protocolCount: 1, protocol: WS_SUBPROTOCOL_SECRET } } as BrowserDiagnosticEventV1;
    for (const destination of ALL_DESTINATIONS) {
      const projected = projectEventDataForEgress(tampered, destination);
      expect(projected.protocol).toBeUndefined();
      expect(JSON.stringify(projected)).not.toContain('SEEDED_TOKEN');
      expect(projected.hasProtocol).toBe(true);
      expect(projected.protocolCount).toBe(1);
    }
  });

  it('resolves the local-owner-full / agent-metadata redaction levels for injected console text', () => {
    expect(resolveRedactionLevel('console.entry', 'localOwner', { injected: true, ownerFull: true })).toBe('none');
    expect(resolveRedactionLevel('console.entry', 'agentContext', { injected: true, ownerFull: true })).toBe('metadataOnly');
    expect(resolveRedactionLevel('console.entry', 'remoteSnapshot', { injected: true, ownerFull: true })).toBe('metadataOnly');
    // Other injected (page-tamperable) kinds stay metadata-only even locally.
    expect(resolveRedactionLevel('network.websocketOpened', 'localOwner', { injected: true, ownerFull: true })).toBe('metadataOnly');
    // The owner-text capped ceiling is the single producer/schema/host ceiling.
    expect(INJECTED_CONSOLE_TEXT_MAX_LENGTH).toBeGreaterThan(0);
  });

  it('redacts a seeded header bag to the value-safe allowlist (sec-websocket-protocol / authorization / cookie dropped)', () => {
    const redacted = redactDiagnosticsHeaders({
      accept: 'application/json',
      'content-type': 'application/json',
      'x-request-id': 'req_123',
      authorization: 'Bearer SEEDED_bearer_token',
      cookie: 'session=SEEDED_cookie_value',
      'sec-websocket-protocol': WS_SUBPROTOCOL_SECRET,
      'x-internal-secret': 'SEEDED_internal',
    });

    expect(redacted.accept).toBe('application/json');
    expect(redacted['content-type']).toBe('application/json');
    expect(redacted['x-request-id']).toBe('req_123');
    expect(redacted.authorization).toBeUndefined();
    expect(redacted.cookie).toBeUndefined();
    expect(redacted['sec-websocket-protocol']).toBeUndefined();
    expect(JSON.stringify(redacted)).not.toContain('SEEDED');
    // The allowlist never includes the WS subprotocol smuggling vector.
    expect(SAFE_TELEMETRY_HEADER_NAMES.has('sec-websocket-protocol')).toBe(false);
  });

  it('redacts a URL to origin/path + value-safe query NAMES (never the secret values)', () => {
    const redacted = redactDiagnosticsUrl('https://app.test/dashboard?view=main&token=SEEDED_query_secret&password=SEEDED_pw');
    expect(redacted.origin).toBe('https://app.test');
    expect(redacted.path).toBe('/dashboard');
    expect(redacted.queryKeys).toContain('view');
    // Sensitive query keys are dropped entirely.
    expect(redacted.queryKeys).not.toContain('token');
    expect(redacted.queryKeys).not.toContain('password');
    expect(JSON.stringify(redacted)).not.toContain('SEEDED');
  });
});
