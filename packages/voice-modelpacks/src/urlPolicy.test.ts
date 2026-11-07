import { describe, expect, it } from 'vitest';

import {
  assertManifestUrlsAllowed,
  assertModelPackUrlAllowed,
} from './urlPolicy.js';

describe('assertModelPackUrlAllowed', () => {
  it('accepts an https URL when no allowlist is set', () => {
    const url = assertModelPackUrlAllowed('https://example.com/model.onnx');
    expect(url.hostname).toBe('example.com');
  });

  it('rejects http (insecure) URLs', () => {
    expect(() => assertModelPackUrlAllowed('http://example.com/model.onnx')).toThrow('model_pack_url_insecure_scheme');
  });

  it('rejects non-http schemes', () => {
    expect(() => assertModelPackUrlAllowed('file:///etc/passwd')).toThrow('model_pack_url_insecure_scheme');
    expect(() => assertModelPackUrlAllowed('data:text/plain,hi')).toThrow('model_pack_url_insecure_scheme');
  });

  it('rejects malformed URLs', () => {
    expect(() => assertModelPackUrlAllowed('not a url')).toThrow('model_pack_url_invalid');
  });

  it('rejects configured credentials while allowing HTTPS LAN and reserved mirror destinations', () => {
    expect(() => assertModelPackUrlAllowed('https://user:pass@example.com/model.onnx')).toThrow(
      'model_pack_url_credentials_forbidden',
    );
    for (const host of [
      '10.0.0.1',
      '169.254.169.254',
      '192.168.1.2',
      '127.0.0.1',
      '198.51.100.1',
      '203.0.113.1',
      '[::1]',
      '[fc00::1]',
      '[fe80::1]',
      '[2001:db8::1]',
    ]) {
      expect(() => assertModelPackUrlAllowed(`https://${host}/model.onnx`)).not.toThrow();
    }
    expect(() => assertModelPackUrlAllowed('https://example.com/model.onnx?api_key=secret-value')).toThrow(
      'model_pack_url_credentials_forbidden',
    );
  });

  it('permits http only for loopback hosts when allowInsecureLoopback is set', () => {
    expect(() => assertModelPackUrlAllowed('http://127.0.0.1:8080/x', { allowInsecureLoopback: true })).not.toThrow();
    expect(() => assertModelPackUrlAllowed('http://localhost/x', { allowInsecureLoopback: true })).not.toThrow();
    // Non-loopback http is still refused even with the flag.
    expect(() => assertModelPackUrlAllowed('http://example.com/x', { allowInsecureLoopback: true })).toThrow(
      'model_pack_url_insecure_scheme',
    );
    // Without the flag, loopback http is refused.
    expect(() => assertModelPackUrlAllowed('http://127.0.0.1/x')).toThrow('model_pack_url_insecure_scheme');
  });

  it('validates every manifest file URL', () => {
    expect(() =>
      assertManifestUrlsAllowed({ files: [{ url: 'https://ok.example/a' }, { url: 'http://bad.example/b' }] }),
    ).toThrow('model_pack_url_insecure_scheme');
  });
});
