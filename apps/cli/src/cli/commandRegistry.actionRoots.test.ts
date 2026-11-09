import { mkdir, writeFile } from 'node:fs/promises';
import { generateKeyPairSync } from 'node:crypto';
import { dirname } from 'node:path';
import { Readable } from 'node:stream';
import axios, { type AxiosAdapter } from 'axios';
import { describe, expect, it, vi } from 'vitest';

import { configuration, reloadConfiguration } from '@/configuration';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { withTempDir } from '@/testkit/fs/tempDir';
import { captureConsoleJsonOutput, captureStderr } from '@/testkit/logger/captureOutput';

import {
  commandRegistry,
  findCommandDispatchDescriptor,
  resolveCommandDispatchRegistry,
} from './commandRegistry';
import { dispatchCli } from './dispatch';
import { createSavedSecretsCliHttpFixture } from './actions/adapters/savedSecretsCliHttpFixture';

describe('cold Action command roots', () => {
  it('admits Saved Secret commands before loading optional Agent or plugin contributions', () => {
    // Dispatch checks the root before resolving a compiled leaf. Missing it
    // sends a private stdin invocation through unrelated Account plugin I/O.
    expect(findCommandDispatchDescriptor('secrets')).toMatchObject({
      command: 'secrets',
      handler: expect.any(Function),
    });
    expect(commandRegistry.secrets).toBeTypeOf('function');
    expect(resolveCommandDispatchRegistry().findByCommand('secrets')).toMatchObject({
      command: 'secrets',
    });
  });

  it('settles a closed passkey stdin pipe without an unrelated Account plugin request', async () => {
    await withTempDir('happier-secret-cold-dispatch-', async homeDir => {
      const env = createEnvKeyScope(['HAPPIER_HOME_DIR', 'HAPPIER_TOKEN', 'HAPPIER_SESSION_REQUESTER_CREDENTIAL_FILE']);
      const adapter = axios.defaults.adapter;
      // HTTP is the external boundary. Any request is a regression: invalid
      // private input must settle before either plugin discovery or an effect.
      const network = vi.fn<AxiosAdapter>(async () => { throw new Error('offline_fixture_transport'); });
      const exitCode = process.exitCode;
      const output = captureConsoleJsonOutput();
      const stdin = Readable.from([Buffer.from('{"invalid":true}\n')]);
      Object.defineProperty(stdin, 'isTTY', { value: false });
      const stdinSpy = vi.spyOn(process, 'stdin', 'get').mockReturnValue(stdin as typeof process.stdin);
      try {
        env.patch({ HAPPIER_HOME_DIR: homeDir, HAPPIER_TOKEN: undefined, HAPPIER_SESSION_REQUESTER_CREDENTIAL_FILE: undefined });
        reloadConfiguration();
        await mkdir(dirname(configuration.privateKeyFile), { recursive: true });
        await writeFile(configuration.privateKeyFile, JSON.stringify({ token: 'offline-fixture' }), { mode: 0o600 });
        axios.defaults.adapter = network;
        const args = ['secrets', 'create', 'Disposable passkey', '--passkey-format', 'chromium-cdp', '--json'];
        await dispatchCli({ args, rawArgv: ['happier', ...args], terminalRuntime: null });
        expect(output.json()).toMatchObject({ ok: false, error: { code: 'input_invalid' } });
        expect(stdin.readableEnded).toBe(true);
        expect(network).toHaveBeenCalledTimes(0);
      } finally {
        axios.defaults.adapter = adapter;
        stdinSpy.mockRestore();
        output.restore();
        process.exitCode = exitCode;
        env.restore();
        reloadConfiguration();
      }
    });
  });

  it('keeps a valid passkey create on the Saved Secret HTTP path through a typed save refusal', async () => {
    await withTempDir('happier-secret-valid-dispatch-', async homeDir => {
      const fixture = await createSavedSecretsCliHttpFixture({ refuseCreate: true });
      const env = createEnvKeyScope(['HAPPIER_HOME_DIR', 'HAPPIER_TOKEN', 'HAPPIER_SESSION_REQUESTER_CREDENTIAL_FILE']);
      const adapter = axios.defaults.adapter;
      const http = axios.getAdapter(adapter);
      const paths: string[] = [];
      const exitCode = process.exitCode;
      const output = captureConsoleJsonOutput();
      const stderr = captureStderr();
      const privateKey = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey
        .export({ type: 'pkcs8', format: 'der' }).toString('base64');
      const stdin = Readable.from([Buffer.from(JSON.stringify({ credentialId: 'Y3JlZGVudGlhbA==', isResidentCredential: true,
        rpId: 'login.example', privateKey, userHandle: 'dXNlcg==', signCount: 0,
        backupEligibility: false, backupState: false }) + '\n')]);
      Object.defineProperty(stdin, 'isTTY', { value: false });
      const stdinSpy = vi.spyOn(process, 'stdin', 'get').mockReturnValue(stdin as typeof process.stdin);
      try {
        env.patch({ HAPPIER_HOME_DIR: homeDir, HAPPIER_TOKEN: undefined, HAPPIER_SESSION_REQUESTER_CREDENTIAL_FILE: undefined });
        reloadConfiguration();
        const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
        const token = `${encode({ alg: 'none', typ: 'JWT' })}.${encode({ sub: 'account-cli-fixture', session: 'fixture', tokenEpoch: 7,
          provenance: { v: 1, kind: 'terminal', authority: 'account_automation' } })}.signature`;
        await mkdir(dirname(configuration.privateKeyFile), { recursive: true });
        await writeFile(configuration.privateKeyFile, JSON.stringify({ token }), { mode: 0o600 });
        // Record only endpoint paths; the loopback service owns all HTTP replies.
        axios.defaults.adapter = async config => {
          const url = new URL(config.url!, config.baseURL ?? fixture.origin);
          paths.push(url.pathname);
          if (url.origin !== fixture.origin) throw new Error('offline_fixture_origin');
          return await http(config);
        };
        const args = ['secrets', 'create', 'Disposable passkey', '--passkey-format', 'chromium-cdp', '--json'];
        await fixture.inHome(() => dispatchCli({ args, rawArgv: ['happier', ...args], terminalRuntime: null }));
        const result = output.json<{ ok?: boolean; error?: { code?: string } }>();
        expect(result.ok === false && result.error?.code === 'resource_changed').toBe(true);
        expect(stdin.readableEnded).toBe(true);
        expect(paths.includes('/v1/account/saved-secrets/resources')).toBe(true);
        expect(paths.some(path => path.includes('/plugins/'))).toBe(false);
        expect(fixture.writes.length).toBe(0);
        expect((output.logs.join('\n') + stderr.text()).includes(privateKey)).toBe(false);
      } finally {
        axios.defaults.adapter = adapter;
        stdinSpy.mockRestore();
        output.restore();
        stderr.restore();
        process.exitCode = exitCode;
        env.restore();
        reloadConfiguration();
        await fixture.close();
      }
    });
  });
});
