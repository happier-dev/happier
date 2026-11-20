import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ProviderConformanceFixture } from '../../../../apps/cli/src/machines/managed/providerConformance.testkit.js';

/** Dev Container CLI + container engine boundary for the shared provider conformance suite. */
export const providerConformanceFixture: ProviderConformanceFixture = world => {
    const { state: s, result, guest, directory, managedId } = world;
    const foreignId = 'b'.repeat(64), containerId = 'a'.repeat(64);
    let nanoCpus = 0;
    const launch = { workspaceFolder: directory, configPath: join(directory, '.devcontainer', 'devcontainer.json') };
    mkdirSync(join(directory, '.devcontainer'));
    writeFileSync(launch.configPath, JSON.stringify({ image: 'example:latest', remoteUser: 'coder', workspaceFolder: '/work/custom',
        workspaceMount: 'source=conformance-workspace,target=/work/custom,type=volume' }));
    return {
        foreignId, launch,
        process(request, args) {
            if (args[0] === 'read-configuration') return result({ configuration: JSON.parse(readFileSync(launch.configPath, 'utf8')), workspace: { workspaceFolder: '/work/custom' }, mergedConfiguration: { remoteUser: 'coder', workspaceFolder: '/work/custom' }, featuresConfiguration: { featureSets: [] } });
            if (args[0] === 'image') return result([{ Id: 'sha256:image', Config: { Labels: {} } }]);
            if (args[0] === 'up') { s.allocations++; s.present = true; s.power = 'running'; s.owned.add('container'); return result({ outcome: 'success', containerId, remoteUser: 'coder', remoteWorkspaceFolder: '/work/custom' }); }
            if (args[0] === 'stop') s.power = 'stopped';
            // `docker update --cpus` applies to the running container; inspect reports it as NanoCpus.
            if (args[0] === 'update' && args.includes('--cpus')) nanoCpus = Number(args[args.indexOf('--cpus') + 1]) * 1e9;
            if (args[0] === 'rm') for (const target of args.slice(1).filter(arg => !arg.startsWith('-'))) world.remove(target, containerId, () => { s.present = false; s.owned.delete('container'); });
            if (args[0] === 'ps') {
                const idFilter = args.find(arg => arg.startsWith('id='))?.slice(3);
                return result([...(s.present ? [containerId] : []), ...(s.foreignPresent && !args.some(arg => arg.startsWith('label=happier.managed-machine=')) ? [foreignId] : [])]
                    .filter(id => !idFilter || id === idFilter).join('\n'));
            }
            if (args[0] === 'inspect') {
                const isForeign = args.includes(foreignId);
                return (isForeign ? s.foreignPresent : s.present) ? result([{ Id: isForeign ? foreignId : containerId, State: { Running: s.power === 'running', Paused: false }, ...(isForeign || !nanoCpus ? {} : { HostConfig: { NanoCpus: nanoCpus } }), Config: { Labels: { 'devcontainer.local_folder': directory, 'devcontainer.config_file': launch.configPath, 'happier.managed-machine': isForeign ? 'foreign-managed-id' : managedId } }, Mounts: [{ Type: 'volume', Name: 'conformance-workspace', Destination: '/work/custom' }] }]) : result('', 1);
            }
            if (args[0] === 'exec') {
                if (args.at(-1)?.includes('id -un')) return result('coder\n/work/custom\n');
                return guest(args.slice(args.indexOf(containerId) + 1), request.stdin);
            }
            return result('');
        },
    };
};
