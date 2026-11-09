import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { selectRelayHttpsPort } from './listener.mjs';

test('Funnel selects only capability ports and never exposes another route on an owned root', async () => {
  const runtimeState = { ports: { relayHttps: 8443 }, irohRelay: { upstreamUrl: 'http://127.0.0.1:3340' } };
  const port = await selectRelayHttpsPort({ funnel: true, runtimeState,
    tailscaleStatusText: JSON.stringify({ Self: { CapMap: {
      'https://tailscale.com/cap/funnel-ports?ports=443,8443,10000': [],
    } } }),
    serveStatusText: JSON.stringify({ TCP: { '443': { HTTPS: true }, '8443': { HTTPS: true } }, Web: {
      'host.example:443': { Handlers: { '/team': { Text: 'foreign' } } },
      'host.example:8443': { Handlers: { '/': { Proxy: runtimeState.irohRelay.upstreamUrl }, '/team': { Text: 'foreign' } } },
    } }),
  });
  assert.equal(port, 10000);
});

test('Funnel respects advertised port ranges instead of guessing defaults', async () => {
  assert.equal(await selectRelayHttpsPort({ funnel: true, serveStatusText: '{}',
    tailscaleStatusText: JSON.stringify({ Self: { Capabilities: [
      'https://tailscale.com/cap/funnel-ports?ports=10001-10002',
    ] } }),
  }), 10001);
});

test('Funnel falls back to documented ports and refuses exhaustion without allocating a private port', async () => {
  await assert.rejects(selectRelayHttpsPort({ funnel: true, tailscaleStatusText: '{}',
    serveStatusText: JSON.stringify({ TCP: { '443': {}, '8443': {}, '10000': {} } }),
  }), { code: 'relay_serve_port_unavailable' });
});

test('Funnel skips an occupied native listener and does not replace malformed capability data with defaults', async t => {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  for (const ports of [String(server.address().port), 'invalid']) {
    await assert.rejects(selectRelayHttpsPort({ funnel: true, serveStatusText: '{}',
      tailscaleStatusText: JSON.stringify({ Self: { CapMap: {
        [`https://tailscale.com/cap/funnel-ports?ports=${ports}`]: [],
      } } }),
    }), { code: 'relay_serve_port_unavailable' });
  }
});

test('an exclusive AllowFunnel mapping to the recorded upstream is reusable only with opt-in', async () => {
  const input = { runtimeState: { ports: { relayHttps: 10000 }, irohRelay: { upstreamUrl: 'http://127.0.0.1:3340' } },
    serveStatusText: JSON.stringify({ TCP: { '10000': { HTTPS: true } },
      Web: { 'host.example:10000': { Handlers: { '/': { Proxy: 'http://localhost:3340' } } } },
      AllowFunnel: { 'host.example:10000': true } }),
  };
  assert.equal(await selectRelayHttpsPort({ ...input, funnel: true }), 10000);
  assert.notEqual(await selectRelayHttpsPort(input), 10000);
});

test('TCP, web-only and foreground listeners are excluded before using the existing allocator', async () => {
  const port = await selectRelayHttpsPort({ serveStatusText: JSON.stringify({
    TCP: { '8443': { TCPForward: '127.0.0.1:3001' } },
    Web: { 'host.example:8444': { Handlers: { '/other': { Text: 'foreign' } } } },
    Foreground: { current: { TCP: { '8445': { HTTPS: true } } } },
  }) });
  assert.ok(port >= 8446);
});

test('an exhausted TCP port space returns an actionable typed failure', async () => {
  const TCP = Object.fromEntries(Array.from({ length: 65536 - 8443 }, (_, index) => [8443 + index, {}]));
  await assert.rejects(selectRelayHttpsPort({ serveStatusText: JSON.stringify({ TCP }) }), error => {
    assert.equal(error.code, 'relay_serve_port_unavailable');
    assert.ok(error.remediation);
    return true;
  });
});

test('owned-route reuse follows the shared proxy matcher for a retained URL-only host record', async () => {
  const port = await selectRelayHttpsPort({
    serveStatusText: JSON.stringify({ TCP: { '8443': { HTTPS: true } },
      Web: { 'host.example:8443': { Handlers: { '/': { Proxy: 'http://localhost:3340' } } } } }),
    runtimeState: { irohRelay: { upstreamUrl: 'http://127.0.0.1:3340', httpsUrl: 'https://host.example:8443' } },
  });
  assert.equal(port, 8443);
});

test('malformed listener maps cannot turn an unknown port into a free listener', async () => {
  for (const status of ['[]', '{"TCP":[]}', '{"TCP":{"invalid":{}}}', '{"Foreground":{"session":null}}']) {
    await assert.rejects(selectRelayHttpsPort({ serveStatusText: status }), { code: 'relay_serve_status_unavailable' });
  }
});
