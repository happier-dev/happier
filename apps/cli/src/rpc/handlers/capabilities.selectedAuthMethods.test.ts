import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import axios, { type AxiosAdapter } from 'axios';
import { describe, expect, it, vi } from 'vitest';
import { buildConnectedServiceCredentialRecord } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { configuration } from '@/configuration';
import { resetInMemoryAccountSettingsContextForTests } from '@/settings/accountSettings/bootstrapAccountSettingsContext';
import { withTempDir } from '@/testkit/fs/tempDir';
import { createEncryptedRpcTestClient } from './encryptedRpc.testkit';
import { registerCapabilitiesHandlers } from './capabilities';
import { createGeminiBackend } from '@/backends/gemini/acp/backend';

describe('selected-account discovery admission by method', () => {
  it.each([
    ['claude', 'probeModels'], ['gemini', 'probeModels'],
    ['claude', 'probeModes'], ['claude', 'probeConfigOptions'],
    ['gemini', 'runtime'], ['gemini', 'native-runtime'],
  ] as const)('uses the selected %s account policy for %s at its real discovery boundary', async (agentId, method) => {
    await withTempDir('selected-probe-method-', async (cwd) => {
      const overrides = { happyHomeDir: cwd, activeServerDir: cwd, privateKeyFile: join(cwd, 'access.key'), legacyPrivateKeyFile: join(cwd, 'legacy.key'),
        apiServerUrl: 'http://selected-probe.test', clientEncryptionRequirement: 'follow_account' };
      const descriptors = Object.fromEntries(Object.keys(overrides).map((key) => [key, Object.getOwnPropertyDescriptor(configuration, key)!]));
      Object.defineProperties(configuration, Object.fromEntries(Object.entries(overrides).map(([key, value]) => [key, { value, configurable: true }])));
      await writeFile(configuration.privateKeyFile, JSON.stringify({ token: 'fixture-token', secret: Buffer.alloc(32, 7).toString('base64') }));
      const serviceId = agentId === 'claude' ? 'claude-subscription' : 'gemini';
      const record = buildConnectedServiceCredentialRecord({ now: Date.now(), serviceId, profileId: 'selected', kind: 'oauth', expiresAt: null,
        oauth: { accessToken: 'selected-access', refreshToken: 'selected-refresh', idToken: null, scope: null, tokenType: 'Bearer', providerAccountId: 'selected', providerEmail: null } });
      const originalAdapter = axios.defaults.adapter;
      const adapter: AxiosAdapter = async (config) => {
        const path = new URL(config.url!).pathname;
        const data = path === '/v2/account/settings' ? { content: { t: 'plain', v: { schemaVersion: 6 } }, version: 1 }
          : path === '/v1/account/encryption' ? { mode: 'plain', updatedAt: 0 }
          : path === `/v3/connect/${serviceId}/profiles/selected/credential` ? { content: { t: 'plain', v: record }, credentialRevision: 'csr_1123456789ABCDEFGHJKMNPQRS' }
          : path === `/v2/connect/${serviceId}/profiles` ? { serviceId, profiles: [{ profileId: 'selected', status: 'connected' }] } : null;
        if (!data) throw new Error(`Unexpected HTTP fixture: ${path}`);
        return { config, status: 200, statusText: 'OK', headers: {}, data };
      };
      axios.defaults.adapter = adapter;
      resetInMemoryAccountSettingsContextForTests();
      const observations = join(cwd, 'observations.json');
      const executable = join(cwd, 'provider');
      // Only HTTP and the provider executable are boundaries; RPC, catalogs and credential owners are real.
      await writeFile(executable, `#!${process.execPath}\n
        const {readFileSync,writeFileSync}=require('node:fs');const {join}=require('node:path');
        writeFileSync(${JSON.stringify(observations)},'{}');
        if(process.argv.includes('--version')){console.log('0.30.0');process.exit(0)}
        if(process.argv.includes('--help')){console.log('--acp');process.exit(0)}
        const send=m=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...m})+'\\n');
        let buffer='',authMethod;process.stdin.on('data',chunk=>{buffer+=chunk;const lines=buffer.split('\\n');buffer=lines.pop()||'';for(const line of lines){if(!line.trim())continue;const r=JSON.parse(line);
          if(r.method==='initialize')send({id:r.id,result:{protocolVersion:1,agentCapabilities:{},authMethods:[{id:'oauth-personal',name:'Personal'},{id:'gemini-api-key',name:'API key'},{id:'vertex-ai',name:'Vertex'},{id:'gateway',name:'Gateway'}]}});
          else if(r.method==='authenticate'){authMethod=r.params.methodId;send({id:r.id,result:{}})}
          else if(r.method==='session/new'){
            const home=process.env.GEMINI_CLI_HOME;
            writeFileSync(${JSON.stringify(observations)},JSON.stringify({home,authMethod,apiKey:process.env.GEMINI_API_KEY,token:JSON.parse(readFileSync(join(home,'.gemini','oauth_creds.json'),'utf8')).access_token}));
            send({id:r.id,result:{sessionId:'probe',models:{currentModelId:'selected-model',availableModels:[{modelId:'selected-model',name:'Selected'}]}}});
          }else if(r.id!==undefined)send({id:r.id,result:{}});
        }});
      `);
      await chmod(executable, 0o755);
      vi.stubEnv(agentId === 'claude' ? 'HAPPIER_CLAUDE_PATH' : 'HAPPIER_GEMINI_PATH', executable);
      vi.stubEnv('ANTHROPIC_AUTH_TOKEN', 'ambient-wrong-account');
      vi.stubEnv('GEMINI_API_KEY', 'ambient-wrong-account');
      const requests: string[] = [];
      vi.stubGlobal('fetch', async (_input: unknown, init: RequestInit) => {
        requests.push(new Headers(init.headers).get('authorization') ?? '');
        return new Response(JSON.stringify({ data: [{ id: 'selected-model', display_name: 'Selected' }] }), { status: 200 });
      });
      try {
        if (method === 'runtime' || method === 'native-runtime') {
          const home = join(cwd, 'runtime-home');
          await mkdir(join(home, '.gemini'), { recursive: true });
          await writeFile(join(home, '.gemini', 'oauth_creds.json'), JSON.stringify({ access_token: 'selected-access' }));
          const selected = method === 'runtime';
          if (selected) {
            vi.stubEnv('GOOGLE_GENAI_USE_VERTEXAI', '1');
            vi.stubEnv('HAPPIER_GEMINI_ACP_AUTH_METHOD', 'gateway');
          }
          const { backend } = createGeminiBackend({ cwd, env: { HOME: home, GEMINI_CLI_HOME: home,
            ...(selected ? { HAPPIER_CONNECTED_SERVICE_SELECTIONS_JSON: JSON.stringify([{ kind: 'profile', serviceId: 'gemini', profileId: 'selected', credentialRevision: 'csr_1123456789ABCDEFGHJKMNPQRS' }]) } : {}) },
            ...(selected ? {} : { apiKey: 'native-explicit-key' }), model: null });
          try {
            await backend.startSession();
            const observed = JSON.parse(await readFile(observations, 'utf8'));
            expect(observed.authMethod).toBe(selected ? 'oauth-personal' : 'gemini-api-key');
            expect(observed.apiKey || null).toBe(selected ? null : 'native-explicit-key');
            expect(observed.token).toBe('selected-access');
          } finally { await backend.dispose(); }
          return;
        }
        const { manager } = createEncryptedRpcTestClient({ scopePrefix: 'selected-method', registerHandlers: registerCapabilitiesHandlers });
        const response = await manager.invokeLocal(RPC_METHODS.CAPABILITIES_INVOKE, { id: `cli.${agentId}`, method, params: { cwd, bypassCache: true,
          connectedServices: { v: 1, bindingsByServiceId: { [serviceId]: { source: 'connected', selection: 'profile', profileId: 'selected' } } } } });
        if (method !== 'probeModels') {
          expect(response, JSON.stringify(response)).toMatchObject({ ok: true, result: { source: 'static' } });
          expect(requests).toEqual([]);
          expect(existsSync(observations)).toBe(false);
        } else if (agentId === 'claude') {
          expect(response, JSON.stringify(response)).toMatchObject({ ok: true, result: { source: 'dynamic', availableModels: expect.arrayContaining([{ id: 'selected-model', name: 'Selected' }]) } });
          expect(requests).toEqual(['Bearer selected-access']);
        }
        else {
          expect(response, JSON.stringify(response)).toMatchObject({ ok: true, result: { source: 'dynamic', availableModels: expect.arrayContaining([{ id: 'selected-model', name: 'Selected' }]) } });
          const observed = JSON.parse(await readFile(observations, 'utf8'));
          expect(observed.token).toBe('selected-access');
          expect(observed.authMethod).toBe('oauth-personal');
          expect(observed.apiKey || null).toBeNull();
          expect(existsSync(observed.home)).toBe(false);
        }
      } finally {
        axios.defaults.adapter = originalAdapter;
        vi.unstubAllEnvs();
        vi.unstubAllGlobals();
        resetInMemoryAccountSettingsContextForTests();
        Object.defineProperties(configuration, descriptors);
      }
    });
  }, 30_000);
});
