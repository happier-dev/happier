import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { reloadConfiguration, configuration } from '@/configuration';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { withTempDir } from '@/testkit/fs/tempDir';

const SYNTHETIC_API_TOKEN = 'hap_v1_11111111-1111-4111-8111-111111111111_' + 'A'.repeat(43);

const envKeys = [
  'HAPPIER_HOME_DIR',
  'HAPPIER_TOKEN',
  'HAPPIER_ACTIVE_SERVER_ID',
  'HAPPIER_SERVER_URL',
  'HAPPIER_LOCAL_SERVER_URL',
  'HAPPIER_PUBLIC_SERVER_URL',
  'HAPPIER_WEBAPP_URL',
  'HAPPIER_SESSION_REQUESTER_CREDENTIAL_FILE',
  'HAPPIER_SESSION_REQUESTER_SESSION_ID',
] as const;

let envScope = createEnvKeyScope(envKeys);

afterEach(() => {
  envScope.restore();
  envScope = createEnvKeyScope(envKeys);
  reloadConfiguration();
  vi.restoreAllMocks();
});

async function writeStoredToken(token: string): Promise<string> {
  await mkdir(dirname(configuration.privateKeyFile), { recursive: true });
  const serialized = JSON.stringify({ token }, null, 2);
  await writeFile(configuration.privateKeyFile, serialized, 'utf8');
  return serialized;
}

describe('readStoredCredentials API Token selection', () => {
  it('invalidates the pre-provenance account shape but retains the legacy terminal session shape', async () => {
    await withTempDir('happier-cli-legacy-relogin-', async (homeDir) => {
      envScope.patch({ HAPPIER_HOME_DIR: homeDir, HAPPIER_TOKEN: undefined, HAPPIER_ACTIVE_SERVER_ID: undefined });
      reloadConfiguration();
      const { readStoredCredentials } = await import('./persistence');
      // Exact immutable server-v0.2.11 golden bearer, raw session claim (not extras.session).
      const releasedTerminal = 'eyJhbGciOiJFZERTQSJ9.eyJzdWIiOiJyZWxlYXNlZC10ZXJtaW5hbC1hdXRoLW5vLWVwb2NoIiwic2Vzc2lvbiI6InRlcm1pbmFsLWF1dGgtcmVxdWVzdC1yZWxlYXNlZC0wLjIuMTEiLCJpYXQiOjE3ODkxOTU1MDEsIm5iZiI6MTc4OTE5NTUwMSwiaXNzIjoiaGFuZHkiLCJqdGkiOiJlM2QyZTFiOC04NGI0LTQxOWEtODVjMS1kZGYwMTIwMmE1ZWEifQ.jL7qNonZslnbKL-fpL3fLvpbp5H8HER8TLoN3sGkrCqPoGqaN1MPArOsP_Fi2EqUDObB4PgkE3FUo_BWrWpCBw';
      const releasedBytes = await writeStoredToken(releasedTerminal);
      await expect(readStoredCredentials()).resolves.toMatchObject({ token: releasedTerminal });
      await expect(readFile(configuration.privateKeyFile, 'utf8')).resolves.toBe(releasedBytes);
      // Released JWT extras: no session is account; a nonblank session is terminal.
      const bearer = (extras: object) => `hdr.${Buffer.from(JSON.stringify({ sub: 'account-a', extras })).toString('base64url')}.sig`;
      await writeStoredToken(bearer({ session: 'terminal-session' }));
      await expect(readStoredCredentials()).resolves.toMatchObject({ token: bearer({ session: 'terminal-session' }) });
      await writeStoredToken(bearer({}));
      await expect(readStoredCredentials()).rejects.toMatchObject({ code: 'cli_relogin_required' });
      expect(JSON.parse(await readFile(configuration.privateKeyFile, 'utf8'))).toEqual({});
    });
  });
  it('reports an unreadable stored credential file instead of reading it silently as signed out', async () => {
    await withTempDir('happier-cli-corrupt-credential-', async (homeDir) => {
      envScope.patch({ HAPPIER_HOME_DIR: homeDir, HAPPIER_TOKEN: undefined, HAPPIER_ACTIVE_SERVER_ID: undefined });
      reloadConfiguration();
      const { logger } = await import('@/ui/logger');
      const warn = vi.spyOn(logger, 'warnLocalFile').mockImplementation(() => {});
      const { readStoredCredentials } = await import('./persistence');
      await mkdir(dirname(configuration.privateKeyFile), { recursive: true });
      await writeFile(configuration.privateKeyFile, '{"token": "hdr.secret-bearer', 'utf8');
      await expect(readStoredCredentials()).resolves.toBeNull();
      expect(warn.mock.calls.length).toBe(1);
      expect(JSON.stringify(warn.mock.calls)).not.toContain('secret-bearer');
      await writeFile(configuration.privateKeyFile, JSON.stringify({ secret: 7 }), 'utf8');
      await expect(readStoredCredentials()).resolves.toBeNull();
      expect(warn.mock.calls.length).toBe(2);
    });
  });
  it('invalidates an account bearer while preserving encryption material and other profile state', async () => {
    await withTempDir('happier-cli-relogin-', async (homeDir) => {
      envScope.patch({ HAPPIER_HOME_DIR: homeDir, HAPPIER_TOKEN: undefined, HAPPIER_ACTIVE_SERVER_ID: undefined });
      reloadConfiguration();
      const payload = Buffer.from(JSON.stringify({ sub: 'account-a', provenance: {
        v: 1, kind: 'account', authority: 'present_user',
      } })).toString('base64url');
      await mkdir(dirname(configuration.privateKeyFile), { recursive: true });
      const material = { secret: Buffer.alloc(32, 7).toString('base64') };
      await writeFile(configuration.privateKeyFile, JSON.stringify({ ...material, token: `hdr.${payload}.sig` }));
      const otherProfilePath = join(configuration.serversDir, 'other-profile', 'access.key');
      await mkdir(dirname(otherProfilePath), { recursive: true });
      const otherProfileCredential = JSON.stringify({ token: `hdr.${payload}.sig` });
      await writeFile(otherProfilePath, otherProfileCredential);
      const { readStoredCredentials, readStoredCredentialsForServerId } = await import('./persistence');
      // Doctor's inactive-profile inspection is read-only, not an invocation using that bearer.
      await expect(readStoredCredentialsForServerId('other-profile')).resolves.toMatchObject({ token: `hdr.${payload}.sig` });
      await expect(readFile(otherProfilePath, 'utf8')).resolves.toBe(otherProfileCredential);
      await expect(readStoredCredentials()).rejects.toMatchObject({ code: 'cli_relogin_required' });
      expect(JSON.parse(await readFile(configuration.privateKeyFile, 'utf8'))).toEqual(material);
      await expect(readStoredCredentials()).resolves.toBeNull();
    });
  });

  it('uses HAPPIER_TOKEN for this invocation without rewriting the stored credential', async () => {
    await withTempDir('happier-cli-api-token-', async (homeDir) => {
      envScope.patch({
        HAPPIER_HOME_DIR: homeDir,
        HAPPIER_TOKEN: SYNTHETIC_API_TOKEN,
        HAPPIER_ACTIVE_SERVER_ID: undefined,
        HAPPIER_SERVER_URL: undefined,
        HAPPIER_LOCAL_SERVER_URL: undefined,
        HAPPIER_PUBLIC_SERVER_URL: undefined,
        HAPPIER_WEBAPP_URL: undefined,
      });
      reloadConfiguration();
      const stored = await writeStoredToken('stored-session-bearer');

      const { readStoredCredentials } = await import('./persistence');

      await expect(readStoredCredentials()).resolves.toEqual({
        token: SYNTHETIC_API_TOKEN,
        encryption: null,
        credentialProvenance: 'api_token',
      });
      await expect(readFile(configuration.privateKeyFile, 'utf8')).resolves.toBe(stored);
    });
  });

  it('keeps the saved bearer credential when no API Token is supplied', async () => {
    await withTempDir('happier-cli-api-token-', async (homeDir) => {
      envScope.patch({
        HAPPIER_HOME_DIR: homeDir,
        HAPPIER_TOKEN: undefined,
        HAPPIER_ACTIVE_SERVER_ID: undefined,
        HAPPIER_SERVER_URL: undefined,
        HAPPIER_LOCAL_SERVER_URL: undefined,
        HAPPIER_PUBLIC_SERVER_URL: undefined,
        HAPPIER_WEBAPP_URL: undefined,
      });
      reloadConfiguration();
      await writeStoredToken('stored-session-bearer');

      const { readStoredCredentials } = await import('./persistence');

      await expect(readStoredCredentials()).resolves.toEqual({
        token: 'stored-session-bearer',
        encryption: null,
        credentialProvenance: 'stored_session',
      });
    });
  });

  it('selects a finite invocation Home without changing global selection or weakening credential refusal', async () => {
    await withTempDir('happier-cli-selected-credentials-', async homeDir => {
      envScope.patch({ HAPPIER_HOME_DIR: homeDir, HAPPIER_TOKEN: undefined,
        HAPPIER_ACTIVE_SERVER_ID: undefined, HAPPIER_SERVER_URL: 'https://current.example.test',
        HAPPIER_LOCAL_SERVER_URL: undefined, HAPPIER_PUBLIC_SERVER_URL: undefined, HAPPIER_WEBAPP_URL: undefined,
        HAPPIER_SESSION_REQUESTER_CREDENTIAL_FILE: undefined, HAPPIER_SESSION_REQUESTER_SESSION_ID: undefined });
      reloadConfiguration();
      const currentBytes = await writeStoredToken('current-fixture-bearer');
      const selectedPath = join(configuration.serversDir, 'selected-home', 'access.key');
      await mkdir(dirname(selectedPath), { recursive: true });
      await writeFile(selectedPath, JSON.stringify({ token: 'selected-fixture-bearer' }));
      const originalConfiguration = configuration;
      const { readStoredCredentials } = await import('./persistence');
      await expect(readStoredCredentials({ serverId: configuration.activeServerId })).resolves.toMatchObject({ token: 'current-fixture-bearer' });
      await expect(readStoredCredentials({ serverId: '../outside-home' })).resolves.toBeNull();
      await expect(readStoredCredentials({ serverId: 'selected-home' })).resolves.toMatchObject({ token: 'selected-fixture-bearer' });
      await expect(readStoredCredentials({ serverId: 'missing-home' })).resolves.toBeNull();
      envScope.patch({ HAPPIER_TOKEN: SYNTHETIC_API_TOKEN });
      await expect(readStoredCredentials({ serverId: 'selected-home' })).resolves.toMatchObject({ token: SYNTHETIC_API_TOKEN, credentialProvenance: 'api_token' });
      envScope.patch({ HAPPIER_TOKEN: undefined });
      const payload = Buffer.from(JSON.stringify({ sub: 'account-a', provenance: {
        v: 1, kind: 'account', authority: 'present_user',
      } })).toString('base64url');
      const material = { secret: Buffer.alloc(32, 7).toString('base64') };
      await writeFile(selectedPath, JSON.stringify({ ...material, token: `hdr.${payload}.sig` }));
      await expect(readStoredCredentials({ serverId: 'selected-home' })).rejects.toMatchObject({ code: 'cli_relogin_required' });
      expect(JSON.parse(await readFile(selectedPath, 'utf8'))).toEqual(material);
      await expect(readFile(configuration.privateKeyFile, 'utf8')).resolves.toBe(currentBytes);
      expect(configuration).toBe(originalConfiguration);
    });
  });

});
