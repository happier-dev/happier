import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import type { ConnectedAccountAuthenticationContext, ConnectedAccountReadContext, ConnectedAccountCredentialStore } from '@happier-dev/plugin-sdk/connected-accounts';
import { describe, expect, it } from 'vitest';
import { PLUGIN_MANIFEST } from './manifest.js';
import { activate } from './activate.js';

describe('CodeRabbit vendor-owned manual login and selected native home', () => {
  it.each([true, false, 'tool-unavailable'] as const)('settles only a vendor-verified login (%s), keeping auth in existing custody', async authenticated => {
    const kit = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate } });
    try {
      const runtime = kit.registration('connectedAccountDescriptors', 'coderabbit-account');
      expect(runtime, 'CodeRabbit connected-account runtime').toBeDefined();
      if (!runtime) throw new Error('Missing CodeRabbit account');
      const mode = runtime.authentication.modes['native-login'];
      if (mode?.kind !== 'manual') throw new Error('Expected vendor-run manual login');
      const values = new Map<string, string>();
      const credentials: ConnectedAccountCredentialStore = {
        async get(key) { return values.get(key) ?? null; },
        async set(key, value) { values.set(key, value); },
        async delete(key) { values.delete(key); },
      };
      // Only the native process boundary is substituted; files and serialization stay real.
      const opaqueAuth = '{"fixtureVendorToken":"synthetic-private-token"}\n';
      let acquisitionHome = '';
      const launches: { args?: readonly string[]; env?: Readonly<Record<string, string>> }[] = [];
      const context = {
        signal: new AbortController().signal, attemptCredentials: credentials, credentials,
        services: { exec: { async run(request: { args?: readonly string[]; env?: Readonly<Record<string, string>> }) {
          launches.push(request);
          acquisitionHome = request.env?.HOME ?? '';
          expect(acquisitionHome).toBeTruthy();
          expect(request.env?.CODERABBIT_API_KEY).toBe('');
          if (authenticated === 'tool-unavailable') return {
            termination: { observed: { kind: 'failed', diagnostic: { code: 'system_tool_unavailable', severity: 'error', message: 'Fixture tool is unavailable.' } }, requestedBy: { kind: 'none' } },
            stdout: new Uint8Array(), stderr: new Uint8Array(), stdoutTruncated: false, stderrTruncated: false,
          };
          if (request.args?.includes('login')) {
            await mkdir(join(acquisitionHome, '.coderabbit'), { recursive: true });
            await writeFile(join(acquisitionHome, '.coderabbit/auth.json'), opaqueAuth, { mode: 0o600 });
          }
          return { termination: { observed: { kind: 'exit', exitCode: 0 }, requestedBy: { kind: 'none' } },
            stdout: new TextEncoder().encode(JSON.stringify({ type: 'status', phase: 'auth', authenticated })),
            stderr: new Uint8Array(), stdoutTruncated: false, stderrTruncated: false };
        } } },
      } as unknown as ConnectedAccountAuthenticationContext & ConnectedAccountReadContext;
      const result = await mode.complete({ fields: { region: 'us' } }, context);
      expect(result.status).toBe(authenticated === true ? 'connected' : 'unavailable');
      expect(launches[0]?.args).toEqual(['auth', 'login', '--agent', '--region', 'us']);
      await expect(readFile(join(acquisitionHome, '.coderabbit/auth.json'))).rejects.toMatchObject({ code: 'ENOENT' });
      if (authenticated === 'tool-unavailable') expect(result).toMatchObject({ diagnostic: { code: 'system_tool_unavailable' } });
      if (authenticated !== true) { expect(values.size).toBe(0); return; }
      const material = await runtime.materialize({ kind: 'files', fileIds: ['.coderabbit/auth.json'] }, context);
      expect(material.kind).toBe('files');
      if (material.kind !== 'files') throw new Error('Missing native files');
      expect(new TextDecoder().decode(material.files['.coderabbit/auth.json'])).toBe(opaqueAuth);
      const refreshedAuth = new TextEncoder().encode('{"fixtureVendorToken":"refreshed-private-token"}\n');
      const reused = await runtime.materialize({ kind: 'files', fileIds: ['.coderabbit/auth.json'] }, context,
        { existingFiles: { '.coderabbit/auth.json': refreshedAuth } });
      // The delivered (refreshed) login text is named for the Session transcript, beside the stored one.
      expect(reused).toEqual({ kind: 'files', files: { '.coderabbit/auth.json': refreshedAuth },
        secretValues: [opaqueAuth, new TextDecoder().decode(refreshedAuth)] });
      await expect(runtime.materialize({ kind: 'environment', keys: ['CODERABBIT_API_KEY'] }, context)).rejects.toMatchObject({ code: 'plugin_connected_account_materialization_unsupported' });
      expect(result).not.toHaveProperty('providerIdentity');
    } finally { await kit.dispose(); }
  });
});
