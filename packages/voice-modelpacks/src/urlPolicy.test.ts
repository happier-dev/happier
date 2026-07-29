import { describe, expect, it } from 'vitest';

import {
  assertManifestUrlsAllowed,
  assertModelPackResolvedAddressesAllowed,
  assertModelPackUrlAllowed,
  ModelPackUrlPolicyError,
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

  it('rejects credentials and private/reserved literal destinations', () => {
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
      expect(() => assertModelPackUrlAllowed(`https://${host}/model.onnx`)).toThrow(
        'model_pack_url_private_destination',
      );
    }
    expect(() => assertModelPackUrlAllowed('https://example.com/model.onnx?api_key=secret-value')).toThrow(
      'model_pack_url_credentials_forbidden',
    );
  });

  it('enforces an exact host allowlist (case-insensitive)', () => {
    expect(() => assertModelPackUrlAllowed('https://github.com/x', { allowedHosts: ['GitHub.com'] })).not.toThrow();
    expect(() => assertModelPackUrlAllowed('https://evil.example/x', { allowedHosts: ['github.com'] })).toThrow(
      'model_pack_url_host_not_allowed',
    );
  });

  it('does not allow a subdomain to satisfy an apex-host allowlist', () => {
    expect(() => assertModelPackUrlAllowed('https://evil.github.com.attacker.test/x', { allowedHosts: ['github.com'] })).toThrow(
      ModelPackUrlPolicyError,
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

describe('assertModelPackResolvedAddressesAllowed', () => {
  it('fails closed on private DNS answers and empty answers when required', () => {
    expect(() => assertModelPackResolvedAddressesAllowed(['93.184.216.34'])).not.toThrow();
    expect(() => assertModelPackResolvedAddressesAllowed(['93.184.216.34', '10.0.0.5'])).toThrow(
      'model_pack_url_private_destination',
    );
    expect(() => assertModelPackResolvedAddressesAllowed(['::ffff:127.0.0.1'])).toThrow(
      'model_pack_url_private_destination',
    );
    expect(() => assertModelPackResolvedAddressesAllowed(['not-an-ip'])).toThrow(
      'model_pack_url_invalid_address_evidence',
    );
    expect(() => assertModelPackResolvedAddressesAllowed(['198.51.100.1'])).toThrow(
      'model_pack_url_private_destination',
    );
    expect(() => assertModelPackResolvedAddressesAllowed([], { requireResolvedAddresses: true })).toThrow(
      'model_pack_url_dns_evidence_required',
    );
  });

  it('permits loopback DNS evidence only when the requested URL is itself an explicitly allowed loopback URL', () => {
    expect(() => assertModelPackResolvedAddressesAllowed(['127.0.0.1'], {
      requireResolvedAddresses: true,
      allowInsecureLoopback: true,
      requestUrl: 'http://127.0.0.1:9000/model.bin',
    })).not.toThrow();
    expect(() => assertModelPackResolvedAddressesAllowed(['127.0.0.1'], {
      requireResolvedAddresses: true,
      allowInsecureLoopback: true,
      requestUrl: 'https://models.example/model.bin',
    })).toThrow('model_pack_url_private_destination');
  });
});
