import { setup as setupApprovedTransfer } from './approvedTransferCustody.testkit';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PluginApi } from '@happier-dev/plugin-sdk';
import type { QualifiedConnectedAccountPurposeBindingsV1 } from '@happier-dev/protocol';
import { createConnectedAccountPurposeBindingOwner } from '@/daemon/connectedServices/purposeBindings/ConnectedAccountPurposeBindingOwner';
import { PLUGIN_MANIFEST as GITHUB_MANIFEST } from '../../../../../packages/plugins/scm-github/src/manifest';
import { activate as activateGithub } from '../../../../../packages/plugins/scm-github/src/activate';
import { createStubGithubTransport } from '../../../../../packages/plugins/scm-github/src/triage/testkit/githubTriage.test-support';
import { loadInstalledPlugins } from '@/plugins/discovery/load/installed';
import { loadCurrentBundledPluginLocatorResult } from '@/plugins/projection/registry/builtIn/locators';
import { projectLoadedPluginContributes } from '@/plugins/projection/registry/fullProjection';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { FilesystemDownloadOutputSchema } from '@happier-dev/protocol/actions/filesystemActionFamily';
import { createTargetActionInvocationRegistry } from '@/plugins/runtime/invocation/targetActionRegistry';
import { createTargetActionHostBindingResolver } from '@/plugins/runtime/hostAccess/resolve';
import { createPluginInvocationServicesFactory, createPluginInvocationServiceBinding } from '@/plugins/runtime/invocation/services/factory';
import { createManagedPluginSourceCustody } from '@/plugins/runtime/lifecycle/contributions/runtimeIdentity.testkit';
import type { PluginRuntimeOccurrenceId } from '@/plugins/runtime/runtimeSlots';
import { createDirectTransferServerLifecycle } from './directTransferServerLifecycle';
import { createPreparedFilesystemTransferClient } from './preparedFilesystemTransferClient';
import { requestDirectPeerTransferToFile, startDirectPeerTransferServer } from './directPeerTransport';
import * as exports from './prepareWorkspaceFileExport';
import { createHostActionOperationRuntime } from '@/daemon/actionOperations/createHostActionOperationRuntime';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('admitted plugin file download', () => {
  it('runs the registered release download through native approval and operation acceptance until receiver ACK', async () => {
    const localId = 'github/releases/asset-download';
    const bytes = new Uint8Array([0, 255, 137, 80, 78, 71, 0]);
    const repository = { kind: 'github', deployment: 'https://github.com', repository: 'acme/widgets' } as const;
    const github = createStubGithubTransport({
      respond: request => {
        const path = new URL(request.url).pathname;
        if (path === '/repos/acme/widgets') return { status: 200, body: { id: 42, full_name: 'acme/widgets', private: true } };
        if (path === '/repos/acme/widgets/releases/7') return { status: 200, body: { id: 7, tag_name: 'v7', target_commitish: 'main',
          name: 'Release 7', body: 'Notes', draft: false, prerelease: false, created_at: '2026-10-24T00:00:00Z',
          updated_at: '2026-10-24T00:00:00Z', published_at: '2026-10-24T00:00:00Z',
          html_url: 'https://github.com/acme/widgets/releases/tag/v7', assets: [] } };
        if (path === '/repos/acme/widgets/releases/7/assets') return { status: 200, body: [{ id: 71, name: 'asset.bin',
          size: bytes.length, state: 'uploaded', content_type: 'application/octet-stream', download_count: 0 }] };
        if (path === '/repos/acme/widgets/releases/assets/71') return { status: 200, rawBody: bytes };
        return undefined;
      } });
    let stored: QualifiedConnectedAccountPurposeBindingsV1 = { v: 1, bindings: [] };
    const unavailable = async () => { throw new Error('Native-login fixture cannot select or materialize a configured Account'); };
    // Store and native credential materialization are external boundaries;
    // purpose selection and the admitted host services remain real.
    const connectedAccounts = createConnectedAccountPurposeBindingOwner({
      store: { read: async () => stored, async update(mutate) { stored = mutate(stored); return stored; } },
      selectTarget: unavailable, resolveTarget: unavailable, materializeAccount: unavailable,
      projectTargetAccounts: unavailable, assertTargetAccountMaterializable: unavailable,
      materializeNative: async () => ({ kind: 'httpHeaders', headers: { authorization: 'Bearer fixture' } }),
    });
    // The full manifest's packaged Resources belong to the same physical source
    // inventory as its daemon entry. Preserve their real bytes, not dummy assets.
    const resourceFiles = Object.fromEntries(await Promise.all(GITHUB_MANIFEST.contributes.resources.flatMap(resource =>
      'path' in resource ? [(async () => [resource.path,
        await readFile(new URL(`../../../../../packages/plugins/scm-github/${resource.path}`, import.meta.url))] as const)()] : [])));
    const fixture = await setupApprovedTransfer(false, false, false, {
      manifest: GITHUB_MANIFEST,
      files: { ...resourceFiles, '.happier-plugin/daemon.js': 'export function activate() {}' },
      // Module loading and GitHub HTTP/credentials are the fixture boundaries. The actual registered
      // release handler, filesystem service, native publisher, approvals and operation runner stay real.
      instantiateCommittedModule: () => ({ activate(api: PluginApi) {
        return activateGithub({ ...api, actions: { ...api.actions, register(id, handler) {
          api.actions.register(id, (input, context) => handler(input, { ...context, services: { ...context.services,
            http: github.context.services.http } }));
        } } });
      } }),
    }, async happyHomeDir => {
      const installed = await loadInstalledPlugins({ happyHomeDir });
      expect(installed.loadedPlugins.map(plugin => plugin.pluginId)).toEqual([GITHUB_MANIFEST.id]);
      // This is the real bundled declaration's reference-universe classification,
      // not source authority: GitHub retains the installed loader's physical path,
      // source spec, committed generation and the normal startup invocation owner.
      const bundled = loadCurrentBundledPluginLocatorResult();
      return createResolvedContributionRegistry(projectLoadedPluginContributes({ provenance: 'first_party',
        loadResult: { ...installed, loadedPlugins: [
          ...bundled.loadedPlugins.filter(plugin => plugin.pluginId !== GITHUB_MANIFEST.id),
          ...installed.loadedPlugins,
        ] },
      }));
    }, connectedAccounts);
    const primaryFailures: unknown[] = [];
    try {
      const request = await fixture.invoke('action.invoke', { action: { pluginId: GITHUB_MANIFEST.id, localId },
        input: { repository, repositoryId: '42', releaseId: '7', assetId: '71', destination: { destinationId: 'release-receiver' } } },
      'release-download', false, 'bob', 'agent');
      expect(request, JSON.stringify(request)).toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
      expect(github.requests).toHaveLength(0);
      expect(fixture.lifecycle.getState().publishedTransferCount).toBe(0);
      const decided = await fixture.approve('alice');
      expect(decided, JSON.stringify(decided)).toMatchObject({ ok: true, result: { execution: { ok: true, result: { success: true, status: 'accepted' } } } });
      if (!decided.ok || !decided.result || typeof decided.result !== 'object' || !('execution' in decided.result)
        || !decided.result.execution || typeof decided.result.execution !== 'object' || !('result' in decided.result.execution)) throw new Error('Expected admitted release receipt');
      const receipt = FilesystemDownloadOutputSchema.parse(decided.result.execution.result);
      if (!receipt.success || receipt.status !== 'accepted') throw new Error('Expected real release operation acceptance');
      expect((await fixture.list()).items).toMatchObject([{ operationId: receipt.operationId, state: 'running' }]);
      expect((await fixture.list('alice')).items).toEqual([]);
      const localPort = await fixture.lifecycle.ensureListening();
      const endpointCandidates = receipt.prepared.endpointCandidates.map(candidate => {
        const url = new URL(candidate.url); url.hostname = '127.0.0.1'; url.port = String(localPort);
        return { ...candidate, url: url.toString() };
      });
      const destinationPath = join(fixture.directory, 'release.bin');
      const received = await requestDirectPeerTransferToFile({ transferId: receipt.prepared.transferId, endpointCandidates, destinationPath,
        expectedSizeBytes: receipt.prepared.sizeBytes, expectedManifestHash: receipt.prepared.manifestHash });
      expect(await readFile(destinationPath)).toEqual(Buffer.from(bytes));
      expect(await fixture.read(receipt.operationId, false)).toMatchObject({ kind: 'found', operation: { state: 'running' } });
      const endpoint = endpointCandidates[0]!;
      expect((await fetch(`${endpoint.url}/complete`, { method: 'POST',
        headers: { 'content-type': 'application/json', Authorization: `Bearer ${endpoint.authorizationToken}` },
        body: JSON.stringify({ success: true, destinationId: receipt.destinationId, sizeBytes: received.sizeBytes, manifestHash: received.manifestHash }) })).ok).toBe(true);
      expect(await fixture.read(receipt.operationId)).toMatchObject({ kind: 'found', operation: { state: 'succeeded', result: { status: 'completed' } } });
      expect(fixture.lifecycle.getState().publishedTransferCount).toBe(0);
    } catch (error) {
      primaryFailures.push(error);
      throw error;
    } finally {
      const activationFacts = fixture.readProviderActivationFacts();
      const cleanupFailures: unknown[] = [];
      try { await fixture.close(); } catch (error) { cleanupFailures.push(error); }
      if (cleanupFailures.length) throw new AggregateError([...primaryFailures, ...cleanupFailures],
        `Registered release download cleanup failed; activation facts: ${JSON.stringify(activationFacts)}`);
    }
  });
  it('returns the real contributed operation acceptance before ACK and settles that same operation afterwards', async () => {
    const lifecycle = createDirectTransferServerLifecycle({ bindPort: 0, listenerClasses: ['loopback_http'] });
    const runtime = createHostActionOperationRuntime({ machineId: 'machine', resolveAccountId: async () => 'account',
      generateOperationId: () => 'actual-download-operation' });
    const directory = await mkdtemp(join(tmpdir(), 'happier-operation-download-'));
    try {
      const result = await runtime.observePluginExecution({ actionId: 'external.download-fixture/download', title: 'Download',
        operation: { version: 1, visibility: 'activity', progress: 'indeterminate', presentation: { onStart: 'activity' } }, input: {},
        execute: async ({ operationAcceptance }) => {
          if (!operationAcceptance) return { ok: false, errorCode: 'missing_acceptance', error: 'missing_acceptance' };
          const receipt = await exports.prepareAcquiredFileDownload({ lifecycle,
            input: { name: 'asset.bin', bytes: new Uint8Array([0, 255]), destination: { destinationId: 'held' } },
            sourceId: 'request', requesterAccountId: 'account', retirementSignal: new AbortController().signal,
            operationId: operationAcceptance.operationId, assertCurrentAuthority: async () => {} });
          if (!receipt.success || receipt.status !== 'accepted') return { ok: false, errorCode: 'publication_failed', error: 'publication_failed' };
          const settlement = lifecycle.waitForFilesystemExportSettlement(receipt.prepared.transferId, {
            kind: 'acquired', sourceId: 'request', requesterAccountId: 'account', destinationId: 'held' });
          operationAcceptance.accept(receipt);
          const settled = await settlement;
          return settled.success ? { ok: true, result: { success: true, status: 'completed', transferId: receipt.prepared.transferId,
            destinationId: 'held', name: 'asset.bin', sizeBytes: settled.sizeBytes, sha256: settled.manifestHash.slice(7) } }
            : { ok: false, errorCode: settled.errorCode ?? 'download_failed', error: settled.error };
        } });
      expect(result).toMatchObject({ ok: true, result: { status: 'accepted', operationId: 'actual-download-operation' } });
      expect(await runtime.handlers.getV2({ operationId: 'actual-download-operation' })).toMatchObject({ kind: 'found', operation: { state: 'running' } });
      const receiver = createPreparedFilesystemTransferClient({ executeAction: async () => result,
        openMachineTunnel: async () => ({ localPort: await lifecycle.ensureListening(), observedPath: 'direct', close: async () => {} }) });
      expect(await receiver.download({ targetMachineId: 'machine', rootPath: directory, path: 'unused', asZip: false,
        destinationId: 'held', destinationPath: join(directory, 'received.bin') })).toMatchObject({ success: true, status: 'completed' });
      expect(await runtime.handlers.getV2({ operationId: 'actual-download-operation', waitForTerminal: true }))
        .toMatchObject({ kind: 'found', operation: { state: 'succeeded', result: { status: 'completed' } } });
      expect(lifecycle.getState().publishedTransferCount).toBe(0);
    } finally { await lifecycle.stop(); await rm(directory, { recursive: true, force: true }); }
  });
  it('retracts a publication when caller cancellation wins while the native listener is opening', async () => {
    let listening!: () => void;
    let enter!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const gate = new Promise<void>(resolve => { listening = resolve; });
    const lifecycle = createDirectTransferServerLifecycle({ bindPort: 0, listenerClasses: ['loopback_http'],
      // Listener placement is the physical boundary; publication/cleanup remain real.
      startServer: async params => { enter(); await gate; return await startDirectPeerTransferServer(params); } });
    const caller = new AbortController();
    let released = 0;
    const publication = exports.prepareAcquiredFileDownload({ lifecycle,
      input: { name: 'asset.bin', bytes: new Uint8Array([0, 255]), destination: { destinationId: 'held' } },
      sourceId: 'request', operationId: 'admitted-operation', requesterAccountId: 'account', retirementSignal: new AbortController().signal,
      signal: caller.signal, assertCurrentAuthority: async () => {}, onDispose: async () => { released++; } });
    try {
      await entered;
      caller.abort();
      listening();
      expect(await publication).toMatchObject({ success: false, status: 'cancelled' });
      expect(lifecycle.getState().publishedTransferCount).toBe(0);
      expect(released).toBe(1);
    } finally { listening(); await publication; await lifecycle.stop(); }
  });
  it.each([
    { surface: 'plugin', dangerLevel: 'writesLocal', allowed: true },
    { surface: 'agent', dangerLevel: 'writesLocal', allowed: true },
    { surface: 'mcp', dangerLevel: 'writesLocal', allowed: true },
    { surface: 'plugin', dangerLevel: 'safe', allowed: false },
    { surface: 'plugin', dangerLevel: 'writesLocal', readOnly: true, allowed: false },
    { surface: 'plugin', dangerLevel: 'writesLocal', wrongDestination: true, allowed: false },
    { surface: 'plugin', dangerLevel: 'writesLocal', retire: true, allowed: true },
    { surface: 'plugin', dangerLevel: 'writesLocal', revoke: true, allowed: true },
    { surface: 'plugin', dangerLevel: 'writesLocal', runnerCancelled: true, allowed: true },
  ] as const)('retains exact admitted publication (%j)', async scenario => {
    const { surface, dangerLevel, allowed } = scenario;
    const directory = await mkdtemp(join(tmpdir(), 'happier-plugin-download-'));
    const lifecycle = createDirectTransferServerLifecycle({ bindPort: 0, listenerClasses: ['loopback_http'] });
    const bytes = new Uint8Array([0, 255, 137, 80, 78, 71, 0]);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const destination = { destinationId: 'held-receiver' };
    const factory = createPluginInvocationServicesFactory({ loggerSink: { write() {} },
      filesystemRoots: { pluginData: directory, workspace: directory, projects: new Map() } });
    let approvals = 0;
    let publicationSignal: AbortSignal | undefined;
    let accountCurrent = true;
    const registry = createTargetActionInvocationRegistry({
      actions: [{ pluginId: 'external.download-fixture', pluginVersion: '1.0.0', occurrenceId: 'download-generation' as PluginRuntimeOccurrenceId,
        sourceCustody: createManagedPluginSourceCustody('download-fixture'), localId: 'download',
        definition: { id: 'download', dangerLevel, ...('readOnly' in scenario ? { readOnly: scenario.readOnly } : {}), scopes: ['global'], surfaces: ['ui', 'plugin', 'agent', 'mcp'],
          confirmationWhen: { presentUserUi: false }, inputSchema: { type: 'object', additionalProperties: false,
            required: ['destination'], properties: { destination: { type: 'object', additionalProperties: false,
              required: ['destinationId'], properties: { destinationId: { type: 'string', minLength: 1 } } } } } },
        handler: async (_input, context) => {
          publicationSignal = context.signal;
          return await context.services.fs.prepareDownload({ name: 'asset.bin', bytes,
            destination: 'wrongDestination' in scenario ? { destinationId: 'not-admitted' } : destination }, { signal: context.signal });
        } }],
      resolveHostBinding: createTargetActionHostBindingResolver({ createServiceBinding: (occurrenceId, id, requests) =>
        createPluginInvocationServiceBinding(occurrenceId, id) }),
      resolveAuthorizationFacts: action => ({ generation: { targetGeneration: action.occurrenceId, desiredGeneration: action.occurrenceId,
        appliedGeneration: action.occurrenceId }, resourceSelections: [], scopedGrants: [], operatingSystemAuthorization: [] }),
      createServices: factory,
      readCurrentPluginOccurrenceId: () => 'download-generation',
    });
    try {
      const preparation = await registry.prepare({ pluginId: 'external.download-fixture', localId: 'download', input: { destination }, surface,
        invocationAuthority: surface === 'plugin' ? 'present_user' : 'account_automation',
        approvalContext: { runtimeAccountId: 'account', actionRequestId: 'download-request',
          prepareFileDownload: async (input, options) => await exports.prepareAcquiredFileDownload({ lifecycle, input,
            sourceId: 'download-request', operationId: 'admitted-operation', requesterAccountId: 'account', retirementSignal: options.retirementSignal,
            assertCurrentAuthority: async () => { if (!accountCurrent) throw new Error('Account authority retired'); } }) },
        requestCurrentIntent: async ({ fingerprint }) => { approvals++; return { status: 'approved', fingerprint }; },
      });
      const operation = new AbortController();
      if ('runnerCancelled' in scenario) operation.abort();
      const result = preparation.kind === 'settled' ? preparation.result : await preparation.run({ signal: operation.signal });
      if ('runnerCancelled' in scenario) {
        expect(result.status).not.toBe('executed');
        expect(lifecycle.getState().publishedTransferCount).toBe(0);
        return;
      }
      if (!allowed) {
        expect(result).toMatchObject({ status: 'executed', value: { success: false, status: 'failed', errorCode: 'filesystem_transfer_custody_required' } });
        expect(lifecycle.getState().publishedTransferCount).toBe(0);
        return;
      }
      expect(result, JSON.stringify(result)).toMatchObject({ status: 'executed', value: { success: true, status: 'accepted', destinationId: destination.destinationId } });
      expect(approvals).toBe(surface === 'plugin' ? 0 : 1);
      expect(publicationSignal?.aborted).toBe(true);
      expect(lifecycle.getState().publishedTransferCount).toBe(1);
      if (result.status !== 'executed') throw new Error('Expected accepted source');
      const receipt = FilesystemDownloadOutputSchema.parse(result.value);
      expect(JSON.stringify(receipt)).not.toContain('137,80');
      if ('retire' in scenario) registry.dispose();
      if ('revoke' in scenario) accountCurrent = false;
      const receiver = createPreparedFilesystemTransferClient({ executeAction: async () => ({ ok: true, result: receipt }),
        openMachineTunnel: async () => ({ localPort: await lifecycle.ensureListening(), observedPath: 'direct', close: async () => {} }) });
      const downloaded = await receiver.download({ targetMachineId: 'machine', rootPath: directory, path: 'unused', asZip: false,
        destinationId: destination.destinationId, destinationPath: join(directory, 'received.bin') });
      if ('retire' in scenario || 'revoke' in scenario) expect(downloaded).toMatchObject({ success: false, status: 'failed' });
      else {
        expect(downloaded).toMatchObject({ success: true, status: 'completed', sha256 });
        expect(await readFile(join(directory, 'received.bin'))).toEqual(Buffer.from(bytes));
      }
      expect(lifecycle.getState().publishedTransferCount).toBe(0);
    } finally { registry.dispose(); await lifecycle.stop(); await rm(directory, { recursive: true, force: true }); }
  });
});
