import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const directory = dirname(fileURLToPath(import.meta.url));

function read(name) {
  return readFileSync(resolve(directory, name), 'utf8');
}

describe('self-hosted iroh relay deployment', () => {
  it('ships the holepunch-only profile as the safe default', () => {
    const config = read('relay.toml');

    expect(config).toMatch(/^enable_relay\s*=\s*false\s*(?:#.*)?$/m);
    expect(config).toMatch(/^enable_quic_addr_discovery\s*=\s*true\s*(?:#.*)?$/m);
    expect(config).toMatch(/^quic_bind_addr\s*=\s*"\[::\]:7842"\s*(?:#.*)?$/m);
    expect(config).toMatch(/^cert_mode\s*=\s*"Manual"\s*(?:#.*)?$/m);
    expect(config).toMatch(/^cert_dir\s*=\s*"\/etc\/iroh\/certs"\s*(?:#.*)?$/m);
  });

  it('keeps forwarding opt-in and separate from the default compose service', () => {
    const config = read('relay.toml');
    const compose = read('compose.yaml');
    const readme = read('README.md');

    expect(config).toMatch(/forwarding.*enable_relay\s*=\s*true/is);
    expect(compose).toMatch(/iroh-relay:holepunch-only/);
    expect(compose).not.toMatch(/iroh-relay:forwarding/);
    expect(readme).toMatch(/forwarding mode.*explicit|explicit.*forwarding mode/is);
  });

  it('keeps the deployment stateless and isolated from the Happier server', () => {
    const compose = read('compose.yaml');
    expect(compose).toMatch(/read_only:\s*true/);
    expect(compose).toMatch(/cap_drop:\s*\n\s*-\s*ALL/);
    expect(compose).toMatch(/no-new-privileges:true/);
    expect(compose).toMatch(/tmpfs:/);
    const composeWithoutComments = compose.replace(/^\s*#.*$/gm, '');
    expect(composeWithoutComments).not.toMatch(/database|postgres|redis|server-secret/i);
    const volumeSection = compose.match(/\n\s+volumes:\n(?<body>(?:\s+-.*\n?)+)/)?.groups?.body ?? '';
    expect(volumeSection).toContain('relay.toml');
    expect(volumeSection).toContain('/certs');
    expect(volumeSection).not.toMatch(/database|postgres|redis|server-secret/i);
  });

  it('pins the relay image to the native Iroh release line', () => {
    const dockerfile = read('Dockerfile');
    expect(dockerfile).toMatch(/IROH_RELAY_VERSION=1\.1\.0/);
    expect(dockerfile).toMatch(/FROM\s+ghcr\.io\/n0-computer\/iroh-relay:\$\{IROH_RELAY_VERSION\}/);
    expect(dockerfile).toMatch(/--config.*\/etc\/iroh\/relay\.toml/);
  });
});
