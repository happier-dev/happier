import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Transform } from 'node:stream';

import { runScmExecutable } from './scmBackendContractFixtures';

export type GitSmartHttpRequest = Readonly<{ method: string; path: string; status: number }>;

export type GitSmartHttpFixture = Readonly<{
    url: string;
    rootDirectory: string;
    sourceRepositoryPath: string;
    bareRepositoryPath: string;
    branch: string;
    requests: GitSmartHttpRequest[];
    close: () => Promise<void>;
}>;

/** Real Git smart HTTP, with a fixture-only credential checked before invoking CGI. */
export async function startGitSmartHttpFixture(input: Readonly<{
    authorization: string;
    branch?: string;
    host?: string;
}>): Promise<GitSmartHttpFixture> {
    const rootDirectory = await mkdtemp(join(tmpdir(), 'git-smart-http-'));
    const sourceRepositoryPath = join(rootDirectory, 'source');
    const bareRepositoryPath = join(rootDirectory, 'repository.git');
    const branch = input.branch ?? 'feature/project-files';
    const requests: GitSmartHttpRequest[] = [];
    const children = new Set<ChildProcessWithoutNullStreams>();
    const server = createServer((request, response) => {
        const url = new URL(request.url ?? '/', 'http://fixture.invalid');
        response.once('close', () => {
            requests.push({ method: request.method ?? 'GET', path: url.pathname, status: response.statusCode });
        });
        if (request.headers.authorization !== input.authorization) {
            response.writeHead(401, { 'WWW-Authenticate': 'Basic realm="git-fixture"' });
            response.end();
            return;
        }
        const child = spawn('git', ['http-backend'], {
            env: {
                ...process.env,
                GIT_PROJECT_ROOT: rootDirectory,
                GIT_HTTP_EXPORT_ALL: '1',
                REQUEST_METHOD: request.method ?? 'GET',
                PATH_INFO: url.pathname,
                QUERY_STRING: url.search.slice(1),
                CONTENT_TYPE: request.headers['content-type'] ?? '',
                CONTENT_LENGTH: request.headers['content-length'] ?? '',
                REMOTE_USER: 'fixture',
                SERVER_PROTOCOL: `HTTP/${request.httpVersion}`,
                ...(typeof request.headers['git-protocol'] === 'string' ? { HTTP_GIT_PROTOCOL: request.headers['git-protocol'] } : {}),
            },
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        children.add(child);
        child.stderr.resume();
        const fail = () => {
            if (!response.headersSent) response.writeHead(500);
            response.end();
        };
        child.once('error', fail);
        child.once('close', code => {
            children.delete(child);
            if (code !== 0) fail();
        });
        // The backend may exit before consuming a rejected request body.
        child.stdin.on('error', () => {});
        request.once('aborted', () => child.kill());
        response.once('close', () => {
            if (!response.writableFinished) child.kill();
        });
        request.pipe(child.stdin);
        child.stdout.pipe(cgiResponseBody(response)).pipe(response);
    });

    let closing: Promise<void> | undefined;
    const close = () => closing ??= (async () => {
        const stopped = new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        server.closeAllConnections();
        await Promise.all([...children].map(child => new Promise<void>(resolve => {
            child.once('close', () => resolve());
            child.kill();
        })));
        await stopped;
        await rm(rootDirectory, { recursive: true, force: true });
    })();

    try {
        await mkdir(sourceRepositoryPath);
        runScmExecutable(sourceRepositoryPath, 'git', ['init', '--initial-branch=main']);
        runScmExecutable(sourceRepositoryPath, 'git', ['config', 'user.name', 'Git HTTP Fixture']);
        runScmExecutable(sourceRepositoryPath, 'git', ['config', 'user.email', 'fixture@example.test']);
        await writeFile(join(sourceRepositoryPath, 'sentinel.txt'), 'default branch\n');
        runScmExecutable(sourceRepositoryPath, 'git', ['add', '.']);
        runScmExecutable(sourceRepositoryPath, 'git', ['commit', '-m', 'fixture default']);
        if (branch !== 'main') runScmExecutable(sourceRepositoryPath, 'git', ['checkout', '-b', branch]);
        await writeFile(join(sourceRepositoryPath, 'sentinel.txt'), 'selected branch\n');
        await writeFile(join(sourceRepositoryPath, 'binary.bin'), Buffer.from(Array.from({ length: 131_072 }, (_, index) => index % 256)));
        runScmExecutable(sourceRepositoryPath, 'git', ['add', '.']);
        runScmExecutable(sourceRepositoryPath, 'git', ['commit', '-m', 'fixture selected branch']);
        runScmExecutable(rootDirectory, 'git', ['clone', '--bare', sourceRepositoryPath, bareRepositoryPath]);
        runScmExecutable(bareRepositoryPath, 'git', ['symbolic-ref', 'HEAD', 'refs/heads/main']);
        runScmExecutable(bareRepositoryPath, 'git', ['config', 'http.receivepack', 'true']);
        await new Promise<void>((resolve, reject) => {
            server.once('error', reject);
            server.listen(0, input.host ?? '127.0.0.1', resolve);
        });
        const address = server.address();
        if (!address || typeof address === 'string') throw new Error('Git HTTP fixture did not bind a TCP port');
        return {
            url: `http://127.0.0.1:${address.port}/repository.git`,
            rootDirectory,
            sourceRepositoryPath,
            bareRepositoryPath,
            branch,
            requests,
            close,
        };
    } catch (error) {
        if (server.listening) await close();
        else await rm(rootDirectory, { recursive: true, force: true });
        throw error;
    }
}

/** Separate CGI's textual headers without ever decoding the Git pack body. */
function cgiResponseBody(response: ServerResponse): Transform {
    let headers: Buffer | undefined = Buffer.alloc(0);
    return new Transform({
        transform(chunk: Buffer, _encoding, callback) {
            if (!headers) {
                callback(null, chunk);
                return;
            }
            headers = Buffer.concat([headers, chunk]);
            const crlf = headers.indexOf('\r\n\r\n');
            const lf = headers.indexOf('\n\n');
            const boundary = crlf >= 0 ? crlf : lf;
            if (boundary < 0) {
                callback();
                return;
            }
            for (const line of headers.subarray(0, boundary).toString('ascii').split(/\r?\n/u)) {
                const colon = line.indexOf(':');
                const name = line.slice(0, colon);
                const value = line.slice(colon + 1).trim();
                if (name.toLowerCase() === 'status') response.statusCode = Number.parseInt(value, 10);
                else response.setHeader(name, value);
            }
            const body = headers.subarray(boundary + (crlf >= 0 ? 4 : 2));
            headers = undefined;
            callback(null, body);
        },
    });
}
