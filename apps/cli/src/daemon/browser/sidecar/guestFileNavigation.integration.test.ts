import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';

import { canExecuteSessionRuntimeAction } from '@/daemon/sessionRuntimeActionAdmission';
import type { TrackedSession } from '@/daemon/types';
import { connectBrowserSidecarCdpTransport } from './cdpTransport';

// Explicit installed Chromium only: this regression never acquires a browser or reads a real profile.
it.skipIf(!process.env.HAPPIER_BROWSER_TEST_EXECUTABLE)('blocks guest privileged schemes while Chromium refuses an HTTP redirect to a local file', async () => {
    const executable = process.env.HAPPIER_BROWSER_TEST_EXECUTABLE;
    if (!executable) throw new Error('HAPPIER_BROWSER_TEST_EXECUTABLE is required');
    const directory = await mkdtemp(join(tmpdir(), 'browser-guest-file-live-'));
    const secret = 'isolated-owner-file-sentinel';
    const file = join(directory, 'private.txt');
    await writeFile(file, secret, { mode: 0o600 });
    const fileUrl = pathToFileURL(file).href;
    const server = createServer((_request, response) => {
        response.writeHead(302, { Location: fileUrl });
        response.end();
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Fixture server did not bind');
    const child = spawn(executable, ['--headless', `--user-data-dir=${join(directory, 'profile')}`,
        '--remote-debugging-pipe', '--no-first-run', '--no-default-browser-check', 'about:blank'],
    { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
    child.stderr?.resume();
    const exited = new Promise<void>(resolve => child.once('close', () => resolve()));
    let transport: Awaited<ReturnType<typeof connectBrowserSidecarCdpTransport>> | undefined;
    try {
        const writable = child.stdio[3];
        const readable = child.stdio[4];
        if (!writable || !('write' in writable) || !readable || !('read' in readable)) {
            throw new Error('Fixture Chromium CDP descriptors unavailable');
        }
        transport = await connectBrowserSidecarCdpTransport({ pipe: { readable, writable } });
        const page = await transport.openPage({ url: 'about:blank', focus: false });
        const navigate = (url: string) => transport!.dispatchPageCommand({ ...page, method: 'Page.navigate', params: { url } });
        const text = () => transport!.dispatchPageCommand({ ...page, method: 'Runtime.evaluate',
            params: { expression: 'document.body?.innerText', returnByValue: true } });
        // Owner-positive: this exact installed browser can read the fixture under its OS identity.
        await navigate(fileUrl);
        await transport.dispatchPageCommand({ ...page, method: 'Runtime.evaluate', params: {
            expression: 'new Promise(resolve => document.readyState === "complete" ? resolve() : window.addEventListener("load", resolve, {once:true}))',
            awaitPromise: true,
        } });
        expect(JSON.stringify(await text())).toContain(secret);
        // Private lifecycle custody fixture: admission reads only this already-decided role.
        const guest = { bootstrap: { savedSecretOperationContext: { machineAdmission: { role: 'use' } } } } as unknown as
            NonNullable<TrackedSession['requesterSessionRuntimeContext']>;
        const admitted = (url: string) => canExecuteSessionRuntimeAction({ actionId: 'browser.automation.navigate',
            input: { payload: { url } } }, () => guest);
        for (const url of [`view-source:${fileUrl}`, 'chrome://version/', 'devtools://devtools/']) expect(admitted(url)).toBe(false);
        await navigate('about:blank');
        const redirect = `http://127.0.0.1:${address.port}/redirect`;
        expect(admitted(redirect)).toBe(true);
        expect(await navigate(redirect)).toMatchObject({ errorText: expect.stringMatching(/UNSAFE_REDIRECT/) });
        expect(JSON.stringify(await text())).not.toContain(secret);
    } finally {
        transport?.dispose();
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
        await exited;
        await new Promise<void>(resolve => server.close(() => resolve()));
        await rm(directory, { recursive: true, force: true });
    }
});
