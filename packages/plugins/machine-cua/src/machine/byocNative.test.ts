import { describe, expect, it } from 'vitest';
import type { PluginProcessResult } from '@happier-dev/plugin-sdk/exec';
import { createCuaNativeClient } from './nativeClient.js';
import { createCuaByoc } from './byoc.js';

const launch = { cloud: 'aws', region: 'us-west-2', nativeImageId: 'linux', nativeSizeId: 't3.medium',
    nativeLifetime: { kind: 'no-native-ttl' } };
const provider = { name: 'aws', connected: true, region: 'us-west-2', ttl_hours: 0,
    kinds: [{ image: 'linux', supported: true, machine_type: 't3.medium', usd_per_hour: 0.0416 }] };
const row = { provider: 'aws', id: 'i-owned', type: 'instance', sandbox: 'aws:owned', machine: 'cloud-owned',
    region: 'us-west-2', state: 'running', expires: '', expired: false };
const resource = { cloud: 'aws', nativeResourceId: 'i-owned', sandboxId: 'aws:owned',
    spaceId: 'relay:cloud-owned', ownedAttachmentIds: [] };
const info = { id: 'aws:owned', name: 'owned', location: 'aws', status: 'ready', state: 'running',
    image: 'linux', ephemeral: false, expires_at: null, endpoints: { secret: 'private' },
    provider_details: { provider: 'aws', id: 'i-owned' } };
const status = { providers: [provider], resources: [row] };
const emptyStatus = { ...status, resources: [] };

// Genuine process boundary; schemas, launch qualification, identity and cleanup
// execute through the real single Cua client.
function harness(...values: unknown[]) {
    const argv: string[][] = [];
    const native = createCuaNativeClient({ executable: { kind: 'systemTool', id: 'cua' }, exec: {
        async run(request): Promise<PluginProcessResult> {
            argv.push([...(request.args ?? [])]);
            const value = values.shift();
            if (value instanceof Error) throw value;
            if (value === undefined) throw new Error('Unexpected process request');
            return { termination: { observed: { kind: 'exit', exitCode: 0 }, requestedBy: { kind: 'none' } },
                stdout: new TextEncoder().encode(JSON.stringify(value)), stderr: new Uint8Array(),
                stdoutTruncated: false, stderrTruncated: false };
        },
    } });
    return { argv, byoc: createCuaByoc(native) };
}

describe('Cua BYOC native operations', () => {
    it('projects source-timed configured choices without inventing cloud setup or a price', async () => {
        const h = harness(status);
        expect(await h.byoc.options('aws', 1234)).toEqual({ choices: [{
            id: 'linux:t3.medium', title: { key: 'machineCua.byoc.nativeChoice', fallback: 'linux · t3.medium' },
            launch, available: true, nativeFacts: { size: { id: 't3.medium', title: 't3.medium' },
                image: { id: 'linux', title: 'linux' }, location: { id: 'us-west-2', title: 'us-west-2' } },
            prices: [{ amount: '0.0416', currency: 'USD', unit: 'hour',
                source: 'cua-native-cloud-status', observedAt: 1234 }],
        }] });
        expect(h.argv).toEqual([['--json', '--embedded', 'cloud', 'status', 'aws']]);
        const unsupported = harness({ ...status, providers: [{ ...provider, name: 'modal', ttl_hours: 0 }] });
        expect(await unsupported.byoc.options('modal', 1234)).toEqual({ choices: [] });
        const denied = harness(new Error('private authorization details'));
        await expect(denied.byoc.options('aws', 1234)).rejects.toMatchObject({ code: 'native_options_unavailable' });
    });
    it('binds real vendor observations to the family without treating failed reads as absence', async () => {
        const h = harness(status, { ...info, expires_at: '2026-10-08T13:00:00Z' });
        expect(await h.byoc.observe(resource, 1234)).toEqual({ observedAt: 1234, availability: 'present',
            power: 'running', billing: { location: 'cloud', stoppedBilling: 'not-billed' },
            nativeExpiry: Date.parse('2026-10-08T13:00:00Z') });
        const denied = harness(status, new Error('native bearer private'));
        expect(await denied.byoc.observe(resource, 1234)).toEqual({ observedAt: 1234, availability: 'unavailable',
            power: 'unknown', reason: 'native_resource_unknown' });
        const missing = harness(status, { ...info, state: 'gone' });
        expect(await missing.byoc.observe(resource, 1234)).toEqual({ observedAt: 1234, availability: 'absent', power: 'unknown' });
    });
    it('qualifies before creation, explicitly selects the cloud and retains exact ownership', async () => {
        const h = harness(emptyStatus, info, status);
        expect(await h.byoc.create(launch, 'owned')).toEqual({ kind: 'bound', resource });
        expect(h.argv).toEqual([
            ['--json', '--embedded', 'cloud', 'status', 'aws'],
            ['--json', '--embedded', 'sandbox', 'create', 'linux', '--on=aws', '--name=owned', '--keep-on-failure'],
            ['--json', '--embedded', 'cloud', 'status', 'aws'],
        ]);
        const mismatch = harness({ ...status, providers: [{ ...provider, ttl_hours: 8 }] });
        expect(await mismatch.byoc.create(launch, 'owned')).toMatchObject({ kind: 'unavailable' });
        expect(mismatch.argv).toHaveLength(1);
        const collision = harness(status);
        expect(await collision.byoc.create(launch, 'owned')).toMatchObject({ kind: 'unavailable', reason: 'native_name_exists' });
        expect(collision.argv).toHaveLength(1);
    });
    it('recovers a lost create response by exact name without creating another allocation', async () => {
        const h = harness(emptyStatus, new Error('private transport'), status);
        expect(await h.byoc.create(launch, 'owned')).toEqual({ kind: 'bound', resource });
        const unknown = harness(emptyStatus, new Error('private transport'), emptyStatus);
        expect(await unknown.byoc.create(launch, 'owned')).toEqual({ kind: 'unknown', recovery: { cloud: 'aws', sandboxId: 'aws:owned' } });
        expect(unknown.argv.filter(args => args.includes('create'))).toHaveLength(1);
    });
    it('requires the retained exact native id before observing power or deleting', async () => {
        const changed = harness({ ...status, resources: [{ ...row, id: 'i-neighbor' }] });
        expect(await changed.byoc.destroy(resource)).toMatchObject({ kind: 'incomplete', native: 'unknown', resource });
        expect(changed.argv).toHaveLength(1);
        const denied = harness(status, new Error('Authorization denied'));
        expect(await denied.byoc.inspect(resource)).toMatchObject({ existence: 'unknown', power: 'unknown' });
        const current = harness(status, info);
        expect(await current.byoc.inspect(resource)).toMatchObject({ existence: 'present', power: 'running', resource });
        expect(JSON.stringify(await harness(status, info).byoc.inspect(resource))).not.toContain('private');
        // The cloud ledger and sandbox state are separate native stores. A
        // matching name in both is not proof they still target the same id.
        const changedTarget = { ...info, provider_details: { provider: 'aws', id: 'i-neighbor' } };
        expect(await harness(status, changedTarget).byoc.inspect(resource)).toMatchObject({ existence: 'unknown' });
        const cleanup = harness(status, changedTarget);
        expect(await cleanup.byoc.destroy(resource)).toMatchObject({ kind: 'incomplete', native: 'unknown' });
        expect(cleanup.argv.some(args => args.includes('rm'))).toBe(false);
    });
    it('uses retained stop only for VM routes and never starts an absent resource', async () => {
        const h = harness(status, info, 'Suspending', status, { ...info, state: 'suspended', status: 'stopped' });
        expect(await h.byoc.power(resource, 'stop')).toMatchObject({ kind: 'observed', existence: 'present', power: 'stopped' });
        expect(h.argv[2]).toEqual(['--json', '--embedded', 'sandbox', 'suspend', 'aws:owned']);
        const missing = harness(status, { ...info, state: 'gone', status: 'unknown' });
        expect(await missing.byoc.power(resource, 'start')).toMatchObject({ kind: 'unavailable' });
        expect(missing.argv).toHaveLength(2);
        const modal = harness();
        expect(await modal.byoc.power({ ...resource, cloud: 'modal', sandboxId: 'modal:owned' }, 'stop')).toMatchObject({ kind: 'unsupported' });
        expect(modal.argv).toHaveLength(0);
    });
    it('keeps registry removal and primary deletion distinct and retains partial attachment cleanup', async () => {
        const h = harness(status, info, { deleted: 'aws:owned', missing: false }, { spaces: [] });
        expect(await h.byoc.destroy(resource)).toEqual({ kind: 'deleted', resource, native: 'absent', registry: 'removed', attachments: 'absent' });
        expect(h.argv[2]).toEqual(['--json', '--embedded', 'sandbox', 'rm', 'aws:owned', '--force']);
        const partial = harness(status, info, new Error('native deletion failed'), { spaces: [] });
        expect(await partial.byoc.destroy(resource)).toMatchObject({ kind: 'incomplete', native: 'unknown', registry: 'removed' });
        const attachedRef = { ...resource, ownedAttachmentIds: ['attachment-owned'] };
        const attachedStatus = { ...status, resources: [row, { ...row, id: 'attachment-owned', type: 'firewall' }] };
        const attached = harness(attachedStatus, info, { deleted: 'aws:owned', missing: false }, { spaces: [] });
        expect(await attached.byoc.destroy(attachedRef)).toMatchObject({ kind: 'incomplete', native: 'absent', attachments: 'unknown' });
        expect(attached.argv.every(args => !args.includes('sweep') && !args.includes('connect'))).toBe(true);
    });
    it('qualifies an alias through the native image catalog when recovering the resolved image', async () => {
        const resolved = 'ghcr.io/trycua/linux:24.04';
        const h = harness(status, { ...info, image: resolved }, { ref: resolved, published: true });
        expect(await h.byoc.recover(launch, 'aws:owned')).toEqual({ kind: 'bound', resource });
        expect(h.argv.at(-1)).toEqual(['--json', 'images', 'info', 'linux']);
        const wrongImage = harness(status, { ...info, image: 'ghcr.io/other/image:1' }, { ref: resolved, published: true });
        expect(await wrongImage.byoc.recover(launch, 'aws:owned')).toEqual({ kind: 'unknown' });
        const unavailable = harness(status, { ...info, image: resolved }, new Error('Catalog unavailable'));
        expect(await unavailable.byoc.recover(launch, 'aws:owned')).toEqual({ kind: 'unknown' });
        const custom = { ...launch, nativeImageId: 'ghcr.io/custom/image:1' };
        const exact = harness(status, { ...info, image: custom.nativeImageId });
        expect(await exact.byoc.recover(custom, 'aws:owned')).toEqual({ kind: 'bound', resource });
    });
});
