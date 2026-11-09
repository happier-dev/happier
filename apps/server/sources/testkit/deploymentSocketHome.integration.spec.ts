import { get } from 'node:https';
import { spawn } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it, onTestFinished } from 'vitest';
import { hasRemoteHomeApplicationCarrier } from '@happier-dev/cli-common/homeEnrollment';
import { HomeConnectionDescriptorV1Schema } from '@happier-dev/protocol';

import { createDeploymentSocketHome, type DeploymentSocketHomeFixture } from './deploymentSocketHome.testkit.mjs';

describe('deployment journey Home transport', () => {
    let home: DeploymentSocketHomeFixture;
    beforeAll(async () => { home = await createDeploymentSocketHome(); });
    afterAll(async () => { if (home) await home.close(); });

    it('publishes a guest-reachable Home and serves its exact authenticated descriptor over trusted TLS in both processes', async () => {
        const descriptor = HomeConnectionDescriptorV1Schema.parse({ v: 1, homeServerIdentityId: home.serverId,
            canonicalServerUrl: home.baseUrl, revision: 1, endpoints: [{ kind: 'https', url: home.baseUrl }] });
        expect(hasRemoteHomeApplicationCarrier(descriptor)).toBe(true);
        const response = await new Promise<{ status: number | undefined; body: string }>((resolve, reject) => {
            get(`${home.baseUrl}/v1/features`, { headers: { Authorization: `Bearer ${home.token}` } }, response => {
                let body = '';
                response.setEncoding('utf8');
                response.on('data', chunk => { body += chunk; });
                response.once('error', reject);
                response.once('end', () => resolve({ status: response.statusCode, body }));
            }).once('error', reject);
        });
        expect(response.status).toBe(200);
        expect(JSON.parse(response.body).homeConnectionDescriptor).toEqual(descriptor);
        // The source guest is a fresh process: it must trust the same fixture
        // CA without disabling certificate or hostname validation.
        const lifetime = new AbortController();
        onTestFinished(() => lifetime.abort());
        const child = spawn(process.execPath, ['--input-type=module', '-e',
            'import { get } from "node:https"; get(process.argv[1] + "/v1/features", response => { response.resume(); response.once("end", () => { process.exitCode = response.statusCode === 200 ? 0 : 1; }); }).once("error", () => { process.exitCode = 1; });', home.baseUrl],
        { env: process.env, stdio: 'ignore', signal: lifetime.signal });
        const exit = await new Promise<number | null>((resolve, reject) => {
            child.once('error', reject);
            child.once('close', resolve);
        });
        expect(exit).toBe(0);
    });
});
