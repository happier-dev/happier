import { lstat, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ConnectedAccountRuntime } from '@happier-dev/plugin-sdk/connected-accounts';
import type { AgentExecutionRunEvent, AgentExecutionRunRuntimeContextV1, AgentSessionRuntimeContext, AgentSessionRuntimeEvent } from '@happier-dev/plugin-sdk/agents/runtime';
import { KIMI_CONNECTED_ACCOUNT_SERVICE } from '@happier-dev/plugins-kimi/connected-account-service';
import { GROK_CONNECTED_ACCOUNT_SERVICE } from '@happier-dev/plugins-grok/connected-account-service';
import { MUSE_ACCOUNT_SERVICE } from '@happier-dev/plugins-muse/connected-account-service';
import { GEMINI_CONNECTED_ACCOUNT_SERVICE } from '@happier-dev/plugins-gemini/connected-account-service';
import { GITHUB_CONNECTED_ACCOUNT_SERVICE } from '@happier-dev/plugins-scm-github/connected-account-service';

import { createOhMyPiAgentRuntime } from '../../../../../../packages/plugins/ohmypi/src/agent/runtime/engine';
import { geminiConnectedAccountRuntime } from '../../../../../../packages/plugins/gemini/src/connectedAccounts/runtime';
import { createKimiConnectedAccountRuntime } from '../../../../../../packages/plugins/kimi/src/connectedAccounts/runtime';
import { createXaiConnectedAccountRuntime } from '../../../../../../packages/plugins/grok/src/connectedAccounts/runtime';
import { museConnectedAccountRuntime } from '../../../../../../packages/plugins/muse/src/connectedAccounts/museAccountRuntime';
import { githubAccountCredentialRuntime } from '../../../../../../packages/plugins/scm-github/src/auth/credentialMaterialization';
import { createForegroundPurposeOwnerFixture } from '@/daemon/agentRuntime/prepareForegroundAdmission.connectedServices.testkit';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { createUnavailablePluginServices } from '@/plugins/runtime/invocation/services/unavailable';
import { createNativeAgentSessionPublications } from '@/agent/runtime/registry/engineRegistry/nativeAgentSessionPublications';
import { createPublicAcpExecutionRun, createPublicAcpSession, type PublicAcpComposerDependencies } from '@/agent/acp/runtime/publicSession/createPublicAcpSession';
import { writeAcpTestAgentScript } from '@/agent/acp/testkit/subprocessHarness';
import { buildScopedProcessEnv } from '@/utils/processEnv/buildScopedProcessEnv';
import { resolveQualifiedPurposeBindingSnapshotForAgentSpawn, resolveQualifiedPurposeDeclarationSnapshotForAgentSpawn } from '../requestAuth/prepareConnectedAccountRequestAuthForSpawn';
import { materializeConnectedServicesForSpawn } from './materializeConnectedServicesForSpawn';

describe('Oh My Pi selected Gemini service-account native delivery', () => {
  it('delivers private ADC bytes and Vertex project/location to native Sessions and finite Runs over ambient key auth', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ohmypi-service-account-'));
    const fixture = await createAdmittedPluginRuntimeFixture({ controller: pluginReloadController,
      runtimeOptions: { pluginIds: ['happier.agent.ohmypi'] } }).catch(async error => {
      await rm(root, { recursive: true, force: true }); throw error;
    });
    const lifetime = new AbortController();
    const service = GEMINI_CONNECTED_ACCOUNT_SERVICE;
    const account = { service, accountId: '123456789' };
    const serializedCredential = JSON.stringify({ type: 'service_account', client_id: account.accountId,
      client_email: 'fixture@selected-project.iam.gserviceaccount.com', project_id: 'selected-project',
      private_key: 'FAKE_PRIVATE_KEY_FOR_NATIVE_BOUNDARY_TEST' });
    const declaration = resolveQualifiedPurposeDeclarationSnapshotForAgentSpawn({ agentId: 'ohMyPi', contributions: fixture.registry.contributes });
    if (!declaration) throw new Error('Oh My Pi launch declaration unavailable');
    const purpose = declaration.purposes.find(value => value.purpose === 'gemini');
    if (!purpose) throw new Error('Oh My Pi Gemini purpose unavailable');
    const selected = createForegroundPurposeOwnerFixture({ consumer: purpose.consumer, purpose: purpose.purpose, service, accountId: account.accountId,
      materializeAccount: async ({ request, existingFiles, signal }) => {
        // Credential storage is the boundary; the service codec and purpose owner stay real.
        const context: Parameters<ConnectedAccountRuntime['materialize']>[1] = {
          account, plugin: { id: service.pluginId, version: '0.0.0' },
          contribution: { id: service.localId, qualifiedId: `${service.pluginId}/${service.localId}` },
          surface: 'background', invokedAtMs: 0, signal, services: createUnavailablePluginServices(),
          credentials: { async get(key) { return key === 'serviceAccountJson' ? serializedCredential : null; } },
          configuration: { target: { kind: 'account', account, modeId: 'service-account' }, revision: 'fixture-1', values: {}, async getSecret() { return null; } },
        };
        return await geminiConnectedAccountRuntime.materialize(request, context, { existingFiles, signal });
      } });
    const lease = selected.owner.activateSessionPurposeBindings({ sessionId: 'omp-adc', purposes: declaration.purposes, bindings: [selected.binding] });
    let materialized: Awaited<ReturnType<typeof materializeConnectedServicesForSpawn>> = null;
    try {
      const baseEnv = { HOME: root, USERPROFILE: root, GEMINI_API_KEY: 'fake-ambient-gemini-key',
        GOOGLE_APPLICATION_CREDENTIALS: join(root, 'ambient-adc.json'), GOOGLE_CLOUD_PROJECT: 'ambient-project', GOOGLE_CLOUD_LOCATION: 'ambient-location' };
      materialized = await materializeConnectedServicesForSpawn({ agentId: 'ohMyPi', materializationKey: 'omp-adc',
        purposeBindingSessionId: 'omp-adc', activeServerDir: join(root, 'server'), baseDir: join(root, 'materialized'),
        recordsByServiceId: new Map(), connectedAccountsOwner: selected.owner,
        connectedAccountMaterializationAuthority: { kind: 'qualified', purposeBindings: [selected.binding], requestAuthPurposeBindings: [] },
        qualifiedPurposeBindingSnapshot: { ...declaration, bindings: [selected.binding] }, processEnv: baseEnv,
        allowNativeAccountState: false, sessionDirectory: root });
      expect(materialized?.env.GOOGLE_APPLICATION_CREDENTIALS).toBeTypeOf('string');
      if (!materialized) throw new Error('Daemon materialization unavailable');
      const adcPath = materialized.env.GOOGLE_APPLICATION_CREDENTIALS!;
      expect(adcPath).not.toBe(baseEnv.GOOGLE_APPLICATION_CREDENTIALS);
      expect(await readFile(adcPath, 'utf8')).toBe(serializedCredential);
      if (process.platform !== 'win32') expect((await lstat(adcPath)).mode & 0o777).toBe(0o600);
      const environment = buildScopedProcessEnv({ baseEnv, explicitEnv: materialized.env, unsetEnvKeys: materialized.unsetEnvKeys });
      const runtime = await createOhMyPiAgentRuntime({ plugin: { id: 'happier.agent.ohmypi', version: '0.0.0' }, agent: { id: 'ohmypi' }, signal: lifetime.signal });
      for (const route of ['session', 'finite'] as const) {
        const capture = join(root, `${route}-capture.json`);
        // Only the native executable is substituted; ACP transport, composition and turns run.
        const script = writeAcpTestAgentScript({ dir: root, fileName: `${route}-omp.mjs`, source: `
          import { readFileSync, writeFileSync } from 'node:fs';
          import { createInterface } from 'node:readline';
          const adcPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
          let currentModel='google-vertex/gemini-2.5-pro';
          const configOptions=()=>[{id:'model',name:'Model',type:'select',category:'model',currentValue:currentModel,
            options:[{value:'google-vertex/gemini-2.5-pro',name:'Selected Vertex model'},
              {value:'google-vertex/gemini-2.5-flash',name:'Next Vertex model'}]}];
          const observed={ adcPath, credential: readFileSync(adcPath, 'utf8'),
            project: process.env.GOOGLE_CLOUD_PROJECT, location: process.env.GOOGLE_CLOUD_LOCATION,
            vertex: process.env.GOOGLE_GENAI_USE_VERTEXAI, key: process.env.GEMINI_API_KEY,
            home: process.env.PI_CODING_AGENT_DIR,
            models: JSON.parse(readFileSync(process.env.PI_CODING_AGENT_DIR+'/models.yml','utf8')), promptModels:[] };
          const save=()=>writeFileSync(${JSON.stringify(capture)},JSON.stringify(observed));
          save();
          for await (const line of createInterface({input:process.stdin})) {
            const r=JSON.parse(line); if(r.id===undefined) continue;
            let result={};
            if(r.method==='initialize') result={protocolVersion:1,agentCapabilities:{}};
            if(r.method==='session/new') result={sessionId:'native-omp-adc',configOptions:configOptions()};
            if(r.method==='session/set_config_option') {
              if(r.params.configId==='model') currentModel=r.params.value;
              result={configOptions:configOptions()};
            }
            if(r.method==='session/prompt') {
              observed.promptModels.push(currentModel); save();
              process.stdout.write(JSON.stringify({jsonrpc:'2.0',method:'session/update',params:{sessionId:'native-omp-adc',
                update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'OMP_ADC_COMPLETE'}}}})+'\\n');
              result={stopReason:'end_turn'};
            }
            process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:r.id,result})+'\\n');
          }
        ` });
        const publications = createNativeAgentSessionPublications({ agentId: 'ohMyPi', session: null,
          signal: lifetime.signal, isCurrent: () => !lifetime.signal.aborted, supportsInFlightSteer: false });
        const dependencies: PublicAcpComposerDependencies = { pluginId: 'happier.agent.ohmypi', agentId: 'ohMyPi', signal: lifetime.signal,
          isCurrent: () => !lifetime.signal.aborted,
          systemTools: { resolve: async () => ({ toolId: 'ohmypi-cli', launch: { kind: 'binary', executablePath: process.execPath, args: [script] } }) },
          interactions: { async request() { throw new Error('Unexpected native interaction'); } },
          media: { async registerSourceRoot() { throw new Error('Unexpected native media'); } }, models: publications.services.models, modes: publications.services.modes };
        const connectedAccounts = {
          getBinding: async (id: string) => id === purpose.purpose ? await selected.owner.getBinding({ purpose, serviceRefs: [service], signal: lifetime.signal }) : null,
          materialize: async (_id: string, request: Parameters<ConnectedAccountRuntime['materialize']>[0]) => await selected.owner.materialize({ purpose, serviceRefs: [service], request, signal: lifetime.signal, expectedAccount: account }),
          watch(_id: string, listener: (event: { kind: 'resync'; authorityChanged: boolean }) => void | Promise<void>) {
            queueMicrotask(() => void listener({ kind: 'resync', authorityChanged: false })); return { dispose() {} };
          },
        };
        const context = { signal: lifetime.signal, services: { connectedAccounts }, protocols: { acp: {
          open: (request: Parameters<typeof createPublicAcpSession>[0], options: Parameters<typeof createPublicAcpSession>[1]) => createPublicAcpSession(request, options, dependencies),
          openExecutionRunV1: (request: Parameters<typeof createPublicAcpExecutionRun>[0], options: Parameters<typeof createPublicAcpExecutionRun>[1]) => createPublicAcpExecutionRun(request, options, dependencies),
        } } };
        const common = { kind: 'create' as const, cwd: root, connectedAccounts: [{ purpose: purpose.purpose, account }],
          configuration: { model: { value: 'google-vertex/gemini-2.5-pro', updatedAtMs: 1 }, mode: { value: null, updatedAtMs: 0 },
            permissionIntent: { value: null, updatedAtMs: 0 }, options: {} },
          launchEnvironment: { values: environment, unset: [...(materialized.unsetEnvKeys ?? [])] } };
        try {
          if (route === 'session') {
            const session = await runtime.sessions.open({ ...common, sessionId: 'omp-selected' }, context as unknown as AgentSessionRuntimeContext);
            const events: AgentSessionRuntimeEvent[] = []; const subscription = session.watch(event => { events.push(event); });
            try {
              await session.send({ inputIds: ['input'], input: { text: 'Use selected Vertex account.' }, delivery: { kind: 'newTurn', turnId: 'turn' } });
              await expect.poll(() => events.some(event => event.kind === 'turn-complete')).toBe(true);
              expect(events).toContainEqual(expect.objectContaining({ kind: 'message-delta', text: 'OMP_ADC_COMPLETE' }));
              expect(await session.updateConfiguration?.({ ...common.configuration,
                model: { value: 'google-vertex/gemini-2.5-flash', updatedAtMs: 2, selectionSource: 'explicit' },
              })).toMatchObject({ status: 'applied' });
              await session.send({ inputIds: ['next-input'], input: { text: 'Use the next Vertex model.' }, delivery: { kind: 'newTurn', turnId: 'next-turn' } });
              await expect.poll(() => events.some(event => event.kind === 'turn-complete' && event.turnId === 'next-turn')).toBe(true);
              expect(publications.modelsSource.read().currentModelId).toBe('google-vertex/gemini-2.5-flash');
            } finally { subscription.dispose(); await session.dispose(); }
          } else {
            const run = await runtime.sessions.executionRunContextV1!.open({ ...common, runId: 'omp-run', profile: { pluginId: 'happier.agent.ohmypi', localId: 'default' },
              input: { text: 'Use selected Vertex account.' } }, context as unknown as AgentExecutionRunRuntimeContextV1);
            const events: AgentExecutionRunEvent[] = []; const subscription = run.watch(event => { events.push(event); });
            try {
              await expect.poll(() => events.some(event => event.kind === 'run-complete')).toBe(true);
              expect(events).toContainEqual(expect.objectContaining({ kind: 'output-delta', text: 'OMP_ADC_COMPLETE' }));
            } finally { subscription.dispose(); await run.dispose(); }
          }
          const observed = JSON.parse(await readFile(capture, 'utf8'));
          expect(observed).toMatchObject({ adcPath, credential: serializedCredential, project: 'selected-project', location: 'global', vertex: '1', home: materialized.env.PI_CODING_AGENT_DIR });
          expect(observed).not.toHaveProperty('key');
          expect(observed.models.providers?.['google-vertex'] ?? {}).not.toHaveProperty('apiKey');
          expect(observed.promptModels).toEqual(route === 'session'
            ? ['google-vertex/gemini-2.5-pro', 'google-vertex/gemini-2.5-flash']
            : ['google-vertex/gemini-2.5-pro']);
        } finally { publications.dispose(); }
      }
    } finally {
      lifetime.abort(); await materialized?.cleanupOnExit?.(); lease.dispose(); await fixture.dispose(); await rm(root, { recursive: true, force: true });
    }
  });
});

describe('Oh My Pi service-keyed account selection to native launch', () => {
  const cases: ReadonlyArray<Readonly<{
      id: string; service: { pluginId: string; localId: string }; runtime: Pick<ConnectedAccountRuntime, 'materialize'>;
      credentials: Readonly<Record<string, string>>; nativeProvider: string; nativeKey: string; expected: string | Readonly<Record<string, string>>;
    }>> = [{
      id: 'kimi-oauth', service: KIMI_CONNECTED_ACCOUNT_SERVICE, runtime: createKimiConnectedAccountRuntime(),
      credentials: { accessToken: 'fake-kimi-oauth', credentialKind: 'oauth', refreshToken: 'fake-refresh', apiKind: 'code', apiBase: 'https://api.kimi.ai/coding/v1' },
      nativeProvider: 'kimi-code', nativeKey: 'KIMI_API_KEY', expected: 'fake-kimi-oauth',
    }, {
      id: 'kimi-key', service: KIMI_CONNECTED_ACCOUNT_SERVICE, runtime: createKimiConnectedAccountRuntime(),
      credentials: { accessToken: 'fake-kimi-key', credentialKind: 'token', apiKind: 'code', apiBase: 'https://api.kimi.ai/coding/v1' },
      nativeProvider: 'kimi-code', nativeKey: 'KIMI_API_KEY', expected: 'fake-kimi-key',
    }, {
      id: 'xai-subscription', service: GROK_CONNECTED_ACCOUNT_SERVICE, runtime: createXaiConnectedAccountRuntime(),
      credentials: { xaiCredential: JSON.stringify({ mode: 'subscription', accessToken: 'fake-xai-oauth', refreshToken: 'fake-refresh' }) },
      nativeProvider: 'xai-oauth', nativeKey: 'XAI_OAUTH_TOKEN', expected: 'fake-xai-oauth',
    }, {
      id: 'xai-key', service: GROK_CONNECTED_ACCOUNT_SERVICE, runtime: createXaiConnectedAccountRuntime(),
      credentials: { xaiCredential: JSON.stringify({ mode: 'api-key', accessToken: 'fake-xai-key' }) },
      nativeProvider: 'xai', nativeKey: 'XAI_API_KEY', expected: 'fake-xai-key',
    }, {
      id: 'muse-subscription', service: MUSE_ACCOUNT_SERVICE, runtime: museConnectedAccountRuntime,
      credentials: { credentialMode: 'native', nativeMechanism: '"oauth"', accountToken: 'fake-muse-oauth', inferenceKey: 'fake-muse-inference' },
      nativeProvider: 'muse-code', nativeKey: 'MUSE_CODE_CREDENTIAL', expected: { oauthAccessToken: 'fake-muse-oauth', apiKey: 'fake-muse-inference' },
    }, {
      id: 'muse-key', service: MUSE_ACCOUNT_SERVICE, runtime: museConnectedAccountRuntime,
      credentials: { credentialMode: 'api-key', inferenceKey: 'fake-meta-key' }, nativeProvider: 'meta', nativeKey: 'META_API_KEY', expected: 'fake-meta-key',
    }, {
      id: 'gemini-key', service: GEMINI_CONNECTED_ACCOUNT_SERVICE, runtime: geminiConnectedAccountRuntime,
      credentials: { apiKey: 'fake-gemini-key' }, nativeProvider: 'google', nativeKey: 'GEMINI_API_KEY', expected: 'fake-gemini-key',
    }, {
      id: 'github-copilot', service: GITHUB_CONNECTED_ACCOUNT_SERVICE, runtime: githubAccountCredentialRuntime,
      credentials: { token: 'github_pat_accepted' }, nativeProvider: 'github-copilot', nativeKey: 'COPILOT_GITHUB_TOKEN', expected: 'github_pat_accepted',
    }];
  it.each(cases)('launches $id without requiring incompatible sibling purposes', async row => {
    const root = await mkdtemp(join(tmpdir(), 'ohmypi-service-modes-'));
    const fixture = await createAdmittedPluginRuntimeFixture({ controller: pluginReloadController,
      runtimeOptions: { pluginIds: ['happier.agent.ohmypi'] } }).catch(async error => {
      await rm(root, { recursive: true, force: true }); throw error;
    });
    try {
        const lifetime = new AbortController();
        const serviceKey = `${row.service.pluginId}/${row.service.localId}`;
        const account = { service: row.service, accountId: row.id };
        const snapshot = resolveQualifiedPurposeBindingSnapshotForAgentSpawn({ agentId: 'ohMyPi', contributions: fixture.registry.contributes,
          bindings: { v: 2, bindingsByServiceId: { [serviceKey]: { source: 'connected', selection: 'profile', profileId: account.accountId } } } });
        if (!snapshot?.bindings[0]) throw new Error('Service-keyed account ingress did not bind the selected account');
        const selected = createForegroundPurposeOwnerFixture({ consumer: snapshot.bindings[0].purpose.consumer, purpose: snapshot.bindings[0].purpose.purpose,
          service: row.service, accountId: account.accountId, materializeAccount: async ({ request, existingFiles, signal }) => {
            const context: Parameters<ConnectedAccountRuntime['materialize']>[1] = {
              account, plugin: { id: row.service.pluginId, version: '0.0.0' },
              contribution: { id: row.service.localId, qualifiedId: serviceKey }, surface: 'background', invokedAtMs: 0, signal,
              services: createUnavailablePluginServices(), credentials: { async get(key) { return row.credentials[key] ?? null; } },
              configuration: { target: { kind: 'account', account, modeId: 'api-key' }, revision: 'fixture-1', values: {}, async getSecret() { return null; } },
            };
            return row.runtime.materialize(request, context, { existingFiles, signal });
          } });
        await selected.store.update(() => ({ v: 1, bindings: [...snapshot.bindings] }));
        const lease = selected.owner.activateSessionPurposeBindings({ sessionId: row.id, purposes: snapshot.purposes, bindings: snapshot.bindings });
        let materialized: Awaited<ReturnType<typeof materializeConnectedServicesForSpawn>> = null;
        let publications: ReturnType<typeof createNativeAgentSessionPublications> | undefined;
        try {
          const baseEnv = { HOME: root, USERPROFILE: root, KIMI_API_KEY: 'fake-ambient', XAI_API_KEY: 'fake-ambient',
            XAI_OAUTH_TOKEN: 'fake-ambient', MUSE_CODE_CREDENTIAL: 'fake-ambient', META_API_KEY: 'fake-ambient' };
          materialized = await materializeConnectedServicesForSpawn({ agentId: 'ohMyPi', materializationKey: row.id, purposeBindingSessionId: row.id,
            activeServerDir: join(root, 'server'), baseDir: join(root, 'materialized'), recordsByServiceId: new Map(), connectedAccountsOwner: selected.owner,
            connectedAccountMaterializationAuthority: { kind: 'qualified', purposeBindings: snapshot.bindings, requestAuthPurposeBindings: [] },
            qualifiedPurposeBindingSnapshot: snapshot, processEnv: baseEnv, allowNativeAccountState: false, sessionDirectory: root });
          if (!materialized) throw new Error('Selected service mode did not materialize a native launch');
          const capture = join(root, `${row.id}-capture.json`);
          const model = `${row.nativeProvider}/selected`;
          const script = writeAcpTestAgentScript({ dir: root, fileName: `${row.id}.mjs`, source: `
            import { readFileSync,writeFileSync } from 'node:fs';
            import { createInterface } from 'node:readline';
            const currentModel=${JSON.stringify(model)};
            const configOptions=[{id:'model',name:'Model',type:'select',category:'model',currentValue:currentModel,options:[{value:currentModel,name:'Selected'}]}];
            writeFileSync(${JSON.stringify(capture)},JSON.stringify({credential:process.env[${JSON.stringify(row.nativeKey)}],
              configuration:JSON.parse(readFileSync(process.env.PI_CODING_AGENT_DIR+'/models.yml','utf8'))}));
            for await(const line of createInterface({input:process.stdin})) {
              const r=JSON.parse(line);if(r.id===undefined)continue;let result={};
              if(r.method==='initialize')result={protocolVersion:1,agentCapabilities:{}};
              if(r.method==='session/new')result={sessionId:'native-selected-mode',configOptions};
              if(r.method==='session/set_config_option')result={configOptions};
              if(r.method==='session/prompt') {
                process.stdout.write(JSON.stringify({jsonrpc:'2.0',method:'session/update',params:{sessionId:'native-selected-mode',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'SELECTED_MODE_COMPLETE'}}}})+'\\n');
                result={stopReason:'end_turn'};
              }
              process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:r.id,result})+'\\n');
            }
          ` });
          publications = createNativeAgentSessionPublications({ agentId: 'ohMyPi', session: null,
            signal: lifetime.signal, isCurrent: () => !lifetime.signal.aborted, supportsInFlightSteer: false });
          const dependencies: PublicAcpComposerDependencies = { pluginId: 'happier.agent.ohmypi', agentId: 'ohMyPi', signal: lifetime.signal,
            isCurrent: () => !lifetime.signal.aborted,
            systemTools: { resolve: async () => ({ toolId: 'ohmypi-cli', launch: { kind: 'binary', executablePath: process.execPath, args: [script] } }) },
            interactions: { async request() { throw new Error('Unexpected native interaction'); } },
            media: { async registerSourceRoot() { throw new Error('Unexpected native media'); } }, models: publications.services.models, modes: publications.services.modes };
          const scopeForPurpose = (purpose: string) => snapshot.bindings.some(binding => binding.purpose.purpose === purpose)
            ? snapshot.authorizedPurposes?.find(scope => scope.purpose.purpose === purpose) : undefined;
          const context = { signal: lifetime.signal, services: { connectedAccounts: {
            getBinding: async (purpose: string) => {
              const scope = scopeForPurpose(purpose);
              return scope ? await selected.owner.getBinding({ purpose: scope.purpose, serviceRefs: scope.serviceRefs, signal: lifetime.signal }) : null;
            },
            materialize: async (purpose: string, request: Parameters<ConnectedAccountRuntime['materialize']>[0]) => {
              const scope = scopeForPurpose(purpose);
              if (!scope) throw new Error('Native preparation requested an unbound purpose');
              return await selected.owner.materialize({ purpose: scope.purpose, serviceRefs: scope.serviceRefs, request,
                signal: lifetime.signal, expectedAccount: account });
            },
            watch(_purpose: string, listener: (event: { kind: 'resync'; authorityChanged: boolean }) => void | Promise<void>) {
              queueMicrotask(() => void listener({ kind: 'resync', authorityChanged: false })); return { dispose() {} };
            },
          } }, protocols: { acp: { open: (request: Parameters<typeof createPublicAcpSession>[0], options: Parameters<typeof createPublicAcpSession>[1]) => createPublicAcpSession(request, options, dependencies) } } };
          const runtime = await createOhMyPiAgentRuntime({ plugin: { id: 'happier.agent.ohmypi', version: '0.0.0' }, agent: { id: 'ohmypi' }, signal: lifetime.signal });
          const session = await runtime.sessions.open({ kind: 'create', sessionId: row.id, cwd: root,
            connectedAccounts: materialized.sessionConnectedAccounts,
            configuration: { model: { value: model, updatedAtMs: 1 }, mode: { value: null, updatedAtMs: 0 }, permissionIntent: { value: null, updatedAtMs: 0 }, options: {} },
            launchEnvironment: { values: buildScopedProcessEnv({ baseEnv, explicitEnv: materialized.env, unsetEnvKeys: materialized.unsetEnvKeys }), unset: [...(materialized.unsetEnvKeys ?? [])] },
          }, context as unknown as AgentSessionRuntimeContext);
          const events: AgentSessionRuntimeEvent[] = []; const subscription = session.watch(event => { events.push(event); });
          try {
            await session.send({ inputIds: ['input'], input: { text: 'Use the selected service mode.' }, delivery: { kind: 'newTurn', turnId: 'turn' } });
            await expect.poll(() => events.some(event => event.kind === 'turn-complete')).toBe(true);
            expect(events).toContainEqual(expect.objectContaining({ kind: 'message-delta', text: 'SELECTED_MODE_COMPLETE' }));
            const observed = JSON.parse(await readFile(capture, 'utf8'));
            expect(typeof row.expected === 'string' ? observed.credential : JSON.parse(observed.credential)).toEqual(row.expected);
            expect(observed.configuration).toMatchObject({ providers: { [row.nativeProvider]: { apiKey: row.nativeKey } } });
            expect(Object.keys(observed.configuration.providers)).toEqual([row.nativeProvider]);
          } finally { subscription.dispose(); await session.dispose(); }
        } finally {
          publications?.dispose(); lifetime.abort(); await materialized?.cleanupOnExit?.(); lease.dispose();
        }
    } finally { await fixture.dispose(); await rm(root, { recursive: true, force: true }); }
  });
});
