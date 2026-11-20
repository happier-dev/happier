import { join } from 'node:path';
import type { ProviderConformanceFixture } from '../../../../apps/cli/src/machines/managed/providerConformance.testkit.js';

/** `limactl` boundary for the shared provider conformance suite. */
export const providerConformanceFixture: ProviderConformanceFixture = world => {
    const { state: s, result, guest } = world;
    const foreignId = 'happier-foreign';
    const launch = { store: join(world.directory, 'lima'), image: 'https://example.test/ubuntu.img', arch: 'x86_64', vmType: 'qemu', cpus: 2, memoryGiB: 4, diskGiB: 20, mounts: [] };
    let instance = '', cpus = 2;
    return {
        foreignId, launch,
        // `limactl list` proves exact absence of a deleted instance.
        facts: { provesAbsenceAfterDelete: true },
        process(request, args) {
            const verb = args[0];
            if (verb === '--version') return result('limactl version 2.2.1');
            if (verb === 'info') return result({ hostOS: 'linux', hostArch: 'x86_64', vmTypes: ['qemu'] });
            if (verb === 'create') { s.allocations++; s.present = true; instance = args.find(arg => arg.startsWith('--name='))?.slice(7) ?? args[args.indexOf('--name') + 1] ?? ''; s.owned.add('vm'); }
            if (verb === 'start' || verb === 'restart') s.power = 'running';
            if (verb === 'stop') s.power = 'stopped';
            // `limactl edit` changes a stopped guest's size; the next list reports it.
            if (verb === 'edit' && args.includes('--cpus')) cpus = Number(args[args.indexOf('--cpus') + 1]);
            if (verb === 'delete') for (const target of args.slice(1).filter(arg => !arg.startsWith('-'))) world.remove(target, instance, () => { s.present = false; s.owned.delete('vm'); });
            if (verb === 'list') {
                const selected = args.slice(1).filter(arg => !arg.startsWith('-'));
                const native = (vmName: string) => ({ name: vmName, dir: `${request.env?.LIMA_HOME ?? launch.store}/${vmName}`, status: s.power === 'running' ? 'Running' : 'Stopped', vmType: 'qemu', arch: 'x86_64', cpus, memory: 4 * 1024 ** 3, disk: 20 * 1024 ** 3,
                    config: { images: [{ location: launch.image, arch: 'x86_64' }], mounts: [], ssh: { forwardAgent: false }, containerd: { user: false, system: false } } });
                return result([...(s.present ? [instance] : []), ...(s.foreignPresent ? [foreignId] : [])]
                    .filter(id => !selected.length || selected.includes(id)).map(id => JSON.stringify(native(id))).join('\n'));
            }
            if (verb === 'shell') return guest(args.slice(args.indexOf('--') + 1), request.stdin);
            return result('');
        },
    };
};
