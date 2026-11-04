import type { BrowserDiagnosticEventV1 } from '@happier-dev/protocol/browser/diagnostics/v1';

import {
  applyBrowserDiagnosticEvents,
  createBrowserDiagnosticsUiStore,
  type BrowserDiagnosticsUiStore,
} from '@/sync/domains/browser/diagnostics';

/**
 * Dev-only: a Lumen sign-in page's diagnostics, in the shapes the daemon's collectors emit
 * (`apps/cli/src/daemon/browser/sidecar/diagnostics/mapEvents.ts` for CDP; the injected page
 * collector for storage, resources, elements and vitals). They go through the real UI store, so the
 * drawer renders exactly what the normalizer admits.
 */
const CDP_BASE = {
  v: 1,
  browserSessionId: 'browser_session_specimen',
  viewId: 'view_1',
  navigationGeneration: 0,
  fidelity: 'cdp',
  trusted: true,
  redaction: {
    level: 'metadataOnly',
    queryRedacted: true,
    headersRedacted: true,
    truncated: false,
  },
} as const;

const INJECTED_BASE = {
  ...CDP_BASE,
  fidelity: 'injectedPage',
  trusted: false,
  collector: {
    collectorId: 'collector_lumen',
    nonce: 'nonce_lumen',
    version: '1.0.0',
  },
} as const;

let clock = 1_000;
function at(): number {
  clock += 37;
  return clock;
}

function cdp(
  eventId: string,
  family: BrowserDiagnosticEventV1['family'],
  kind: BrowserDiagnosticEventV1['kind'],
  data: Record<string, unknown>,
  redaction?: Partial<BrowserDiagnosticEventV1['redaction']>,
): BrowserDiagnosticEventV1 {
  return {
    ...CDP_BASE,
    eventId,
    capturedAtMs: at(),
    family,
    kind,
    data,
    ...(redaction
      ? { redaction: { ...CDP_BASE.redaction, ...redaction } }
      : {}),
  };
}

function injected(
  eventId: string,
  family: BrowserDiagnosticEventV1['family'],
  kind: BrowserDiagnosticEventV1['kind'],
  data: Record<string, unknown>,
): BrowserDiagnosticEventV1 {
  return { ...INJECTED_BASE, eventId, capturedAtMs: at(), family, kind, data };
}

const CONSOLE = [
  cdp(
    'c1',
    'console',
    'console.entry',
    { level: 'info', textAvailable: true, text: "[vite] connected.", argCount: 1 },
    { level: 'valuesRedacted' },
  ),
  cdp(
    'c2',
    'console',
    'console.entry',
    { level: 'log', textAvailable: true, text: "Lumen auth: restoring session for ana@lumen.dev", argCount: 2 },
    { level: 'valuesRedacted' },
  ),
  cdp(
    'c3',
    'console',
    'console.entry',
    { level: 'warning', textAvailable: true, text: "Feature flag \"newCheckout\" is not defined; using default (off)", argCount: 1 },
    { level: 'valuesRedacted' },
  ),
  cdp(
    'c4',
    'console',
    'console.entry',
    { level: 'error', textAvailable: true, text: "Sign-in failed: 401 Unauthorized at submitSignIn (login.tsx:88)", argCount: 3 },
    { level: 'valuesRedacted' },
  ),
  cdp(
    'c5',
    'console',
    'console.entry',
    { level: 'debug', textAvailable: true, text: "router: matched /login in 0.4 ms", argCount: 1 },
    { level: 'valuesRedacted' },
  ),
];

const PAGE_ERRORS = [
  cdp(
    'e1',
    'pageError',
    'pageError.thrown',
    { messageAvailable: true, stackAvailable: true, textAvailable: true, text: "TypeError: Cannot read properties of undefined (reading 'flags')" },
    { level: 'valuesRedacted' },
  ),
];

const NETWORK = [
  cdp('n1', 'network', 'network.requestStarted', {
    requestId: 'req_1',
    method: 'GET',
    resourceType: 'Document',
    url: 'http://localhost:5173/login',
  }),
  cdp('n2', 'network', 'network.response', {
    requestId: 'req_1',
    status: 200,
    mimeType: 'text/html',
    durationMs: 42,
    responseBytes: 2_318,
    url: 'http://localhost:5173/login',
  }),
  cdp('n3', 'network', 'network.requestStarted', {
    requestId: 'req_2',
    method: 'GET',
    resourceType: 'Script',
    url: 'http://localhost:5173/assets/index-4f2a9c.js',
  }),
  cdp('n4', 'network', 'network.response', {
    requestId: 'req_2',
    status: 200,
    mimeType: 'application/javascript',
    durationMs: 118,
    responseBytes: 284_112,
    url: 'http://localhost:5173/assets/index-4f2a9c.js',
  }),
  cdp('n5', 'network', 'network.requestStarted', {
    requestId: 'req_3',
    method: 'POST',
    resourceType: 'Fetch',
    url: 'http://localhost:5173/api/session',
  }),
  cdp('n6', 'network', 'network.response', {
    requestId: 'req_3',
    status: 401,
    mimeType: 'application/json',
    durationMs: 233,
    responseBytes: 61,
    responseBodyText: '{"error":"invalid_credentials","retryAfter":null}',
    url: 'http://localhost:5173/api/session',
  }),
  cdp('n7', 'network', 'network.failed', {
    requestId: 'req_4',
    url: 'http://localhost:5173/api/flags',
    errorText: 'net::ERR_CONNECTION_REFUSED',
  }),
  cdp('n8', 'network', 'network.websocketSummary', {
    socketId: 'socket_1',
    url: 'ws://localhost:5173/',
    framesSent: 4,
    framesReceived: 18,
    bytesSent: 312,
    bytesReceived: 4_096,
  }),
];

const PAGE = [
  cdp('p1', 'pageInfo', 'pageInfo.snapshot', {
    url: 'http://localhost:5173/login',
    title: 'Lumen · Sign in',
  }),
  injected('p2', 'pageInfo', 'pageInfo.domSnapshot', {
    nodeCount: 412,
    elementCount: 236,
    maxDepth: 14,
    readyState: 'complete',
  }),
  injected('s1', 'storage', 'storage.keyInventory', {
    storageType: 'localStorage',
    keyCount: 4,
    keysTruncated: false,
    keys: [
      'lumen.theme',
      'lumen.lastRoute',
      'lumen.onboarding.v2',
      'vite-hmr-id',
    ],
  }),
  injected('s2', 'storage', 'storage.keyInventory', {
    storageType: 'sessionStorage',
    keyCount: 1,
    keysTruncated: false,
    keys: ['lumen.returnTo'],
  }),
  injected('r1', 'resources', 'resources.snapshot', {
    entries: [
      {
        name: 'http://localhost:5173/assets/index-4f2a9c.js',
        initiatorType: 'script',
        durationMs: 84,
      },
      {
        name: 'http://localhost:5173/assets/index-91be0d.css',
        initiatorType: 'link',
        durationMs: 21,
      },
      {
        name: 'http://localhost:5173/fonts/inter-var.woff2',
        initiatorType: 'css',
        durationMs: 46,
      },
      {
        name: 'http://localhost:5173/lumen-mark.svg',
        initiatorType: 'img',
        durationMs: 9,
      },
    ],
  }),
  injected('v1', 'performance', 'performance.vitals', {
    lcpMs: 812,
    fcpMs: 344,
    clsScore: 0.02,
    inpMs: 64,
    longTaskCount: 2,
    longTaskTotalMs: 138,
  }),
  cdp('el1', 'elements', 'elements.pickerState', {
    state: 'selected',
    selectorPath: 'main > form.signin > button[type=submit]',
    backendNodeRef: 'node_88',
    rectAvailable: true,
    accessibleNameAvailable: true,
  }),
];

export function buildSpecimenDiagnosticsState(): BrowserDiagnosticsUiStore {
  clock = 1_000;
  return applyBrowserDiagnosticEvents(createBrowserDiagnosticsUiStore(), {
    events: [...CONSOLE, ...PAGE_ERRORS, ...NETWORK, ...PAGE],
  });
}
