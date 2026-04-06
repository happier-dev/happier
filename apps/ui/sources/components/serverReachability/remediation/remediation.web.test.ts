import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

describe('serverReachability remediation web entrypoint', () => {
    it('re-exports the reachability remediation API for web directory resolution', async () => {
        const { getEndpointReachabilityProvider, resolveEndpointReachabilityRemediation } = await import('../remediation.web');

        expect(getEndpointReachabilityProvider('https://example.ts.net')).toBe('tailscale');

        const remediation = resolveEndpointReachabilityRemediation({
            endpointUrl: 'https://example.ts.net',
            isDesktopShell: false,
            platformOs: 'web',
            readiness: { status: 'server_unreachable' },
        });

        expect(remediation).not.toBeNull();
        expect(remediation?.bodyKey).toBe('server.reachabilityRemediation.tailscale.webBody');
    });

    it('can be imported as an ESM file entrypoint without hitting a directory import cycle', async () => {
        const moduleUrl = pathToFileURL(resolve(new URL('.', import.meta.url).pathname, '../remediation.web.ts')).href;
        const script = [
            `import(${JSON.stringify(moduleUrl)})`,
            `  .then((mod) => {`,
            `    if (typeof mod.getEndpointReachabilityProvider !== 'function') throw new Error('missing provider export');`,
            `    if (typeof mod.resolveEndpointReachabilityRemediation !== 'function') throw new Error('missing remediation export');`,
            `    process.stdout.write(String(mod.getEndpointReachabilityProvider('https://example.ts.net')));`,
            `  })`,
            `  .catch((error) => {`,
            `    console.error(error);`,
            `    process.exit(1);`,
            `  });`,
        ].join('\n');

        const result = spawnSync(process.execPath, ['--input-type=module', '--eval', script], { encoding: 'utf8' });
        expect(result.status, `stderr: ${result.stderr}`).toBe(0);
        expect(result.stdout.trim()).toBe('tailscale');
    });
});
