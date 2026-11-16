import type { Readable, Writable } from 'node:stream';
import { ReadableStream } from 'node:stream/web';
import { resolveProcessCustodySupportExecutable } from '@/subprocess/supervision/processCustody';
import { currentWorkspaceSource } from '@/workspaces/source/workspaceSource';
import { runScmCommand, type ScmCommandInput, type ScmCommandRunner, type ScmExecResult } from './runtime';

class TransportReader {
    private readonly iterator: AsyncIterator<Buffer>;
    private buffered = Buffer.alloc(0);
    constructor(stream: Readable) { this.iterator = stream[Symbol.asyncIterator](); }
    private async available(): Promise<void> {
        if (this.buffered.length) return;
        const next = await this.iterator.next();
        if (next.done) throw new Error('Git transport channel closed');
        this.buffered = Buffer.from(next.value);
    }
    async read(length: number): Promise<Buffer> {
        const result = Buffer.allocUnsafe(length);
        let offset = 0;
        while (offset < length) {
            await this.available();
            const count = Math.min(this.buffered.length, length - offset);
            this.buffered.copy(result, offset, 0, count);
            this.buffered = this.buffered.subarray(count);
            offset += count;
        }
        return result;
    }
    async line(): Promise<unknown> {
        const parts: Buffer[] = [];
        for (;;) {
            await this.available();
            const newline = this.buffered.indexOf(10);
            if (newline >= 0) {
                parts.push(this.buffered.subarray(0, newline));
                this.buffered = this.buffered.subarray(newline + 1);
                return JSON.parse(Buffer.concat(parts).toString('utf8'));
            }
            parts.push(this.buffered);
            this.buffered = Buffer.alloc(0);
        }
    }
    async *body(): AsyncGenerator<Buffer> {
        for (;;) {
            const length = (await this.read(4)).readUInt32BE();
            if (!length) return;
            yield await this.read(length);
        }
    }
}

function write(stream: Writable, bytes: Uint8Array | string): Promise<void> {
    return new Promise((resolve, reject) => stream.write(bytes, error => error ? reject(error) : resolve()));
}

async function writeBody(stream: Writable, body: AsyncIterable<Uint8Array>): Promise<void> {
    for await (const chunk of body) {
        const length = Buffer.allocUnsafe(4);
        length.writeUInt32BE(chunk.byteLength);
        await write(stream, length);
        await write(stream, chunk);
    }
    await write(stream, Buffer.alloc(4));
}

type RepositoryTransportInput = Readonly<{
    repositories: readonly Readonly<{ url: string; authorizationHeader: string }>[];
    command: ScmCommandInput;
}>;

/** Credentials stay in this host process; target Git sees only an operation-local URL rewrite. */
export async function runAuthenticatedScmRepositoryCommand(input: RepositoryTransportInput,
    runCommand: ScmCommandRunner = runScmCommand): Promise<ScmExecResult> {
    const source = currentWorkspaceSource();
    const executable = source.nativeHelperPath ?? (source.kind === 'local'
        ? resolveProcessCustodySupportExecutable(process.platform) : null);
    if (!executable) return { success: false, exitCode: -1, stdout: '', stderr: 'Authenticated Git transport is unavailable' };
    input.command.signal?.throwIfAborted();
    const helper = source.spawn({ command: executable, args: ['git-http-transport'], cwd: input.command.cwd });
    helper.stderr.resume();
    helper.stdin.on('error', () => {});
    helper.on('error', () => {});
    const controller = new AbortController();
    const abort = () => { controller.abort(); void helper.terminateTree(); };
    input.command.signal?.addEventListener('abort', abort, { once: true });
    const reader = new TransportReader(helper.stdout);
    let serving: Promise<void> | undefined;
    try {
        const hello = await reader.line() as { url: string };
        const endpoint = new URL(hello.url);
        // This is the native helper's closed response, not a repository-supplied address.
        if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1') throw new Error('Git endpoint unavailable');
        serving = (async () => {
            for (;;) {
                const head = await reader.line() as { method: string; path: string; headers: Record<string, string[]> };
                const match = /^\/(\d+)\/(info\/refs\?service=git-(?:upload|receive)-pack|git-(?:upload|receive)-pack)$/.exec(head.path);
                const repository = match ? input.repositories[Number(match[1])] : undefined;
                const body = reader.body();
                if (!repository || !match || !['GET', 'POST'].includes(head.method)) {
                    for await (const _chunk of body) { /* Drain this exchange before replying. */ }
                    await write(helper.stdin, `${JSON.stringify({ status: 403, headers: {} })}\n`);
                    await writeBody(helper.stdin, (async function* () {})());
                    continue;
                }
                const headers = new Headers({ Authorization: repository.authorizationHeader });
                for (const name of ['content-type', 'accept', 'git-protocol']) {
                    const value = Object.entries(head.headers).find(([key]) => key.toLowerCase() === name)?.[1];
                    if (value) headers.set(name, value.join(', '));
                }
                let responseStarted = false;
                try {
                    let requestBody: ReadableStream<Uint8Array> | undefined;
                    if (head.method === 'POST') requestBody = new ReadableStream<Uint8Array>({
                        async pull(stream) { const next = await body.next(); if (next.done) stream.close(); else stream.enqueue(next.value); },
                    });
                    else for await (const _chunk of body) { /* GET still has the framing terminator. */ }
                    const response = await fetch(`${repository.url.replace(/\/+$/, '')}/${match[2]}`, {
                        method: head.method, headers, body: requestBody, redirect: 'manual', signal: controller.signal,
                        ...(requestBody ? { duplex: 'half' } : {}),
                    });
                    // Never return authentication, cookies or redirects from the authenticated host exchange.
                    const contentType = response.headers.get('content-type');
                    responseStarted = true;
                    await write(helper.stdin, `${JSON.stringify({ status: response.status,
                        headers: contentType ? { 'Content-Type': [contentType] } : {} })}\n`);
                    await writeBody(helper.stdin, (async function* () {
                        const responseReader = response.body?.getReader();
                        if (!responseReader) return;
                        try { for (;;) { const chunk = await responseReader.read(); if (chunk.done) return; yield chunk.value; } }
                        finally { responseReader.releaseLock(); }
                    })());
                } catch {
                    // Native/network failures disclose no host exception or authentication material.
                    if (controller.signal.aborted) return;
                    if (responseStarted) throw new Error('Git transport response interrupted');
                    for await (const _chunk of body) { /* Complete the request frame if upload failed. */ }
                    await write(helper.stdin, `${JSON.stringify({ status: 502, headers: {} })}\n`);
                    await writeBody(helper.stdin, (async function* () {})());
                }
            }
        })();
        // A failed exchange closes the target endpoint, which makes Git's existing operation settle.
        void serving.catch(() => { void helper.terminateTree(); });
        const rewrites = input.repositories.flatMap((repository, index) =>
            ['-c', `url.${endpoint.href}${index}/.insteadOf=${repository.url}`]);
        return await runCommand({ ...input.command,
            args: [...rewrites, '-c', 'credential.helper=', '-c', `http.${endpoint.href}.extraHeader=`,
                '-c', 'protocol.http.allow=always', ...input.command.args],
            env: { ...input.command.env, GIT_ALLOW_PROTOCOL: 'http:https:ssh:git:file' } });
    } finally {
        input.command.signal?.removeEventListener('abort', abort);
        controller.abort();
        helper.stdin.end();
        await helper.terminateTree();
        await serving?.catch(() => {});
    }
}
