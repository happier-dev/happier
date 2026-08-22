import { afterEach, describe, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { connect as connectTcp, type Socket } from 'node:net';
import { join, resolve } from 'node:path';

import { io as socketIo, type Socket as SocketIoClient } from 'socket.io-client';
import tweetnacl from 'tweetnacl';

import {
  FeaturesResponseSchema,
  PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT,
  readServerEnabledBit,
  type LocalServicePreviewResourceV1,
  type PeerTcpTunnelRelayEnvelope,
} from '@happier-dev/protocol';

import { createTestAuth } from '../../src/testkit/auth';
import { seedCliAuthForTestAccount } from '../../src/testkit/cliAuth';
import { daemonControlPostJson } from '../../src/testkit/daemon/controlServerClient';
import { startTestDaemon, type StartedDaemon } from '../../src/testkit/daemon/daemon';
import { fetchJson } from '../../src/testkit/http';
import { fetchMachineIdentities } from '../../src/testkit/machineIdentity';
import { reserveAvailablePort } from '../../src/testkit/network/reserveAvailablePort';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { createRunDirs } from '../../src/testkit/runDir';
import { createSession } from '../../src/testkit/sessions';
import { waitFor } from '../../src/testkit/timing';
import { waitForDaemonMachineIdFromCliSettings } from '../../src/testkit/uiE2e/daemonMachineId';

const run = createRunDirs({ runLabel: 'core' });

type PreviewApp = Readonly<{
  baseUrl: string;
  port: number;
  requests: string[];
  upgrades: string[];
  stop: () => Promise<void>;
}>;

function toBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

function writePreviewResponse(req: IncomingMessage, res: ServerResponse, requests: string[]): void {
  const url = req.url ?? '/';
  requests.push(url);
  const body = JSON.stringify({
    ok: true,
    url,
    marker: 'live-preview-http-through-pms',
  });
  res.writeHead(200, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
    'x-live-preview-path': url,
  });
  res.end(body);
}

function webSocketAcceptKey(key: string): string {
  return createHash('sha1')
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest('base64');
}

async function startPreviewApp(port: number): Promise<PreviewApp> {
  const requests: string[] = [];
  const upgrades: string[] = [];
  const server: Server = createServer((req, res) => writePreviewResponse(req, res, requests));
  server.on('upgrade', (req, socket) => {
    const url = req.url ?? '/';
    upgrades.push(url);
    const requestedProtocol = Array.isArray(req.headers['sec-websocket-protocol'])
      ? req.headers['sec-websocket-protocol'][0]
      : req.headers['sec-websocket-protocol'];
    const key = Array.isArray(req.headers['sec-websocket-key'])
      ? req.headers['sec-websocket-key'][0]
      : req.headers['sec-websocket-key'];
    const protocolLine = requestedProtocol ? `Sec-WebSocket-Protocol: ${requestedProtocol}\r\n` : '';
    const acceptLine = key ? `Sec-WebSocket-Accept: ${webSocketAcceptKey(key)}\r\n` : '';
    socket.write([
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      acceptLine.trimEnd(),
      protocolLine.trimEnd(),
      '',
      '',
    ].filter((line) => line.length > 0).join('\r\n') + '\r\n\r\n');
    socket.end();
  });

  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', rejectListen);
      resolveListen();
    });
  });

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    port,
    requests,
    upgrades,
    stop: async () => {
      await new Promise<void>((resolveClose, rejectClose) => {
        server.close((error) => {
          if (error) {
            rejectClose(error);
            return;
          }
          resolveClose();
        });
      });
    },
  };
}

type PreviewRegistrationResponse = Readonly<{
  resource?: LocalServicePreviewResourceV1;
  accessUrl?: string;
  expiresAt?: number;
  error?: string;
  reasonCode?: string;
}>;

type PreviewHttpResponse = Readonly<{
  ok?: boolean;
  url?: string;
  marker?: string;
}>;
type LocalServicesInventorySnapshotResponse = Readonly<{
  ok?: boolean;
  snapshot?: {
    entries?: readonly unknown[];
  };
}>;
type JsonFetchResponse<T> = Readonly<{
  status: number;
  headers: Headers;
  data: T;
  cookie?: string;
}>;

async function fetchPreviewJsonWithCookieExchange<T>(
  url: string,
  init?: RequestInit & { timeoutMs?: number },
): Promise<JsonFetchResponse<T>> {
  const timeoutMs = init?.timeoutMs ?? 15_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const first = await fetch(url, { ...init, redirect: 'manual', signal: controller.signal });
    if (first.status !== 303) {
      const text = await first.text();
      return {
        status: first.status,
        headers: first.headers,
        data: (text ? JSON.parse(text) : null) as T,
      };
    }

    const location = first.headers.get('location');
    const setCookie = first.headers.get('set-cookie');
    const cookie = setCookie?.split(';')[0];
    if (!location || !cookie) {
      const text = await first.text();
      return {
        status: first.status,
        headers: first.headers,
        data: (text ? JSON.parse(text) : null) as T,
      };
    }

    const redirected = await fetch(new URL(location, url), {
      headers: {
        cookie,
      },
      signal: controller.signal,
    });
    const text = await redirected.text();
    return {
      status: redirected.status,
      headers: redirected.headers,
      data: (text ? JSON.parse(text) : null) as T,
      cookie,
    };
  } finally {
    clearTimeout(timer);
  }
}

function summarizeRelayEvents(events: readonly PeerTcpTunnelRelayEnvelope[]): unknown {
  return {
    count: events.length,
    last: events.slice(-12).map((event) => {
      if (event.v === 1) {
        return {
          v: 1,
          sender: event.sender.kind,
          recipient: event.recipient.kind,
          kind: event.frame.kind,
          reasonCode: event.frame.kind === 'abort' || event.frame.kind === 'close'
            ? event.frame.reasonCode
            : undefined,
        };
      }
      return {
        v: 2,
        sender: event.sender.kind,
        recipient: event.recipient.kind,
        encoding: event.encoding,
        frameBytes: event.frame.length,
      };
    }),
  };
}

async function readRawHttpResponse(socket: Socket): Promise<string> {
  return await new Promise<string>((resolveRead, rejectRead) => {
    let buffer = '';
    const timer = setTimeout(() => {
      cleanup();
      rejectRead(new Error(`Timed out waiting for raw HTTP response; partial=${JSON.stringify(buffer)}`));
    }, 20_000);

    const cleanup = () => {
      clearTimeout(timer);
      socket.off('data', onData);
      socket.off('error', onError);
      socket.off('end', onEnd);
    };
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      if (buffer.includes('\r\n\r\n')) {
        cleanup();
        resolveRead(buffer);
      }
    };
    const onError = (error: Error) => {
      cleanup();
      rejectRead(error);
    };
    const onEnd = () => {
      cleanup();
      resolveRead(buffer);
    };

    socket.on('data', onData);
    socket.on('error', onError);
    socket.on('end', onEnd);
  });
}

async function requestRawWebSocketUpgrade(params: {
  serverUrl: string;
  pathAndSearch: string;
  protocol: string;
  cookie?: string;
}): Promise<string> {
  const serverUrl = new URL(params.serverUrl);
  const port = Number(serverUrl.port);
  const socket = connectTcp({ host: serverUrl.hostname, port });
  try {
    await new Promise<void>((resolveConnect, rejectConnect) => {
      socket.once('connect', resolveConnect);
      socket.once('error', rejectConnect);
    });
    socket.write([
      `GET ${params.pathAndSearch} HTTP/1.1`,
      `Host: ${serverUrl.host}`,
      'Upgrade: websocket',
      'Connection: Upgrade',
      'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
      'Sec-WebSocket-Version: 13',
      `Sec-WebSocket-Protocol: ${params.protocol}`,
      ...(params.cookie ? [`Cookie: ${params.cookie}`] : []),
      '',
      '',
    ].join('\r\n'));
    return await readRawHttpResponse(socket);
  } finally {
    socket.destroy();
  }
}

describe('core e2e: local service preview over production PMS relay', () => {
  let server: StartedServer | null = null;
  let daemon: StartedDaemon | null = null;
  let previewApp: PreviewApp | null = null;
  let relayProbeSocket: SocketIoClient | null = null;

  afterEach(async () => {
    relayProbeSocket?.close();
    relayProbeSocket = null;
    await daemon?.stop().catch(() => {});
    daemon = null;
    await server?.stop().catch(() => {});
    server = null;
    await previewApp?.stop().catch(() => {});
    previewApp = null;
  });

  it('proxies live HTTP and Vite-shaped WebSocket traffic through the daemon PMS opener', async () => {
    const testDir = run.testDir(`local-service-preview-live-pms-${randomUUID()}`);
    const daemonHomeDir = resolve(join(testDir, 'daemon-home'));
    await mkdir(daemonHomeDir, { recursive: true });

    const previewPort = await reserveAvailablePort();
    previewApp = await startPreviewApp(previewPort);

    const keyPair = tweetnacl.sign.keyPair();
    server = await startServerLight({
      testDir,
      dbProvider: 'sqlite',
      extraEnv: {
        HANDY_MASTER_SECRET: `preview-e2e-${randomUUID()}`,
        HAPPIER_FEATURE_LOCAL_SERVICES_PREVIEW__ENABLED: '1',
        HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__ENABLED: '1',
        HAPPIER_FEATURE_MACHINES_TUNNEL_ALLOWED_PORTS: String(previewPort),
        HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__SUPPORTED_ENCODINGS: 'binary_frame_v2,json_base64_v1',
        HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__PREFERRED_ENCODING: 'binary_frame_v2',
        HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__ALLOW_V1_FALLBACK: '0',
        HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__MAX_BYTES: `${8 * 1024 * 1024}`,
        HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__MAX_FRAME_BYTES: `${64 * 1024}`,
        HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__MAX_RAW_PAYLOAD_BYTES: `${64 * 1024}`,
        HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__MAX_FRAMED_MESSAGE_BYTES: `${128 * 1024}`,
        HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_KEY_ID: 'preview-e2e-grant-key',
        HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_PRIVATE_KEY: toBase64Url(keyPair.secretKey),
        HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_PUBLIC_KEY: toBase64Url(keyPair.publicKey),
        HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_EXPIRES_AT: String(Date.now() + 60 * 60 * 1000),
      },
    });

    const auth = await createTestAuth(server.baseUrl);
    const featuresResponse = await fetchJson<unknown>(`${server.baseUrl}/v1/features`, { timeoutMs: 20_000 });
    const features = FeaturesResponseSchema.parse(featuresResponse.data);
    expect(readServerEnabledBit(features, 'localServices.preview')).toBe(true);
    expect(readServerEnabledBit(features, 'machines.tunnel.serverRouted')).toBe(true);
    expect(features.capabilities.machines.tunnel.directPeer.allowedPorts).toContain(previewPort);
    expect(features.capabilities.machines.peerMediation.grantSigningKeys.length).toBeGreaterThan(0);

    const relayEvents: PeerTcpTunnelRelayEnvelope[] = [];
    relayProbeSocket = socketIo(server.baseUrl, {
      path: '/v1/updates/',
      auth: { token: auth.token, clientType: 'user-scoped' },
      transports: ['websocket'],
      reconnection: false,
      autoConnect: false,
    });
    relayProbeSocket.on(PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT, (payload: PeerTcpTunnelRelayEnvelope) => {
      relayEvents.push(payload);
    });
    relayProbeSocket.connect();
    await waitFor(() => relayProbeSocket?.connected === true, {
      timeoutMs: 20_000,
      context: 'user relay probe socket connected before preview data-plane request',
    });

    await seedCliAuthForTestAccount({
      cliHome: daemonHomeDir,
      serverUrl: server.baseUrl,
      auth,
      mode: 'legacy',
    });

    daemon = await startTestDaemon({
      testDir,
      happyHomeDir: daemonHomeDir,
      env: {
        ...process.env,
        CI: '1',
        HAPPIER_VARIANT: 'dev',
        HAPPIER_DISABLE_CAFFEINATE: '1',
        HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1',
        HAPPIER_E2E_CLI_SNAPSHOT_NODE_MODULES_MODE: 'symlink',
        HAPPIER_HOME_DIR: daemonHomeDir,
        HAPPIER_SERVER_URL: server.baseUrl,
        HAPPIER_WEBAPP_URL: server.baseUrl,
      },
      startupTimeoutMs: 300_000,
    });
    const controlToken = (daemon.state as { controlToken?: string }).controlToken;

    let detectedInventoryEntry: unknown = null;
    await waitFor(async () => {
      const inventory = await daemonControlPostJson<LocalServicesInventorySnapshotResponse>({
        port: daemon!.state.httpPort,
        path: '/local-services/inventory/refresh',
        controlToken,
        timeoutMs: 60_000,
      });
      if (inventory.status !== 200 || inventory.data.ok !== true) return false;
      const entries = Array.isArray(inventory.data.snapshot?.entries)
        ? inventory.data.snapshot.entries
        : [];
      detectedInventoryEntry = entries.find((entry) => {
        const row = entry as { port?: unknown };
        return Number(row.port) === previewPort;
      }) ?? null;
      return detectedInventoryEntry !== null;
    }, {
      timeoutMs: 120_000,
      intervalMs: 1_000,
      context: 'daemon local-services inventory detects the live preview app',
    });
    expect(detectedInventoryEntry).toMatchObject({
      port: previewPort,
      state: 'listening',
    });

    const machineId = await waitForDaemonMachineIdFromCliSettings({
      cliHomeDir: daemonHomeDir,
      timeoutMs: 120_000,
    });
    await waitFor(async () => {
      const machines = await fetchMachineIdentities({ baseUrl: server!.baseUrl, token: auth.token });
      const machine = machines.find((row) => row.id === machineId);
      return machine?.active === true;
    }, {
      timeoutMs: 120_000,
      intervalMs: 250,
      context: 'daemon machine active on server before preview relay',
    });

    const { sessionId } = await createSession(server.baseUrl, auth.token, { timeoutMs: 20_000 });
    const previewId = `preview_${randomUUID()}`;
    const previewResource: LocalServicePreviewResourceV1 = {
      previewId,
      sessionId,
      machineId,
      owner: { kind: 'session', id: sessionId },
      target: { scheme: 'http', host: '127.0.0.1', port: previewPort },
      initialPath: { pathname: '/dashboard', search: '?from=initial' },
      display: {
        title: 'Live PMS Preview',
        addressLabel: `127.0.0.1:${previewPort}`,
      },
      originMode: 'path',
      policy: {
        allowedMethods: ['GET', 'HEAD', 'POST', 'OPTIONS'],
        cookiePolicy: 'drop',
        compressionPolicy: 'identity',
        redirectPolicy: 'rewrite_path_mode',
        maxRequestBodyBytes: 1024 * 1024,
        maxResponseBodyBytes: 1024 * 1024,
      },
      browserTarget: {
        kind: 'localServicePreview',
        targetId: previewId,
        sessionId,
        machineId,
        display: {
          title: 'Live PMS Preview',
          addressLabel: `127.0.0.1:${previewPort}`,
        },
      },
    };

    const registration = await fetchJson<PreviewRegistrationResponse>(`${server.baseUrl}/v1/local-services/preview`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${auth.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(previewResource),
      timeoutMs: 20_000,
    });
    expect(registration.status).toBe(201);
    expect(registration.data.resource?.previewId).toBe(previewId);
    expect(typeof registration.data.accessUrl).toBe('string');
    if (typeof registration.data.accessUrl !== 'string') {
      throw new Error(`Missing preview access URL: ${JSON.stringify(registration.data)}`);
    }

    const previewUrl = new URL(registration.data.accessUrl);
    const httpResponse: { current: JsonFetchResponse<PreviewHttpResponse> | null } = { current: null };
    try {
      await waitFor(async () => {
        httpResponse.current = await fetchPreviewJsonWithCookieExchange<PreviewHttpResponse>(previewUrl.toString(), {
          timeoutMs: 5_000,
        });
        return httpResponse.current.status === 200
          && httpResponse.current.data?.marker === 'live-preview-http-through-pms';
      }, {
        timeoutMs: 60_000,
        intervalMs: 250,
        context: 'preview HTTP data-plane through daemon PMS relay',
      });
    } catch (error) {
      throw new Error([
        error instanceof Error ? error.message : String(error),
        `lastHttpStatus=${httpResponse.current?.status ?? 'none'}`,
        `lastHttpBody=${JSON.stringify(httpResponse.current?.data ?? null)}`,
        `previewRequests=${JSON.stringify(previewApp.requests)}`,
        `relayEvents=${JSON.stringify(summarizeRelayEvents(relayEvents))}`,
      ].join(' | '));
    }
    expect(httpResponse.current?.status).toBe(200);
    expect(httpResponse.current?.data).toMatchObject({
      ok: true,
      marker: 'live-preview-http-through-pms',
      url: '/dashboard?from=initial',
    });

    await waitFor(() => previewApp!.requests.includes('/dashboard?from=initial'), {
      timeoutMs: 20_000,
      context: 'local preview HTTP request through daemon PMS relay',
    });

    const hmrUrl = new URL(registration.data.accessUrl);
    hmrUrl.pathname = `/v1/local-services/preview/${encodeURIComponent(previewId)}/@vite/client`;
    hmrUrl.searchParams.delete('previewToken');
    hmrUrl.searchParams.set('hmr', '1');
    const previewCookie = httpResponse.current?.cookie;
    if (!previewCookie) {
      throw new Error('Missing preview cookie from HTTP data-plane exchange');
    }
    const rawUpgradeResponse = await requestRawWebSocketUpgrade({
      serverUrl: server.baseUrl,
      pathAndSearch: `${hmrUrl.pathname}${hmrUrl.search}`,
      protocol: 'vite-hmr',
      cookie: previewCookie,
    });

    expect(rawUpgradeResponse).toContain('HTTP/1.1 101 Switching Protocols');
    expect(rawUpgradeResponse).toContain('Sec-WebSocket-Protocol: vite-hmr');
    const hasExpectedUpgrade = () => previewApp!.upgrades.some((entry) => {
      const parsed = new URL(entry, previewApp!.baseUrl);
      return parsed.pathname === '/@vite/client'
        && parsed.searchParams.get('hmr') === '1'
        && !parsed.searchParams.has('previewToken');
    });
    try {
      await waitFor(hasExpectedUpgrade, {
        timeoutMs: 20_000,
        context: 'local preview WebSocket upgrade through daemon PMS relay',
      });
    } catch (error) {
      throw new Error([
        error instanceof Error ? error.message : String(error),
        `previewUpgrades=${JSON.stringify(previewApp.upgrades)}`,
        `rawUpgradeResponse=${JSON.stringify(rawUpgradeResponse)}`,
      ].join(' | '));
    }
  });
});
