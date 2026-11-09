import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpcErrors';
import { resolveManagedToolsRoot } from '@happier-dev/cli-common/agents';
import type { RpcHandler, RpcHandlerContext } from '@/api/rpc/types';
import { createEnvKeyScope } from '@/testkit/env/envScope';

// GitHub is the only mocked boundary; extraction, promotion, and install state
// exercise the production adapter on a real temporary filesystem.
const { fetchBoundary } = vi.hoisted(() => {
    const fetchBoundary = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchBoundary);
    return { fetchBoundary };
});
const { registerCapabilitiesHandlers } = await import('./capabilities');
const { reloadConfiguration } = await import('@/configuration');
const { createFilesystemEffectAdmission } = await import('./fileSystem/accessPolicy/filesystemEffectAdmission');
const environment = createEnvKeyScope(['HAPPIER_HOME_DIR', 'GITHUB_TOKEN']);
let directory: string | undefined;
let assetServer: Server | undefined;
afterEach(async () => {
    if (assetServer) await new Promise<void>((resolve, reject) => assetServer!.close(error => error ? reject(error) : resolve()));
    assetServer = undefined;
    environment.restore();
    reloadConfiguration();
    fetchBoundary.mockReset();
    if (directory) await rm(directory, { recursive: true, force: true });
    directory = undefined;
});

it.skipIf(process.platform !== 'linux')('admits real package install and upgrade only for Manage, preserving Use discovery', async () => {
    directory = await mkdtemp(join(tmpdir(), 'capability-install-admission-'));
    const home = join(directory, 'home');
    environment.patch({ HAPPIER_HOME_DIR: home, GITHUB_TOKEN: '' });
    reloadConfiguration();
    const payload = join(directory, 'payload');
    await mkdir(join(payload, 'bin'), { recursive: true });
    await writeFile(join(payload, 'bin', 'gh'), '#!/bin/sh\necho gh version 1.2.3\n');
    const archive = join(directory, 'gh.tar.gz');
    execFileSync('tar', ['-czf', archive, '-C', directory, 'payload']);
    const bytes = await readFile(archive);
    let downloads = 0;
    assetServer = createServer((_request, response) => {
        downloads += 1;
        response.writeHead(200, { 'content-length': bytes.length });
        response.end(bytes);
    });
    await new Promise<void>(resolve => assetServer!.listen(0, '127.0.0.1', resolve));
    const address = assetServer.address();
    if (!address || typeof address === 'string') throw new Error('Expected fixture asset server address');
    const arch = process.arch === 'x64' ? 'amd64' : process.arch;
    const assetName = `gh_1.2.3_linux_${arch}.tar.gz`;
    fetchBoundary.mockImplementation(async input => {
        const url = String(input);
        if (url.startsWith('https://api.github.com/')) return Response.json({ tag_name: 'v1.2.3', assets: [{
            name: assetName, browser_download_url: `http://127.0.0.1:${address.port}/${assetName}`,
            digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
        }] });
        throw new Error('Unexpected fixture HTTP request');
    });
    const handlers = new Map<string, RpcHandler>();
    registerCapabilitiesHandlers({ registerHandler: (method, handler) => { handlers.set(method, handler); } }, {
        hasSessionAgentTransition: () => true,
        filesystemEffectAdmission: createFilesystemEffectAdmission({ resolveHomeServerIdentityId: async () => 'home' }),
    });
    const invoke = handlers.get(RPC_METHODS.CAPABILITIES_INVOKE)!;
    const context = (actorAccountId: string, role: 'use' | 'manage'): RpcHandlerContext => ({
        signal: new AbortController().signal, callerAuthority: 'present_user',
        machineAdmission: { actorAccountId, role, custodianAccountId: 'owner', machineId: 'machine',
            installationId: 'installation', encryptionMode: 'plain' },
        verifyMachineAdmissionCurrent: async () => { throw new Error('Finite admitted install must not reauthorize'); },
    });
    const installedBinary = join(resolveManagedToolsRoot({ HAPPIER_HOME_DIR: home }), 'gh', 'current', 'bin', 'gh');
    for (const method of ['install', 'upgrade']) {
        expect.soft(await invoke({ id: 'dep.gh', method }, context('member', 'use')))
            .toMatchObject({ ok: false, error: { code: RPC_ERROR_CODES.FORBIDDEN } });
    }
    expect(fetchBoundary).not.toHaveBeenCalled();
    expect(downloads).toBe(0);
    await expect(readFile(installedBinary)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await handlers.get(RPC_METHODS.CAPABILITIES_DETECT)!({
        requests: [{ id: 'tool.sessionAgentTransition' }],
    }, context('member', 'use'))).toMatchObject({ results: {
        'tool.sessionAgentTransition': { ok: true, data: { supportsInputPermissionIntent: true } },
    } });
    for (const [actor, method] of [['owner', 'install'], ['member', 'upgrade']] as const) {
        expect.soft(await invoke({ id: 'dep.gh', method }, context(actor, 'manage'))).toMatchObject({ ok: true });
        expect(await readFile(installedBinary, 'utf8')).toContain('gh version 1.2.3');
    }
});
