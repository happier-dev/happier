// Register the fixture's authenticated Home/control boundaries before consumers capture them.
import { createAttachedManagedRunFixture } from './startDaemonSessionControlRuntime.accountManagedRun.testkit';
import { expect, it, onTestFailed } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { PluginProtocolClientHandle } from '@happier-dev/plugin-sdk/exec/protocol-clients';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { createStablePluginExecService } from '@/plugins/runtime/invocation/services/exec';
import { readSupervisedPluginProcessIdForHost } from '@/plugins/runtime/exec/processSupervisor';
import { configureLanguageServerHost, disposeLanguageServerHost, getLanguageServerHost } from '@/lsp/languageServerHost';
import { readProcessOwnershipBootTimeMs } from '@/daemon/processes/roots/listHappierProcessRoots';
import { projectMachineProcesses } from '@/daemon/processes/view/projectMachineProcesses';
import { createProcessActionOwnerAdapters } from '@/daemon/processes/actions/processActionOwnerAdapters';
import { createProcessActionExecutor } from '@/daemon/processes/actions/processActionExecutor';
import { resolveProcessOwnerRequester } from '@/daemon/processes/ownership/resolveProcessOwnerRequester';
import { processRef } from '@/daemon/processes/view/processRef';
import { registerLanguageIntelligenceHandlers } from '@/rpc/handlers/languageIntelligence';
import type { RpcHandler, RpcHandlerContext } from '@/api/rpc/types';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { SocketRpcMachineAdmissionContextV1Schema } from '@happier-dev/protocol/socketRpc';
import { RequesterWorkAttributionV1Schema } from '@/daemon/lifecycle/requesterWorkAttribution';
import { MachineProcessesStopInputV1Schema } from '@happier-dev/protocol/machines/processes/machineProcessesV1';

it('projects admitted language-server Home identity across routing aliases through the real requester resolver and Processes control', async () => {
    let phase = 'create startup fixture';
    onTestFailed(() => { console.info('Language-server Process fixture phase:', phase); });
    const startup = await createAttachedManagedRunFixture();
    try {
    for (const ingress of ['machine', 'local', 'unattributed'] as const) {
    let handle: PluginProtocolClientHandle<'jsonRpc'> | undefined;
    try {
        phase = `${ingress}: configure native host`;
        const rootPath = startup.directory;
        const log = join(rootPath, 'lsp-messages.jsonl');
        await writeFile(log, '');
        const registry = createResolvedContributionRegistry({ languageServers: [{
            provenance: 'external', source: { kind: 'path' }, pluginId: 'fixture.language',
            identity: { pluginId: 'fixture.language', localId: 'language' }, manifestPath: join(rootPath, 'plugin.json'),
            definition: { id: 'language', title: 'Fixture language', languageIds: { typescript: 'typescript' },
                executable: { kind: 'systemTool', id: 'native' }, args: [] },
        }] });
        configureLanguageServerHost({ readCurrentContributionRegistry: () => registry, async openProtocol(input) {
            // Only the executable/OS boundary is supplied; native custody and Processes stay real.
            const exec = createStablePluginExecService({
                signal: input.signal, processOwner: input.processOwner, isOccurrenceCurrent: () => !input.signal.aborted,
                resolveExecutable: async () => ({ command: process.execPath, args: [resolve('src/lsp/__fixtures__/languageServer.cjs'), log] }),
                resolvePath: async () => rootPath });
            handle = await exec.clients.spawn({ kind: 'jsonRpc', framing: 'contentLength', cancellationMethod: '$/cancelRequest',
                launch: { executable: input.definition.executable, cwd: rootPath } });
            return handle;
        } });
        // These are authenticated Home / host-private Action boundary facts,
        // not caller input or a substitute for the real requester resolver.
        const attribution = RequesterWorkAttributionV1Schema.parse({ serverId: 'srv_language_home', accountId: 'account',
            machineId: startup.fixture.machineId, installationId: 'installation' });
        const { accountId, ...target } = attribution;
        const handlers = new Map<string, RpcHandler>();
        const registration = { machineId: target.machineId, serverId: 'daemon-local-language-profile',
            resolveHomeServerIdentityId: async () => target.serverId };
        registerLanguageIntelligenceHandlers({ registerHandler(method, handler) { handlers.set(method, handler); } }, rootPath,
            registration);
        const rpcContext: RpcHandlerContext = { signal: new AbortController().signal,
            ...(ingress === 'machine' ? {
                machineAdmission: SocketRpcMachineAdmissionContextV1Schema.parse({ actorAccountId: accountId, custodianAccountId: accountId,
                    machineId: target.machineId, installationId: target.installationId, role: 'use', encryptionMode: 'plain' }),
                verifyMachineAdmissionCurrent: async () => true,
                localActionContext: { requesterWorkAttributionV1: { ...attribution, accountId: 'another-account' } },
            } : ingress === 'local' ? { localActionContext: { requesterWorkAttributionV1: attribution } } : {}),
        };
        const host = getLanguageServerHost();
        if (ingress === 'machine') {
            expect(await handlers.get(RPC_METHODS.DAEMON_LSP_SYNC)!({ rootPath,
                op: { op: 'open', path: 'a.ts', languageId: 'typescript', text: 'shared', version: 1, unsaved: false },
                requesterWorkAttributionV1: { ...attribution, accountId: 'another-account' },
            }, rpcContext)).toMatchObject({ status: 'error', errorCode: 'invalid_request' });
            expect(handle).toBeUndefined();
        }
        const opening = { rootPath, op: { op: 'open', path: 'a.ts', languageId: 'typescript', text: 'shared', version: 1, unsaved: false } };
        // This host-private local stamp is not filesystem admission. The real
        // credentialed ApiMachine Action entry is covered by its installed
        // native test, not an unconfigured client without a Home boundary.
        phase = `${ingress}: registered open`;
        const opened = await handlers.get(RPC_METHODS.DAEMON_LSP_SYNC)!(opening, rpcContext);
        expect(opened, JSON.stringify({ ingress, opened }))
            .toMatchObject({ status: 'ok', servers: [{ state: 'ready' }] });
        if (!handle) throw new Error('Language server did not start');
        const pid = readSupervisedPluginProcessIdForHost(handle.process);
        phase = `${ingress}: native census`;
        const read = await startup.runtime.processOwnershipRuntime.readOwners({ freshness: 'fresh', requesterAttribution: 'retained' });
        expect(read.status).toBe('ok');
        if (read.status !== 'ok') throw new Error('Native process ownership unavailable');
        const root = read.roots.find(candidate => candidate.pid === pid);
        expect(root).toMatchObject({ owner: { kind: 'service', serviceId: expect.stringMatching(/^lsp:/) }, live: true });
        const requesterForOwner: Parameters<typeof createProcessActionExecutor>[0]['requesterForOwner'] = (owner, roots) =>
            resolveProcessOwnerRequester(owner, roots, { target, custodianAccountId: accountId });
        const projectionOptions = {
                platform: process.platform as 'linux' | 'darwin' | 'win32', selfPid: process.pid, allProcessesVisible: true,
                bootTimeMs: await readProcessOwnershipBootTimeMs(), confirmed: [], requesterForOwner,
            };
        const answer = projectMachineProcesses(read, { machineId: target.machineId, scope: 'happier', view: 'tree' },
            { accountId, custodianAccountId: accountId }, projectionOptions);
        const member = answer.owners.flatMap(owner => owner.members).find(row => row.pid === pid);
        const foreign = projectMachineProcesses(read, { machineId: target.machineId, scope: 'happier', view: 'tree' },
            { accountId: 'another-account', custodianAccountId: accountId }, projectionOptions);
        expect(foreign.owners.flatMap(owner => owner.members).some(row => row.pid === pid)).toBe(false);
        if (!root) throw new Error('Missing language-server root');
        const executor = createProcessActionExecutor({ ownership: startup.runtime.processOwnershipRuntime,
            leftBehind: { confirmed: () => [] }, allProcessesVisible: () => false, requesterForOwner,
            ...createProcessActionOwnerAdapters({}) });
        const native = read.rows.find(row => row.pid === pid);
        if (!native) throw new Error('Missing native language-server ownership');
        const stopRequest = MachineProcessesStopInputV1Schema.parse({ machineId: target.machineId, targets: [{ ref: processRef(root.pid, root.start),
            expect: { level: native.level, owner: root.owner } }] });
        phase = `${ingress}: foreign Account Process Stop`;
        expect(await executor.executeStop(stopRequest, { accountId: 'another-account', isCustodian: false },
            { verifyCurrent: async () => true })).toMatchObject({ status: 'refused' });
        if (ingress === 'unattributed') {
            phase = `${ingress}: refuse Process Stop`;
            expect(member).toBeUndefined();
            expect(requesterForOwner(root.owner, read.roots)).toBeNull();
            expect(await executor.executeStop(stopRequest, { accountId, isCustodian: false },
                { verifyCurrent: async () => true })).toMatchObject({ status: 'refused' });
            continue;
        }
        expect(member).toMatchObject({ role: 'language_server' });
        expect(root).toMatchObject({ requesterWorkAttributionV1: attribution });
        phase = `${ingress}: owner Process Stop`;
        expect(await executor.executeStop(stopRequest, { accountId, isCustodian: false },
            { verifyCurrent: async () => true })).toMatchObject({ status: 'ended' });
        phase = `${ingress}: native child exit`;
        await handle.wait();
        phase = `${ingress}: stopped document query`;
        expect(await host.query({ rootPath, path: 'a.ts', kind: 'hover', position: { line: 0, character: 0 } }))
            .toMatchObject({ status: 'error', errorCode: 'session_unavailable' });
    } finally {
        phase = `${ingress}: host disposal`;
        await disposeLanguageServerHost();
        phase = `${ingress}: disposed child exit`;
        await handle?.wait();
    }
    }
    } finally { phase = 'startup fixture cleanup'; await startup.cleanup(); }
});
