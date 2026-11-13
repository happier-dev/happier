import { afterEach, expect, it, vi } from 'vitest';
import { DaemonPluginUiTargetedContributionsReadRequestSchema, DaemonPluginUiTargetedContributionsReadResponseSchema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { createAccountMachineSourceDeclarationReader } from './accountMachineSourceDeclarations';
import type { callExactMachineRpc } from '@/session/transport/rpc/machineRpc';

const { machineRpc } = vi.hoisted(() => ({ machineRpc: vi.fn<typeof callExactMachineRpc>() }));
// The Machine RPC is the network boundary; all declaration admission stays real.
vi.mock('@/session/transport/rpc/machineRpc', () => ({ callExactMachineRpc: machineRpc }));
afterEach(() => { vi.restoreAllMocks(); machineRpc.mockReset(); });
const authority = { credentials: { token: 'owner', encryption: null, credentialProvenance: 'stored_session' as const }, serverUrl: 'http://home.test' };
const selection = { machineId: 'machine-a', targetPluginId: 'acme.target' };
const declaration = { manifest: { id: 'acme.target', contributes: { actions: [], pluginContributionPoints: [], targetedPluginContributions: [], ui: { renderers: [] } } },
    occurrenceId: 'occurrence-a', sourceCustody: { kind: 'development', registeredRootId: 'root-a' } };

it('shares cold and warm reads and admits one body per changed revision', async () => {
    const parse = vi.spyOn(DaemonPluginUiTargetedContributionsReadResponseSchema, 'parse');
    let revision = 'revision-a';
    let present = true;
    machineRpc.mockImplementation(async input => {
        const request = DaemonPluginUiTargetedContributionsReadRequestSchema.parse(input.request);
        return request.knownSourceRevision === revision
            ? { status: 'sourceDeclarationsUnchanged', pluginId: request.pluginId, sourceRevision: revision }
            : { status: 'sourceDeclarations', pluginId: request.pluginId, sourceRevision: revision, sourceDeclarations: present ? [declaration] : [] };
    });
    const read = createAccountMachineSourceDeclarationReader(authority);
    const batch = () => Promise.all(Array.from({ length: 4 }, () => read(selection)));
    const bodies = () => parse.mock.results.filter(result => result.type === 'return' && result.value.status === 'sourceDeclarations').length;
    const cold = await batch();
    expect(machineRpc).toHaveBeenCalledTimes(1);
    expect(bodies()).toBe(1);
    expect(cold.every(value => value === cold[0])).toBe(true);
    const warm = await batch();
    expect(machineRpc).toHaveBeenCalledTimes(2);
    expect(bodies()).toBe(1);
    expect(warm[0]).toBe(cold[0]);
    revision = 'revision-b';
    await batch();
    expect(machineRpc).toHaveBeenCalledTimes(3);
    expect(bodies()).toBe(2);
    revision = 'revision-retired'; present = false;
    expect(await read(selection)).toEqual({ declarations: [] });
    expect(bodies()).toBe(3);
});

it('isolates selected Machines and sources and never serves retained declarations on failure', async () => {
    const read = createAccountMachineSourceDeclarationReader(authority);
    machineRpc.mockImplementation(async input => {
        const request = DaemonPluginUiTargetedContributionsReadRequestSchema.parse(input.request);
        expect(request.knownSourceRevision).toBeUndefined();
        return { status: 'sourceDeclarations', pluginId: request.pluginId, sourceRevision: 'a', sourceDeclarations: [declaration] };
    });
    await read(selection);
    await read({ ...selection, machineId: 'machine-b' });
    await read({ ...selection, sourcePluginId: 'acme.target' });
    machineRpc.mockResolvedValueOnce({ status: 'unavailable', code: 'source-unavailable' });
    await expect(read(selection)).rejects.toMatchObject({ code: 'source-unavailable' });
    await read(selection);
    expect(machineRpc).toHaveBeenCalledTimes(5);
});

it('keeps shared reads alive for remaining callers and aborts transport when all callers cancel', async () => {
    let complete: ((result: unknown) => void) | undefined;
    let transportSignal: AbortSignal | undefined;
    machineRpc.mockImplementation(input => new Promise(resolve => { complete = resolve; transportSignal = input.signal; }));
    const read = createAccountMachineSourceDeclarationReader(authority);
    const first = new AbortController(); const second = new AbortController();
    const a = read({ ...selection, signal: first.signal });
    const b = read({ ...selection, signal: second.signal });
    first.abort();
    await expect(a).rejects.toMatchObject({ name: 'AbortError' });
    expect(transportSignal?.aborted).toBe(false);
    complete?.({ status: 'sourceDeclarations', pluginId: selection.targetPluginId, sourceRevision: 'a', sourceDeclarations: [] });
    expect(await b).toEqual({ declarations: [] });
    const cancel = new AbortController();
    const cancelled = read({ ...selection, signal: cancel.signal });
    cancel.abort();
    await expect(cancelled).rejects.toMatchObject({ name: 'AbortError' });
    expect(transportSignal?.aborted).toBe(true);
    complete?.({ status: 'sourceDeclarations', pluginId: selection.targetPluginId, sourceRevision: 'stale', sourceDeclarations: [declaration] });
    machineRpc.mockResolvedValueOnce({ status: 'sourceDeclarations', pluginId: selection.targetPluginId, sourceRevision: 'fresh', sourceDeclarations: [] });
    expect(await read(selection)).toEqual({ declarations: [] });
});
