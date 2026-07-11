import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  CONNECTED_SERVICE_BROKER_REFRESH_SCOPE_LABEL,
  CONNECTED_SERVICE_BROKER_REFRESH_TOKEN_ENV,
  CONNECTED_SERVICE_BROKER_REFRESH_TOKEN_PATH_ENV,
  digestConnectedServiceBrokerCapability,
  digestConnectedServiceBrokerSelectionIdentity,
  deriveConnectedServiceBrokerRefreshToken,
  isValidConnectedServiceBrokerRefreshToken,
  readConnectedServiceBrokerCapabilityFile,
  removeConnectedServiceBrokerCapabilityFile,
  verifyConnectedServiceBrokerCapabilityFile,
  writeConnectedServiceBrokerCapabilityFile,
} from './capabilityToken.js';

const roots: string[] = [];

async function createRoot(): Promise<string> {
  const root = join(tmpdir(), `happier-broker-capability-${process.pid}-${Math.random().toString(36).slice(2)}`);
  roots.push(root);
  await mkdir(root, { recursive: true });
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('connected-service broker capability token (shared, provider-agnostic)', () => {
  it('derives a deterministic scoped token from the master control token', () => {
    const a = deriveConnectedServiceBrokerRefreshToken('master-control-token');
    const b = deriveConnectedServiceBrokerRefreshToken('master-control-token');
    expect(a).toBe(b);
    expect(a.length).toBeGreaterThan(0);
  });

  it('is NOT equal to the master control token (least privilege — no broker ever gets the master)', () => {
    const master = 'master-control-token';
    const scoped = deriveConnectedServiceBrokerRefreshToken(master);
    expect(scoped).not.toBe(master);
    expect(scoped).not.toContain(master);
  });

  it('produces different tokens for different master secrets', () => {
    expect(deriveConnectedServiceBrokerRefreshToken('token-a')).not.toBe(
      deriveConnectedServiceBrokerRefreshToken('token-b'),
    );
  });

  it('returns empty for an empty/blank master token (fail-closed)', () => {
    expect(deriveConnectedServiceBrokerRefreshToken('')).toBe('');
    expect(deriveConnectedServiceBrokerRefreshToken('   ')).toBe('');
    expect(deriveConnectedServiceBrokerRefreshToken(null)).toBe('');
    expect(deriveConnectedServiceBrokerRefreshToken(undefined)).toBe('');
  });

  it('validates the scoped token against the master and rejects the master itself', () => {
    const master = 'master-control-token';
    const scoped = deriveConnectedServiceBrokerRefreshToken(master);
    expect(isValidConnectedServiceBrokerRefreshToken(scoped, master)).toBe(true);
    expect(isValidConnectedServiceBrokerRefreshToken(master, master)).toBe(false);
    expect(isValidConnectedServiceBrokerRefreshToken(deriveConnectedServiceBrokerRefreshToken('other'), master)).toBe(false);
  });

  it('fails closed on empty/blank inputs', () => {
    const master = 'master-control-token';
    expect(isValidConnectedServiceBrokerRefreshToken('', master)).toBe(false);
    expect(isValidConnectedServiceBrokerRefreshToken(null, master)).toBe(false);
    expect(isValidConnectedServiceBrokerRefreshToken(deriveConnectedServiceBrokerRefreshToken(master), '')).toBe(false);
  });

  it('pins a versioned, provider-agnostic scope label + env name (the SAME token authorizes every broker)', () => {
    // Provider-agnostic so the OpenCode plugin AND the Pi extension derive the SAME scoped token, and a
    // SINGLE bridge preHandler authorizes both. Versioned so a future scope/format change is unambiguous.
    expect(CONNECTED_SERVICE_BROKER_REFRESH_SCOPE_LABEL).toBe('happier:connected-service-broker-refresh:v1');
    expect(CONNECTED_SERVICE_BROKER_REFRESH_TOKEN_ENV).toBe('HAPPIER_CONNECTED_SERVICE_BROKER_REFRESH_TOKEN');
  });

  it('writes a random independent 256-bit per-materialization capability atomically with mode 0600', async () => {
    const rootDir = await createRoot();
    const first = await writeConnectedServiceBrokerCapabilityFile({
      rootDir,
      materializationId: 'mat-1',
      selectionIdentity: 'pi|connected|broker:1|anthropic:p:acct',
    });
    const firstDocument = await readConnectedServiceBrokerCapabilityFile(first.path);

    expect(firstDocument).toMatchObject({
      v: 1,
      materializationId: 'mat-1',
      selectionIdentityDigest: digestConnectedServiceBrokerSelectionIdentity(
        'pi|connected|broker:1|anthropic:p:acct',
      ),
    });
    expect(firstDocument?.capability).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(first.capabilityDigest).toBe(digestConnectedServiceBrokerCapability(firstDocument?.capability));
    expect((await stat(first.path)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(first.path, 'utf8'))).not.toHaveProperty('daemonControlToken');

    const second = await writeConnectedServiceBrokerCapabilityFile({
      rootDir,
      materializationId: 'mat-1',
      selectionIdentity: 'pi|connected|broker:1|anthropic:p:acct',
    });
    const secondDocument = await readConnectedServiceBrokerCapabilityFile(second.path);
    expect(secondDocument?.capability).not.toBe(firstDocument?.capability);
    expect(second.capabilityDigest).not.toBe(first.capabilityDigest);
  });

  it('verifies exact materialization, selection digest, capability digest, file mode, and ownership state', async () => {
    const rootDir = await createRoot();
    const descriptor = await writeConnectedServiceBrokerCapabilityFile({
      rootDir,
      materializationId: 'mat-a',
      selectionIdentity: 'opencode|connected|broker:1|openai:p:acct',
    });

    await expect(verifyConnectedServiceBrokerCapabilityFile({
      path: descriptor.path,
      materializationId: 'mat-a',
      selectionIdentity: 'opencode|connected|broker:1|openai:p:acct',
      capabilityDigest: descriptor.capabilityDigest,
    })).resolves.toEqual(descriptor);
    await expect(verifyConnectedServiceBrokerCapabilityFile({
      path: descriptor.path,
      materializationId: 'victim-mat',
      selectionIdentity: 'opencode|connected|broker:1|openai:p:acct',
      capabilityDigest: descriptor.capabilityDigest,
    })).resolves.toBeNull();
    await expect(verifyConnectedServiceBrokerCapabilityFile({
      path: descriptor.path,
      materializationId: 'mat-a',
      selectionIdentity: 'opencode|connected|broker:1|openai:victim:acct',
      capabilityDigest: descriptor.capabilityDigest,
    })).resolves.toBeNull();

    await writeFile(descriptor.path, JSON.stringify({
      ...(await readConnectedServiceBrokerCapabilityFile(descriptor.path)),
      capability: 'tampered-capability',
    }), { mode: 0o644 });
    await expect(verifyConnectedServiceBrokerCapabilityFile({
      path: descriptor.path,
      materializationId: 'mat-a',
      selectionIdentity: 'opencode|connected|broker:1|openai:p:acct',
      capabilityDigest: descriptor.capabilityDigest,
    })).resolves.toBeNull();
  });

  it('revokes the capability file idempotently', async () => {
    const rootDir = await createRoot();
    const descriptor = await writeConnectedServiceBrokerCapabilityFile({
      rootDir,
      materializationId: 'mat-revoke',
      selectionIdentity: 'pi|connected|broker:1|openai:p:acct',
    });
    await removeConnectedServiceBrokerCapabilityFile(descriptor.path);
    await removeConnectedServiceBrokerCapabilityFile(descriptor.path);
    await expect(readConnectedServiceBrokerCapabilityFile(descriptor.path)).resolves.toBeNull();
  });

  it('pins the file-path-only child contract', () => {
    expect(CONNECTED_SERVICE_BROKER_REFRESH_TOKEN_PATH_ENV)
      .toBe('HAPPIER_CONNECTED_SERVICE_BROKER_REFRESH_TOKEN_PATH');
  });
});
