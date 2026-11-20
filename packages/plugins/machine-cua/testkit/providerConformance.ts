import { createHash } from 'node:crypto';
import { copyFileSync, readFileSync } from 'node:fs';
import type { ProviderConformanceFixture } from '../../../../apps/cli/src/machines/managed/providerConformance.testkit.js';

/** Cua CLI boundary (local sandbox, local space and BYOC) for the shared provider conformance suite. */
export const providerConformanceFixture: ProviderConformanceFixture = world => {
    const { state: s, result, guest, name, contribution, directory } = world;
    const byoc = contribution === 'byoc';
    const namespace = byoc ? 'aws' : 'local', sandboxId = `${namespace}:${name}`;
    const foreignId = `${namespace}:happier-foreign`;
    const launch: Record<string, unknown> = byoc
        ? { cloud: 'aws', region: 'us-west-2', nativeImageId: 'linux', nativeSizeId: 't3.medium', nativeLifetime: { kind: 'no-native-ttl' } }
        : { on: 'local', runtimeId: 'qemu', imageId: 'ghcr.io/trycua/linux:24.04-disk', size: { cpu: 4, memoryBytes: 4 * 1024 ** 3, diskBytes: 20 * 1024 ** 3 } };
    let spacePresent = false;
    return {
        foreignId, launch,
        account: { environment: { CUA_HOME: directory, CUA_CREDENTIAL_STORE: 'file' } },
        ...(byoc ? { facts: { nativeExpiry: 'with-evidence' as const } } : {}),
        process(_request, args) {
            if (args.includes('doctor')) return result({ host: { os: 'linux', arch: 'x86_64', kvm: true, accel: { x86_64: 'kvm', aarch64: 'tcg' } }, backends: [{ backend: 'qemu', ready: true, provisionable: false }], qemu: { version: '10.1.0' }, lume: { version: null }, container: { reachable: false, gvisor: false, runtimes: [] } });
            if (args.includes('images')) {
                const digest = `sha256:${'a'.repeat(64)}`;
                return result(byoc ? { ref: 'ghcr.io/trycua/linux:24.04', published: true } : [{ ref: launch.imageId, os: 'linux', arch: ['amd64'], local: 'qemu', published: true, spacesd: true, digest, sizes: { digest, platforms: [{ arch: 'amd64', disk: 20 * 1024 ** 3 }] } }]);
            }
            const info = () => ({ id: sandboxId, name, location: namespace, runtime: 'qemu', kind: 'vm', image: byoc ? 'ghcr.io/trycua/linux:24.04' : launch.imageId,
                status: s.power === 'running' ? 'ready' : 'stopped', state: s.power === 'running' ? 'running' : 'suspended', ephemeral: false, expires_at: s.evidence ? new Date(world.nativeExpiry).toISOString() : null,
                ...(namespace === 'aws' ? { provider_details: { provider: 'aws', id: 'i-owned' } } : {}) });
            if (args.includes('status')) return result({ providers: [{ name: 'aws', connected: true, region: 'us-west-2', ttl_hours: 0, kinds: [{ image: 'linux', supported: true, machine_type: 't3.medium', usd_per_hour: 0.04 }] }], resources: s.present ? [{ provider: 'aws', id: 'i-owned', type: 'instance', sandbox: sandboxId, machine: '', region: 'us-west-2', state: s.power, expires: '', expired: false }] : [] });
            if (args.includes('create')) { s.allocations++; s.present = true; s.owned.add('sandbox'); if (contribution === 'local-space') { spacePresent = true; s.owned.add('space'); return result({ spaces: [{ id: sandboxId, provider: 'local' }] }); } return result(info()); }
            if (args.includes('info')) {
                const isForeign = args[args.indexOf('info') + 1] === foreignId;
                return (isForeign ? s.foreignPresent : s.present) ? result(isForeign ? { ...info(), id: foreignId, name: 'happier-foreign' } : info()) : result('', 3);
            }
            if (args.includes('suspend') || args.includes('stop')) { s.power = 'stopped'; return result('Suspending'); }
            if (args.includes('resume') || args.includes('start')) { s.power = 'running'; return result({ id: sandboxId }); }
            if (args.includes('ls') && args.includes('spaces')) return result({ spaces: [...(spacePresent ? [{ id: sandboxId, provider: namespace, image: launch.imageId }] : []), ...(s.foreignPresent ? [{ id: foreignId, provider: namespace, image: launch.imageId }] : [])] });
            if (args.includes('rm')) { const target = args[args.indexOf('rm') + 1]; world.remove(target, sandboxId, () => { if (args.includes('spaces')) { spacePresent = false; s.owned.delete('space'); } else { s.present = false; s.owned.delete('sandbox'); } }); return result({ deleted: target, missing: false }); }
            if (args.includes('cp')) {
                const index = args.indexOf('cp'), source = args[index + 1]!, target = args[index + 2]!.slice(sandboxId.length + 1), bytes = readFileSync(source);
                copyFileSync(source, target);
                return result({ direction: 'upload', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
            }
            if (args.includes('shell')) return guest(['sh', '-c', args.at(-1)!]);
            if (args.includes('daemon')) return result({ ok: true, status: 'started' });
            throw new Error(`Unexpected Cua command ${JSON.stringify(args)}`);
        },
    };
};
