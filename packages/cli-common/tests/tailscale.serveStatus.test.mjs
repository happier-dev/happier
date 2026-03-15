import test from 'node:test';
import assert from 'node:assert/strict';

import {
  extractTailscaleServeHttpsUrl,
  tailscaleServeHttpsUrlForInternalServerUrlFromStatus,
  tailscaleServeStatusMatchesInternalServerUrl,
} from '../dist/tailscale/index.js';

test('extractTailscaleServeHttpsUrl returns first https URL (no trailing slash)', () => {
  const status = [
    'something',
    'https://my-machine.tailnet.ts.net/',
    '|-- / proxy http://127.0.0.1:53545',
    '',
  ].join('\n');
  assert.equal(extractTailscaleServeHttpsUrl(status), 'https://my-machine.tailnet.ts.net');
});

test('tailscaleServeStatusMatchesInternalServerUrl matches by exact internal URL', () => {
  const status = [
    'https://my-machine.tailnet.ts.net',
    '|-- / proxy http://127.0.0.1:53545',
    '',
  ].join('\n');
  assert.equal(tailscaleServeStatusMatchesInternalServerUrl(status, 'http://127.0.0.1:53545'), true);
});

test('tailscaleServeHttpsUrlForInternalServerUrlFromStatus returns null when status does not match port', () => {
  const status = [
    'https://my-machine.tailnet.ts.net',
    '|-- / proxy http://127.0.0.1:53545',
    '',
  ].join('\n');
  assert.equal(
    tailscaleServeHttpsUrlForInternalServerUrlFromStatus(status, 'http://127.0.0.1:9999'),
    null,
  );
});

