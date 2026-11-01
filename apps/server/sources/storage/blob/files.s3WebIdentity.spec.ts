import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, request as httpRequest, type IncomingHttpHeaders, type IncomingMessage, type RequestOptions, type Server } from 'node:http';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The real MinIO client and its IamAwsProvider run unmocked. Only the network
// is faked: S3 is a local HTTP server, and the HTTPS call to AWS STS is routed
// to a second local server. MinIO reaches STS through the `https` builtin, so
// the spy goes on the CommonJS module object and syncBuiltinESMExports()
// publishes it to MinIO's ESM import.
const https = createRequire(import.meta.url)('node:https') as typeof import('node:https');

type RecordedRequest = {
    method: string;
    url: string;
    headers: IncomingHttpHeaders;
};

type StsCall = {
    hostname: string;
    query: URLSearchParams;
};

type StsCredentials = {
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken: string;
    expiresInMs: number;
};

async function listen(server: Server): Promise<number> {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return (server.address() as AddressInfo).port;
}

async function close(server: Server): Promise<void> {
    await new Promise<void>((resolve) => server.close(() => resolve()));
}

function stsResponseXml(creds: StsCredentials): string {
    const expiration = new Date(Date.now() + creds.expiresInMs).toISOString();
    return [
        '<AssumeRoleWithWebIdentityResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/">',
        '<AssumeRoleWithWebIdentityResult><Credentials>',
        `<AccessKeyId>${creds.accessKeyId}</AccessKeyId>`,
        `<SecretAccessKey>${creds.secretAccessKey}</SecretAccessKey>`,
        `<SessionToken>${creds.sessionToken}</SessionToken>`,
        `<Expiration>${expiration}</Expiration>`,
        '</Credentials></AssumeRoleWithWebIdentityResult>',
        '</AssumeRoleWithWebIdentityResponse>',
    ].join('');
}

describe('storage/files (S3 credentials)', () => {
    let dir: string;
    let tokenFile: string;
    let s3Server: Server;
    let s3Port: number;
    let s3Requests: RecordedRequest[];
    let stsServer: Server;
    let stsCalls: StsCall[];
    let stsQueue: StsCredentials[];

    beforeEach(async () => {
        dir = mkdtempSync(join(tmpdir(), 'happier-server-files-s3-'));
        tokenFile = join(dir, 'token');
        writeFileSync(tokenFile, 'projected-service-account-jwt');

        s3Requests = [];
        s3Server = createServer((req, res) => {
            s3Requests.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers });
            req.resume();
            req.on('end', () => {
                res.writeHead(200, { ETag: '"etag"' });
                res.end();
            });
        });
        s3Port = await listen(s3Server);

        stsCalls = [];
        stsQueue = [];
        stsServer = createServer((req, res) => {
            const next = stsQueue.shift();
            if (!next) {
                res.writeHead(500);
                res.end('unexpected STS call');
                return;
            }
            res.writeHead(200, { 'Content-Type': 'text/xml' });
            res.end(stsResponseXml(next));
        });
        const stsPort = await listen(stsServer);

        vi.spyOn(https, 'request').mockImplementation(((options: RequestOptions, callback?: (res: IncomingMessage) => void) => {
            stsCalls.push({
                hostname: String(options.hostname),
                query: new URL(String(options.path), 'https://sts.invalid').searchParams,
            });
            return httpRequest({ ...options, protocol: 'http:', hostname: '127.0.0.1', port: stsPort, agent: undefined }, callback);
        }) as typeof https.request);
        syncBuiltinESMExports();
    });

    afterEach(async () => {
        vi.restoreAllMocks();
        syncBuiltinESMExports();
        vi.unstubAllEnvs();
        await close(s3Server);
        await close(stsServer);
        rmSync(dir, { recursive: true, force: true });
    });

    function s3Env(extra: Record<string, string>): NodeJS.ProcessEnv {
        return {
            S3_HOST: '127.0.0.1',
            S3_PORT: String(s3Port),
            S3_USE_SSL: 'false',
            S3_BUCKET: 'bucket',
            S3_PUBLIC_URL: 'https://cdn.example.com',
            S3_REGION: 'us-gov-west-1',
            ...extra,
        } as unknown as NodeJS.ProcessEnv;
    }

    function stubWebIdentityEnv(): Record<string, string> {
        const webIdentityEnv = {
            AWS_ROLE_ARN: 'arn:aws-us-gov:iam::123456789012:role/happier-server',
            AWS_WEB_IDENTITY_TOKEN_FILE: tokenFile,
            AWS_REGION: 'us-gov-west-1',
        };
        for (const [key, value] of Object.entries(webIdentityEnv)) {
            vi.stubEnv(key, value);
        }
        return webIdentityEnv;
    }

    it('signs S3 requests with web identity credentials from regional STS and refreshes them before expiry', async () => {
        const webIdentityEnv = stubWebIdentityEnv();
        stsQueue.push(
            { accessKeyId: 'ASIAFIRST', secretAccessKey: 'first-secret', sessionToken: 'first-session', expiresInMs: 5_000 },
            { accessKeyId: 'ASIASECOND', secretAccessKey: 'second-secret', sessionToken: 'second-session', expiresInMs: 3_600_000 },
        );

        vi.resetModules();
        const { initFilesS3FromEnv, loadFiles, writePublicFile, getPublicUrl } = await import('./files');
        await initFilesS3FromEnv(s3Env(webIdentityEnv));
        await loadFiles();
        writeFileSync(tokenFile, 'rotated-service-account-jwt');
        await writePublicFile('avatars/a.png', new Uint8Array([1, 2, 3]));
        await writePublicFile('avatars/b.png', new Uint8Array([4, 5, 6]));

        expect(stsCalls).toHaveLength(2);
        for (const call of stsCalls) {
            expect(call.hostname).toBe('sts.us-gov-west-1.amazonaws.com');
            expect(call.query.get('Action')).toBe('AssumeRoleWithWebIdentity');
            expect(call.query.get('RoleArn')).toBe(webIdentityEnv.AWS_ROLE_ARN);
        }
        expect(stsCalls.map((call) => call.query.get('WebIdentityToken'))).toEqual([
            'projected-service-account-jwt',
            'rotated-service-account-jwt',
        ]);

        expect(s3Requests.map((r) => `${r.method} ${r.url}`)).toEqual([
            'HEAD /bucket',
            'PUT /bucket/avatars/a.png',
            'PUT /bucket/avatars/b.png',
        ]);
        expect(s3Requests[0].headers.authorization).toContain('Credential=ASIAFIRST/');
        expect(s3Requests[0].headers['x-amz-security-token']).toBe('first-session');
        for (const request of s3Requests.slice(1)) {
            expect(request.headers.authorization).toContain('Credential=ASIASECOND/');
            expect(request.headers['x-amz-security-token']).toBe('second-session');
        }

        expect(getPublicUrl('avatars/a.png')).toBe('https://cdn.example.com/avatars/a.png');
    });

    it('keeps static keys authoritative when web identity env is also present', async () => {
        const webIdentityEnv = stubWebIdentityEnv();

        vi.resetModules();
        const { initFilesS3FromEnv, loadFiles } = await import('./files');
        await initFilesS3FromEnv(s3Env({
            ...webIdentityEnv,
            S3_ACCESS_KEY: 'static-access',
            S3_SECRET_KEY: 'static-secret',
        }));
        await loadFiles();

        expect(stsCalls).toHaveLength(0);
        expect(s3Requests).toHaveLength(1);
        expect(s3Requests[0].headers.authorization).toContain('Credential=static-access/');
        expect(s3Requests[0].headers['x-amz-security-token']).toBeUndefined();
    });

    it.each([
        { S3_ACCESS_KEY: 'static-access', S3_SECRET_KEY: '', missing: 'S3_SECRET_KEY' },
        { S3_ACCESS_KEY: '', S3_SECRET_KEY: 'static-secret', missing: 'S3_ACCESS_KEY' },
    ])('rejects partial static credentials instead of assuming a role ($missing)', async ({ missing, ...keys }) => {
        const webIdentityEnv = stubWebIdentityEnv();
        vi.resetModules();
        const { initFilesS3FromEnv } = await import('./files');

        await expect(initFilesS3FromEnv(s3Env({ ...webIdentityEnv, ...keys }))).rejects.toThrow(missing);
        expect(stsCalls).toHaveLength(0);
        expect(s3Requests).toHaveLength(0);
    });

    it.each(['AWS_ROLE_ARN', 'AWS_WEB_IDENTITY_TOKEN_FILE'])('rejects incomplete web identity configuration (%s)', async (missing) => {
        const webIdentityEnv = { ...stubWebIdentityEnv(), [missing]: '' };
        vi.stubEnv(missing, '');
        vi.resetModules();
        const { initFilesS3FromEnv } = await import('./files');

        await expect(initFilesS3FromEnv(s3Env(webIdentityEnv))).rejects.toThrow('S3_ACCESS_KEY');
        expect(stsCalls).toHaveLength(0);
        expect(s3Requests).toHaveLength(0);
    });

    it('fails a credential exchange without an unsigned S3 request and recovers on retry', async () => {
        const webIdentityEnv = stubWebIdentityEnv();
        vi.resetModules();
        const { initFilesS3FromEnv, loadFiles } = await import('./files');
        await initFilesS3FromEnv(s3Env(webIdentityEnv));

        // An empty queue makes the STS boundary return HTTP 500.
        await expect(loadFiles()).rejects.toThrow();
        expect(s3Requests).toHaveLength(0);

        stsQueue.push({ accessKeyId: 'ASIARECOVERED', secretAccessKey: 'recovered-secret', sessionToken: 'recovered-session', expiresInMs: 3_600_000 });
        await expect(loadFiles()).resolves.toBeUndefined();
        expect(s3Requests).toHaveLength(1);
        expect(s3Requests[0].headers.authorization).toContain('Credential=ASIARECOVERED/');
        expect(s3Requests[0].headers['x-amz-security-token']).toBe('recovered-session');
    });
});
