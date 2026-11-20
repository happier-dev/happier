import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import axios, { type AxiosAdapter } from 'axios';
import { describe, expect, it, vi } from 'vitest';
import { buildConnectedServiceCredentialRecord } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { installPinnedAgyAcpServerFixture } from '@/backends/agy/acp/pinnedAgyAcpServer.testkit';
import { configuration } from '@/configuration';
import { resetInMemoryAccountSettingsContextForTests } from '@/settings/accountSettings/bootstrapAccountSettingsContext';
import { withTempDir } from '@/testkit/fs/tempDir';
import { createEncryptedRpcTestClient } from './encryptedRpc.testkit';
import { registerCapabilitiesHandlers } from './capabilities';
import { verifyExistingAgyAcpManagedBinPath } from '@/capabilities/deps/agyAcp';
import { validateCatalogAcpProbeSpawn } from '@/capabilities/probes/validateCatalogAcpProbeSpawn';

describe('selected AGY discovery process and temporary-state custody', () => {
  it.each([
    ['probeModels', 'success'], ['probeModels', 'failure'], ['probeModels', 'cancel'],
    ['probeModes', 'success'], ['probeModes', 'cancel'],
  ] as const)('isolates %s history and disposes the child before removing credentials: %s', async (method, outcome) => {
    await withTempDir('agy-rpc-auth-', async (cwd) => {
      const overrides = { happyHomeDir: cwd, activeServerDir: cwd, privateKeyFile: join(cwd, 'access.key'), legacyPrivateKeyFile: join(cwd, 'legacy.key'),
        apiServerUrl: 'http://agy-auth-boundary.test', clientEncryptionRequirement: 'follow_account' };
      const descriptors = Object.fromEntries(Object.keys(overrides).map((key) => [key, Object.getOwnPropertyDescriptor(configuration, key)!]));
      Object.defineProperties(configuration, Object.fromEntries(Object.entries(overrides).map(([key, value]) => [key, { value, configurable: true }])));
      const native = join(cwd, 'native');
      await mkdir(join(native, 'antigravity-acp', 'conversations'), { recursive: true });
      await mkdir(join(native, 'antigravity-acp', 'brain'), { recursive: true });
      await mkdir(join(native, 'config', 'skills'), { recursive: true });
      await writeFile(join(native, 'config', 'skills', 'SKILL.md'), 'native skill');
      vi.stubEnv('GEMINI_HOME', native);
      await writeFile(configuration.privateKeyFile, JSON.stringify({ token: 'fixture-token', secret: Buffer.alloc(32, 7).toString('base64') }));
      const record = buildConnectedServiceCredentialRecord({ now: Date.now(), serviceId: 'antigravity', profileId: 'a', kind: 'oauth', expiresAt: null,
        oauth: { accessToken: 'fixture-a-access', refreshToken: 'fixture-a-refresh', idToken: null, scope: null, tokenType: 'Bearer', providerAccountId: 'a', providerEmail: null } });
      const originalAdapter = axios.defaults.adapter;
      const adapter: AxiosAdapter = async (config) => {
        const path = new URL(config.url!).pathname;
        const data = path === '/v2/account/settings' ? { content: { t: 'plain', v: { schemaVersion: 6,
          connectedServicesProviderStateSharingSettingsV1: { v: 1, defaults: { configMode: 'linked', stateMode: 'shared' }, byAgentId: { agy: { configMode: 'isolated', stateMode: 'shared' } } },
        } }, version: 1 }
          : path === '/v1/account/encryption' ? { mode: 'plain', updatedAt: 0 }
          : path === '/v3/connect/antigravity/profiles/a/credential' ? { content: { t: 'plain', v: record }, credentialRevision: 'csr_1123456789ABCDEFGHJKMNPQRS' }
          : path === '/v2/connect/antigravity/profiles' ? { serviceId: 'antigravity', profiles: [] } : null;
        if (!data) throw new Error(`Unexpected HTTP fixture: ${path}`);
        return { config, status: 200, statusText: 'OK', headers: {}, data };
      };
      axios.defaults.adapter = adapter;
      resetInMemoryAccountSettingsContextForTests();
      const observations = join(cwd, 'observations.json');
      const stopped = join(cwd, 'stopped.json');
      // A real child process is the provider boundary; catalog, credential, RPC and filesystem owners remain real.
      const fixture = `#!${process.execPath}\n
        const { mkdirSync, readFileSync, writeFileSync, existsSync } = require('node:fs');
        const { join } = require('node:path');
        const home=process.env.GEMINI_HOME;
        const token=join(home,'antigravity-acp','acp_token.json');
        const send=m=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...m})+'\\n');
        process.on('SIGTERM',()=>{writeFileSync(${JSON.stringify(stopped)},JSON.stringify({tokenPresent:existsSync(token)}));process.exit(0)});
        let buffer='';process.stdin.on('data',chunk=>{buffer+=chunk;const lines=buffer.split('\\n');buffer=lines.pop()||'';for(const line of lines){if(!line.trim())continue;const r=JSON.parse(line);
          if(r.method==='initialize')send({id:r.id,result:{protocolVersion:1,agentCapabilities:{loadSession:true},authMethods:[{id:'oauth-personal',name:'Personal'}]}});
          else if(r.method==='session/new'){
            mkdirSync(join(home,'antigravity-acp','conversations'),{recursive:true});
            mkdirSync(join(home,'antigravity-acp','brain','probe'),{recursive:true});
            writeFileSync(join(home,'antigravity-acp','conversations','probe.db'),'probe');
            writeFileSync(${JSON.stringify(observations)},JSON.stringify({pid:process.pid,home,refresh:JSON.parse(readFileSync(token,'utf8')).refresh_token,inheritedSkill:existsSync(join(home,'config','skills','SKILL.md'))}));
            ${outcome === 'success' ? "send({id:r.id,result:{sessionId:'probe',models:{currentModelId:'fixture-model',availableModels:[{modelId:'fixture-model',name:'Fixture'}]},modes:{currentModeId:'default',availableModes:[{id:'default',name:'Default'}]}}});" : outcome === 'failure' ? "send({id:r.id,error:{code:-32000,message:'fixture auth denied'}});" : ''}
          } else if(r.id!==undefined)send({id:r.id,result:{}});
        }});
      `;
      const { command: executable } = await installPinnedAgyAcpServerFixture(fixture);
      await expect(verifyExistingAgyAcpManagedBinPath()).resolves.toBe(executable);
      const validation = await validateCatalogAcpProbeSpawn('agy', { processEnv: { ...process.env,
        HAPPIER_CONNECTED_SERVICE_SELECTIONS_JSON: JSON.stringify([{ kind: 'profile', serviceId: 'antigravity', profileId: 'a' }]) }, cwd });
      expect(validation, JSON.stringify(validation)).toMatchObject({ ok: true });
      const controller = new AbortController();
      const { manager } = createEncryptedRpcTestClient({ scopePrefix: 'agy-auth-discovery', registerHandlers: registerCapabilitiesHandlers });
      let pending: Promise<unknown> | undefined;
      let earlyResponse: unknown;
      try {
        pending = manager.invokeLocal(RPC_METHODS.CAPABILITIES_INVOKE, { id: 'cli.agy', method, params: { cwd, bypassCache: true,
          connectedServices: { v: 1, bindingsByServiceId: { antigravity: { source: 'connected', selection: 'profile', profileId: 'a' } } } } }, { signal: controller.signal }).then(value => { earlyResponse = value; return value; });
        await vi.waitFor(() => expect(existsSync(observations), JSON.stringify(earlyResponse)).toBe(true), { timeout: 20_000 });
        if (outcome === 'cancel') controller.abort();
        const response = await pending;
        if (outcome === 'success') expect(response).toMatchObject({ ok: true, result: { source: 'dynamic' } });
        if (outcome === 'cancel') expect(response).toMatchObject({ ok: false });
        const observed = JSON.parse(await readFile(observations, 'utf8'));
        expect(observed.refresh).toBe('fixture-a-refresh');
        expect(observed.inheritedSkill).toBe(false);
        expect(() => process.kill(observed.pid, 0)).toThrow();
        expect(JSON.parse(await readFile(stopped, 'utf8'))).toEqual({ tokenPresent: true });
        expect(existsSync(observed.home)).toBe(false);
        expect(await readdir(join(native, 'antigravity-acp', 'conversations'))).toEqual([]);
        expect(await readdir(join(native, 'antigravity-acp', 'brain'))).toEqual([]);
      } finally {
        controller.abort();
        await pending;
        axios.defaults.adapter = originalAdapter;
        vi.unstubAllEnvs();
        resetInMemoryAccountSettingsContextForTests();
        Object.defineProperties(configuration, descriptors);
      }
    });
  }, 30_000);
});
