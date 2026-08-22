import { access, readFile, readdir } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

const cliSource = new URL('../../../../', import.meta.url);
const sourceFile = (path: string) => new URL(path, cliSource);

async function listProductionTypeScriptFiles(
    directory: URL,
): Promise<readonly URL[]> {
    const entries = await readdir(directory, { withFileTypes: true });
    const files = await Promise.all(entries.map(async (entry) => {
        const path = new URL(entry.name + (entry.isDirectory() ? '/' : ''), directory);
        if (entry.isDirectory()) return await listProductionTypeScriptFiles(path);
        if (
            !entry.isFile()
            || !entry.name.endsWith('.ts')
            || entry.name.endsWith('.test.ts')
            || entry.name.endsWith('.spec.ts')
        ) return [];
        return [path];
    }));
    return files.flat();
}

describe('Agent External Sessions managed endpoint read authority', () => {
    it('cannot be minted from passive durability projections or source base URLs', async () => {
        const productionFiles = await listProductionTypeScriptFiles(cliSource);
        const offenders = (await Promise.all(productionFiles.map(async (path) => {
            const source = await readFile(path, 'utf8');
            const carriesAuxiliaryReadAuthority =
                source.includes('AgentExternalSessionsManagedEndpointReadHost')
                || source.includes('AgentExternalSessionsManagedEndpointRead');
            const mintsFromPassiveState =
                source.includes('.resolveEndpointProjection(')
                || source.includes('source.baseUrl')
                || source.includes("kind: 'baseUrl'");
            return carriesAuxiliaryReadAuthority && mintsFromPassiveState
                ? path.pathname.slice(cliSource.pathname.length)
                : null;
        }))).filter((path): path is string => path !== null);

        expect(offenders).toEqual([]);
    });

    it('removes the rejected daemon passive-resolution host', async () => {
        await expect(access(sourceFile(
            'plugins/runtime/invocation/services/daemonAgentExternalSessionsManagedEndpointReadHost.ts',
        ))).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('wires the daemon owner through one ready callback instead of a permanent unavailable stub', async () => {
        const startDaemon = await readFile(sourceFile('daemon/startDaemon.ts'), 'utf8');
        const sessionControlRuntime = await readFile(sourceFile(
            'daemon/startup/startDaemonSessionControlRuntime.ts',
        ), 'utf8');

        expect(startDaemon).not.toContain(
            'createUnavailableAgentExternalSessionsManagedEndpointRead',
        );
        expect(startDaemon).toContain('managedServiceEndpointReadHost');
        expect(startDaemon).toContain('onManagedServiceEndpointReadHostReady');
        expect(sessionControlRuntime).toContain(
            'params.onManagedServiceEndpointReadHostReady?.(',
        );
    });
});
