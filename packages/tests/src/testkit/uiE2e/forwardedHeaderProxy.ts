import { createServer, type IncomingMessage, type ServerResponse, request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { connect as netConnect } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import { once } from 'node:events';

type ProxyStop = () => Promise<void>;

function setCors(res: ServerResponse) {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  res.setHeader('access-control-allow-headers', 'authorization,content-type');
  res.setHeader('access-control-max-age', '600');
}

function coerceHeaders(headers: IncomingMessage['headers']): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (!k) continue;
    if (k.toLowerCase() === 'host') continue;
    if (typeof v === 'string') out[k] = v;
    else if (Array.isArray(v)) out[k] = v.join(', ');
  }
  return out;
}

export async function startForwardedHeaderProxy(params: {
  targetBaseUrl: string;
  identityHeaders: Record<string, string>;
}): Promise<{ baseUrl: string; stop: ProxyStop }> {
  const targetUrl = new URL(params.targetBaseUrl);
  const isHttps = targetUrl.protocol === 'https:';
  const targetPort = Number(targetUrl.port || (isHttps ? 443 : 80));
  const requestFn = isHttps ? httpsRequest : httpRequest;

  const srv = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.method === 'OPTIONS') {
      setCors(res);
      res.statusCode = 204;
      res.end();
      return;
    }

    const upstreamUrl = new URL(req.url ?? '/', targetUrl);
    const headers = coerceHeaders(req.headers);
    for (const [k, v] of Object.entries(params.identityHeaders)) {
      headers[k] = v;
    }

    const upstreamReq = requestFn(
      {
        protocol: targetUrl.protocol,
        hostname: targetUrl.hostname,
        port: targetPort,
        method: req.method,
        path: `${upstreamUrl.pathname}${upstreamUrl.search}`,
        headers: {
          ...headers,
          host: targetUrl.host,
        },
      },
      (upstreamRes) => {
        setCors(res);
        res.statusCode = upstreamRes.statusCode ?? 502;
        for (const [k, v] of Object.entries(upstreamRes.headers)) {
          if (!k) continue;
          if (k.toLowerCase() === 'access-control-allow-origin') continue;
          if (typeof v === 'string') res.setHeader(k, v);
          else if (Array.isArray(v)) res.setHeader(k, v);
        }
        upstreamRes.pipe(res);
      },
    );

    upstreamReq.on('error', () => {
      setCors(res);
      res.statusCode = 502;
      res.end('bad_gateway');
    });

    req.pipe(upstreamReq);
  });

  srv.on('upgrade', (req, socket, head) => {
    // Tunnel websocket upgrades directly to the upstream server to support daemon + UI socket clients.
    const connectFn = isHttps ? tlsConnect : netConnect;
    const upstream = connectFn(
      {
        host: targetUrl.hostname,
        port: targetPort,
        servername: isHttps ? targetUrl.hostname : undefined,
      } as any,
      () => {
        const headers = coerceHeaders(req.headers);
        for (const [k, v] of Object.entries(params.identityHeaders)) {
          headers[k] = v;
        }

        const lines: string[] = [];
        lines.push(`${req.method ?? 'GET'} ${req.url ?? '/'} HTTP/1.1`);
        lines.push(`Host: ${targetUrl.host}`);
        for (const [k, v] of Object.entries(headers)) {
          lines.push(`${k}: ${v}`);
        }
        lines.push('\r\n');
        upstream.write(lines.join('\r\n'));
        if (head && head.length > 0) upstream.write(head);

        socket.pipe(upstream);
        upstream.pipe(socket);
      },
    );

    upstream.on('error', () => {
      try {
        socket.destroy();
      } catch {
        // ignore
      }
    });
  });

  srv.listen(0, '127.0.0.1');
  await once(srv, 'listening');
  const addr = srv.address();
  if (!addr || typeof addr !== 'object') throw new Error('proxy missing address');
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  return {
    baseUrl,
    stop: async () => {
      srv.close();
      await once(srv, 'close');
    },
  };
}

