import test from 'node:test';
import assert from 'node:assert/strict';

import { buildTerminalConnectLinks, buildConfigureServerLinks } from '../dist/links/index.js';

test('buildTerminalConnectLinks adds server param to web + mobile links', () => {
  const webappUrl = 'https://app.happier.dev';
  const serverUrl = 'https://stack.example.test';
  const publicKeyB64Url = 'abcDEF_123-zzz';

  const out = buildTerminalConnectLinks({ webappUrl, serverUrl, publicKeyB64Url });
  assert.equal(
    out.webUrl,
    'https://app.happier.dev/terminal/connect#key=abcDEF_123-zzz&server=https%3A%2F%2Fstack.example.test',
  );
  assert.equal(
    out.mobileUrl,
    'happier://terminal?key=abcDEF_123-zzz&server=https%3A%2F%2Fstack.example.test',
  );
});

test('buildConfigureServerLinks encodes server URL', () => {
  const webappUrl = 'https://app.happier.dev';
  const serverUrl = 'https://stack.example.test';

  const out = buildConfigureServerLinks({ webappUrl, serverUrl });
  assert.equal(
    out.webUrl,
    'https://app.happier.dev/server?url=https%3A%2F%2Fstack.example.test&auto=1',
  );
  assert.equal(
    out.mobileUrl,
    'happier://server?url=https%3A%2F%2Fstack.example.test',
  );
});

