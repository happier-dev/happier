import { ByocLaunchV1Schema } from './remoteSchemas.js';
import { MachineProvisionerOptionsResultV1Schema } from '@happier-dev/plugin-sdk/machine-provisioners';
import { projectMachineProvisionerSelectionV1 } from '@happier-dev/plugin-sdk/machine-provisioners';
import { describe, expect, it } from 'vitest';
import type { PluginApi, PluginInvocationContext } from '@happier-dev/plugin-sdk';
import type { ActionHandler } from '@happier-dev/plugin-sdk/actions';
import type { PluginExecSpawnRequest, PluginProcessResult } from '@happier-dev/plugin-sdk/exec';
import { CUA_PLUGIN } from '../manifest.js';
import type { ConnectedAccountReadContext } from '@happier-dev/plugin-sdk/connected-accounts';
import { connectedAccountRuntime } from './remoteConnection.js';
import { parsePluginManifest } from '@happier-dev/plugin-sdk/manifest';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createPluginTestkit, type PluginTestServicesFixture } from '@happier-dev/plugin-sdk/testing';

const managedId = 'ac2c7f10-2a41-4af1-88ac-d64eeb18bdc7';
const name = `happier-${managedId}`;
const byocLaunch = { cloud: 'aws', region: 'us-west-2', nativeImageId: 'linux', nativeSizeId: 't3.medium', nativeLifetime: { kind: 'no-native-ttl' } };
const nativeProvider = { name: 'aws', connected: true, region: 'us-west-2', ttl_hours: 0,
    kinds: [{ image: 'linux', supported: true, machine_type: 't3.medium', usd_per_hour: 0.04 }] };
function processResult(value: unknown): PluginProcessResult {
    return { termination: { observed: { kind: 'exit', exitCode: 0 }, requestedBy: { kind: 'none' } }, stdout: new TextEncoder().encode(JSON.stringify(value)),
        stderr: new Uint8Array(), stdoutTruncated: false, stderrTruncated: false };
}
async function harness(options: { lostCreateReply?: boolean; cleanupFailure?: 'registry' | 'delete-reply'; cliVersion?: string;
    cliMissing?: boolean; cliStatusFailed?: boolean; noAccount?: boolean; cloudConnected?: boolean; cloudStatusUnreadable?: boolean } = {}) {
    const actions = new Map<string, ActionHandler>();
    const processRequests: PluginExecSpawnRequest[] = [];
    const copiedBytes: Buffer[] = [];
    const purposes: string[] = [];
    let created = false, suspended = false;
    let hideCreatedOnce = false;
    const row = { provider: 'aws', id: 'i-owned', type: 'instance', sandbox: `aws:${name}`,
        machine: options.cleanupFailure ? 'relay-owned' : '', region: 'us-west-2', state: 'running', expires: '', expired: false };
    // Registration, captured accounts and native processes are external host
    // boundaries. Author schemas and leaf logic stay real.
    await CUA_PLUGIN.activate({ actions: { register(id: string, handler: ActionHandler) { actions.set(id, handler); return { dispose() {} }; } },
        connectedAccounts: { register() { return { dispose() {} }; } } } as unknown as PluginApi);
    const context = { invokedAtMs: Date.parse('2026-10-09T00:30:00Z'), signal: new AbortController().signal, services: {
        managedServices: { dependencies: { status: async () => options.cliMissing ? { state: 'missing' } : options.cliStatusFailed ? { state: 'failed', code: 'timed_out' } : ({ state: 'ready', version: options.cliVersion ?? '0.5.0', executable: { kind: 'managedDependency', id: { pluginId: CUA_PLUGIN.manifest.id, localId: 'cua-cli' } } }) } },
        connectedAccounts: {
            async materialize(purpose: string, request: { kind: string; keys?: readonly string[] }) {
                purposes.push(purpose);
                // The host refuses an unbound purpose with this typed code (machineProvisioners.test.ts).
                if (options.noAccount) throw Object.assign(new Error('Account material is unavailable'), { code: 'credential_unavailable' });
                return { kind: 'environment', env: request.keys?.includes('CUA_CREDENTIAL_STORE')
                    ? { CUA_HOME: '/native/selected', CUA_CREDENTIAL_STORE: 'file' } : { CUA_HOME: '/native/selected' } };
            },
        },
        exec: { async run(request: PluginExecSpawnRequest) {
            processRequests.push(request);
            const args = request.args ?? [];
            if (args.includes('status')) {
                if (options.cloudStatusUnreadable) throw new Error('Native status unavailable');
                if (options.cloudConnected === false) return processResult({ providers: [{ ...nativeProvider, connected: false }], resources: [] });
                const resources = created && !hideCreatedOnce ? [row] : [];
                hideCreatedOnce = false;
                return processResult({ providers: [nativeProvider], resources });
            }
            if (args.includes('create')) {
                created = true;
                if (options.lostCreateReply) { hideCreatedOnce = true; throw new Error('Create response lost'); }
                return processResult({});
            }
            if (args.includes('images')) return processResult({ ref: 'ghcr.io/trycua/linux:24.04', published: true });
            if (args.includes('suspend')) { suspended = true; return processResult('Suspending'); }
            if (args.includes('info')) {
                if (!created) throw new Error('Native sandbox record not found');
                return processResult({ id: `aws:${name}`, name, location: 'aws', state: suspended ? 'suspended' : 'running',
                    status: suspended ? 'stopped' : 'ready', image: 'ghcr.io/trycua/linux:24.04',
                    ephemeral: false, expires_at: null, provider_details: { provider: 'aws', id: 'i-owned' } });
            }
            if (args.includes('ls') && args.includes('spaces')) throw new Error('Native registry read unavailable');
            if (args.includes('rm') && args.includes('sandbox')) {
                created = false;
                if (options.cleanupFailure === 'delete-reply') throw new Error('Delete response lost');
                return processResult({ deleted: `aws:${name}`, missing: false });
            }
            if (args.includes('cp')) {
                const content = await readFile(args[args.indexOf('cp') + 1]!);
                copiedBytes.push(content);
                return processResult({ direction: 'upload', size: content.length, sha256: createHash('sha256').update(content).digest('hex') });
            }
            if (args.includes('shell')) return { ...processResult(null), stdout: args.at(-1)?.startsWith('mktemp -d')
                ? new TextEncoder().encode('/tmp/happier-cua.byoc-action\n') : new Uint8Array([0, 128, 255]) };
            throw new Error('Unexpected native IO');
        } },
    } } as unknown as PluginInvocationContext;
    async function invoke(id: string, input: unknown) {
        const action = actions.get(id);
        if (!action) throw new Error(`Missing activated role ${id}`);
        return action(input, context);
    }
    return { invoke, context, processRequests, copiedBytes, purposes };
}

describe('activated Cua remote contributions', () => {
    it('writes shared-admitted padding bits exactly through the BYOC file Action', async () => {
        const h = await harness();
        const acquired = await h.invoke('byoc-acquire', { launch: byocLaunch, managedId });
        if (acquired.kind !== 'bound') throw new Error('Expected bound native fixture');
        const kit = await createPluginTestkit({ manifest: CUA_PLUGIN.manifest, module: CUA_PLUGIN,
            services: h.context.services as unknown as PluginTestServicesFixture });
        try {
            const input = { resource: acquired.resource.value, guestPath: '/tmp/bootstrap-binary', bytesBase64: 'AB==', mode: 384 };
            expect(await kit.invokeAction('byoc-put-file', input, { surface: 'plugin' })).toEqual({ kind: 'confirmed' });
            expect(h.copiedBytes).toEqual([Buffer.from([0])]);
            await expect(kit.invokeAction('byoc-put-file', { ...input, bytesBase64: 'AA==\n' }, { surface: 'plugin' })).rejects.toThrow();
            expect(h.copiedBytes).toHaveLength(1);
        } finally { await kit.dispose(); }
    });
    it('admits exactly the local and BYOC native provisioners with localized kind and purpose at the public authoring boundary', () => {
        expect(parsePluginManifest(CUA_PLUGIN.manifest)).toMatchObject({ ok: true });
        const provisioners = CUA_PLUGIN.manifest.contributes.machineProvisioners ?? [];
        expect(provisioners.map(provisioner => provisioner.id).sort()).toEqual(['byoc', 'local-sandbox', 'local-space']);
        // Cua Cloud and Fleets ended 2026-10-18: no gateway network access or Fleet token mode remains.
        expect(CUA_PLUGIN.manifest.hostAccess?.required.some(access => access.capability === 'network')).toBe(false);
        for (const provisioner of provisioners) {
            expect(provisioner.kindTitle).toMatchObject({ key: expect.stringMatching(/^machineCua\.presentation\./) });
            expect(provisioner.description).toMatchObject({ key: expect.stringMatching(/^machineCua\.presentation\./) });
        }
    });
    it('selects native setup from revision-tracked configuration, never a rotating credential field', async () => {
        const context = { configuration: { values: { nativeHome: '/native/selected' } },
            credentials: { async get(key: string) { return key === 'native-home' ? '/native/different' : null; } } } as unknown as ConnectedAccountReadContext;
        for (const kind of ['cloud', 'cua'] as const) {
            expect(await connectedAccountRuntime(kind).materialize({ kind: 'environment', keys: ['CUA_HOME'] }, context))
                .toEqual({ kind: 'environment', env: { CUA_HOME: '/native/selected' } });
            expect(Object.keys(connectedAccountRuntime(kind).authentication.modes)).toEqual(['native']);
            await expect(connectedAccountRuntime(kind).materialize({ kind: 'environment', keys: ['FLEETS_TOKEN'] }, context)).rejects.toThrow('cua_connection_unavailable');
        }
    });
    it('names each connected native account once: service title, completion and status agree', async () => {
        const context = { configuration: { values: { nativeHome: '/native/selected' } }, credentials: { async get() { return null; } } } as unknown as ConnectedAccountReadContext;
        const declared = { cloud: 'cloud-native', cua: 'cua-account' } as const;
        for (const kind of ['cloud', 'cua'] as const) {
            const title = CUA_PLUGIN.manifest.contributes.connectedAccountDescriptors?.find(entry => entry.id === declared[kind])?.title;
            expect(await connectedAccountRuntime(kind).status(context)).toMatchObject({ status: 'connected', displayName: title });
        }
    });
    it('fails BYOC check for a cua CLI older than the first release with every flag called, before any native call', async () => {
        const h = await harness({ cliVersion: '0.2.9' });
        expect(await h.invoke('byoc-check', {})).toMatchObject({ available: false, code: 'cua_native_outdated' });
        expect(h.processRequests).toEqual([]);
    });
    it('tells BYOC check apart: no account to connect, cua missing, cloud not connected, status unreadable, and a usable account', async () => {
        const check = async (options: Parameters<typeof harness>[0]) => {
            const h = await harness(options);
            return { result: await h.invoke('byoc-check', {}), processRequests: h.processRequests };
        };
        // Host-typed refusal of an unbound purpose and a native cloud with no connected provider are both "connect an account".
        expect((await check({ noAccount: true })).result).toMatchObject({ available: false, code: 'credential_unavailable' });
        expect((await check({ cloudConnected: false })).result).toMatchObject({ available: false, code: 'credential_unavailable' });
        // Missing `cua` is its own state (not "Connection unavailable"), and failing to read the native status is not "no account".
        expect((await check({ cliMissing: true })).result).toMatchObject({ available: false, code: 'cua_native_unavailable' });
        expect((await check({ cloudStatusUnreadable: true })).result).toMatchObject({ available: false, code: 'cua_connection_unavailable' });
        const connected = await check({});
        expect(connected.result).toMatchObject({ available: true, status: { key: 'machineCua.presentation.ready' } });
        // The one read is the unfiltered cloud status, never a provider-specific or mutating command.
        expect(connected.processRequests.map(request => request.args)).toEqual([['--json', '--embedded', 'cloud', 'status']]);
    });
    it('local check says "not installed" only for a missing cua; an unreadable dependency status fails the check instead', async () => {
        expect(await (await harness({ cliMissing: true })).invoke('sandbox-check', {})).toMatchObject({ available: false, code: 'cua_native_unavailable' });
        await expect((await harness({ cliStatusFailed: true })).invoke('sandbox-check', {})).rejects.toThrow('cua_native_status_unreadable');
    });
    it('acquires and privately bootstraps exact BYOC compute with both captured purposes and deletes only that created identity', async () => {
        const h = await harness();
        expect(await h.invoke('byoc-check', {})).toMatchObject({ available: true, status: { key: 'machineCua.presentation.ready' } });
        const options = MachineProvisionerOptionsResultV1Schema.parse(await h.invoke('byoc-options', { cloud: 'aws' }));
        expect(projectMachineProvisionerSelectionV1({ options, launchSchema: ByocLaunchV1Schema.jsonSchema,
            selection: { size: 't3.medium', image: 'linux', location: 'us-west-2' } })).toMatchObject({ kind: 'ready', launch: byocLaunch, nativeFacts: {
            size: { id: 't3.medium' }, image: { id: 'linux' }, location: { id: 'us-west-2' },
        } });
        const acquired = await h.invoke('byoc-acquire', { launch: byocLaunch, managedId });
        const resource = { cloud: 'aws', nativeResourceId: 'i-owned', sandboxId: `aws:${name}`, ownedAttachmentIds: [] };
        expect(acquired).toMatchObject({ kind: 'bound', resource: { value: resource } });
        expect(await h.invoke('byoc-bootstrap', { resource })).toMatchObject({ kind: 'native', transport: { contributionRef: { localId: 'byoc' } } });
        expect(await h.invoke('byoc-reconcile', { correlation: { managedId, requestId: 'submitted', launch: byocLaunch } }))
            .toMatchObject({ kind: 'bound', resource: { value: resource } });
        expect(await h.invoke('byoc-exec', { resource, argv: ['printf', 'native'], timeoutMs: 987654 })).toMatchObject({ stdoutBase64: 'AID/' });
        expect(h.processRequests.find(request => request.args?.includes('shell'))).toMatchObject({ timeoutMs: 987654 });
        expect(new Set(h.purposes)).toEqual(new Set(['cloud-account', 'cua-account']));
        expect(h.processRequests.every(request => request.env?.CUA_HOME === '/native/selected')).toBe(true);
        expect(await h.invoke('byoc-destroy', { resource })).toEqual({ kind: 'confirmed' });
        expect(h.processRequests.filter(request => request.args?.includes('rm')).map(request => request.args)).toEqual([
            ['--json', '--embedded', 'sandbox', 'rm', `aws:${name}`, '--force'],
        ]);
    });
    it('cancels the exact pending BYOC allocation after alias resolution and a lost create reply', async () => {
        const h = await harness({ lostCreateReply: true });
        const acquired = await h.invoke('byoc-acquire', { launch: byocLaunch, managedId });
        expect(acquired).toMatchObject({ kind: 'pending' });
        if (acquired.kind !== 'pending') throw new Error('Expected retained operation');
        expect(await h.invoke('byoc-destroy', { nativeOperation: acquired.nativeOperationRef.value })).toEqual({ kind: 'confirmed' });
        expect(h.processRequests.filter(request => request.args?.includes('create'))).toHaveLength(1);
        expect(h.processRequests.filter(request => request.args?.includes('rm')).map(request => request.args))
            .toEqual([['--json', '--embedded', 'sandbox', 'rm', `aws:${name}`, '--force']]);
    });
    it('confirms retained Stop from the native suspended observation', async () => {
        const h = await harness();
        await h.invoke('byoc-acquire', { launch: byocLaunch, managedId });
        const resource = { cloud: 'aws', nativeResourceId: 'i-owned', sandboxId: `aws:${name}`, ownedAttachmentIds: [] };
        expect(await h.invoke('byoc-power', { resource, intent: 'stop' })).toEqual({ kind: 'confirmed' });
        expect(await h.invoke('byoc-inspect', { resource })).toMatchObject({ availability: 'present', power: 'stopped' });
    });
    it.each(['registry', 'delete-reply'] as const)('keeps cleanup unconfirmed after %s failure consumes native qualification records (CD9)', async cleanupFailure => {
        const h = await harness({ cleanupFailure });
        const acquired = await h.invoke('byoc-acquire', { launch: byocLaunch, managedId });
        expect(acquired).toMatchObject({ kind: 'bound' });
        if (acquired.kind !== 'bound') throw new Error('Expected exact retained resource');
        const resource = acquired.resource.value;
        expect(await h.invoke('byoc-destroy', { resource })).toEqual({ kind: 'unknown', code: 'cua_cleanup_incomplete' });
        const retryStart = h.processRequests.length;
        expect(await h.invoke('byoc-destroy', { resource })).toEqual({ kind: 'unknown', code: 'cua_cleanup_incomplete' });
        expect(await h.invoke('byoc-inspect', { resource })).toMatchObject({ availability: 'unavailable' });
        // The caller retains vendor ID/cloud and reviewed region for the existing
        // recovery detail/manual-responsibility path; absence is never inferred.
        expect(resource).toMatchObject({ cloud: 'aws', nativeResourceId: 'i-owned',
            sandboxId: `aws:${name}`, spaceId: 'relay:relay-owned' });
        expect(h.processRequests.slice(retryStart).every(request => request.args?.includes('status'))).toBe(true);
        expect(h.processRequests.filter(request => request.args?.includes('rm')).map(request => request.args))
            .toEqual([['--json', '--embedded', 'sandbox', 'rm', `aws:${name}`, '--force']]);
        expect(h.processRequests.some(request => request.args?.includes('sweep'))).toBe(false);
    });
  it('qualifies the offered BYOC launch through its registered acquire role', async () => {
        const h = await harness();
        const options = MachineProvisionerOptionsResultV1Schema.parse(await h.invoke('byoc-options', { cloud: 'aws' }));
        const selected = projectMachineProvisionerSelectionV1({ options, launchSchema: ByocLaunchV1Schema.jsonSchema,
            selection: { size: 't3.medium', image: 'linux', location: 'us-west-2' } });
        expect(selected).toMatchObject({ kind: 'ready', launch: byocLaunch,
            retention: { supportedIntents: ['start', 'stop', 'delete'], finiteOnly: false } });
        if (selected.kind !== 'ready') throw new Error('Expected complete native selection');
        expect(await h.invoke('byoc-acquire', { launch: selected.launch, managedId })).toMatchObject({ kind: 'bound', resource: { value: {
            cloud: 'aws', nativeResourceId: 'i-owned', sandboxId: `aws:${name}`,
        } } });
        expect(h.processRequests.find(request => request.args?.includes('create'))?.args).toContain(`--name=${name}`);
    });

});
