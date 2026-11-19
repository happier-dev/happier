import { execFile, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DeploymentTemplateRefV1Schema } from '@happier-dev/deployments/contracts/v1';
import { DeploymentTemplateV1Schema } from '@happier-dev/protocol/plugins/contributions/deploymentTemplates';
import { prepareDeploymentTemplateInstantiationV1 } from './prepareDeploymentTemplateInstantiationV1.js';

// Docker is the real boundary here: the pinned images, PgBouncer's own start-time auth_file and SCRAM handshake.
const docker = spawnSync('docker', ['info'], { stdio: 'ignore' }).status === 0;

describe.skipIf(!docker)('packaged PostgreSQL with its PgBouncer companion on real containers', () => {
    let directory = '';
    const project = `happier-pgbouncer-${randomBytes(4).toString('hex')}`;
    const env = { ...process.env, DB_USER: 'happier', DB_NAME: 'app', DB_PASSWORD: randomBytes(18).toString('base64url') };
    const compose = (args: readonly string[], input?: string) => new Promise<string>((resolve, reject) => {
        const child = execFile('docker', ['compose', '-p', project, '-f', join(directory, 'compose.json'), ...args],
            { env, encoding: 'utf8', timeout: 240_000 }, (error, stdout) => error ? reject(error) : resolve(stdout));
        if (input !== undefined) child.stdin?.end(input);
    });
    const pooled = 'postgres://happier:$DB_PASSWORD@pgbouncer:5432/app';
    beforeAll(async () => {
        const raw = JSON.parse(await readFile(new URL('../../../plugins/deployment-templates/resources/registry/apps.json', import.meta.url), 'utf8'));
        const app = DeploymentTemplateV1Schema.parse(raw.apps.find((entry: { itemId: string }) => entry.itemId === 'postgresql').app);
        const prepared = prepareDeploymentTemplateInstantiationV1({ template: app, companions: ['pgbouncer'],
            templateRef: DeploymentTemplateRefV1Schema.parse({ sourceId: 'data', itemId: 'postgresql', version: '1',
                ref: { kind: 'content', digest: `sha256:${'a'.repeat(64)}` } }),
            source: JSON.parse(app.compose.document), bindings: [{ purpose: 'variable', name: 'DB_PASSWORD', phase: 'runtime',
                source: { kind: 'generated', key: 'DB_PASSWORD' } }] });
        directory = await mkdtemp(join(tmpdir(), 'happier-pgbouncer-'));
        // Test-only: two server connections for eight clients force statements to cross server connections.
        // The shipped profile sets no pool size.
        const document = JSON.parse(prepared.document);
        expect(document.services.pgbouncer.environment.DEFAULT_POOL_SIZE).toBeUndefined();
        document.services.pgbouncer.environment.DEFAULT_POOL_SIZE = '2';
        await writeFile(join(directory, 'compose.json'), JSON.stringify(document));
        await compose(['up', '-d', '--wait', ...prepared.services]);
    }, 300_000);
    afterAll(async () => {
        if (directory) { await compose(['down', '-v']).catch(() => undefined); await rm(directory, { recursive: true, force: true }); }
    }, 120_000);

    // The client sits inside the database container so the password stays in the container's own environment.
    // `-e DB_PASSWORD` without a value inherits it, so the password never appears in argv or a failure message.
    const inContainer = (command: string, input?: string) => compose(['exec', '-T', '-e', 'DB_PASSWORD', 'database', 'sh', '-c', command], input);
    const psql = (script: string) => inContainer(`psql "${pooled}" -X -q -At -v ON_ERROR_STOP=1`, script);

    it('authenticates through the pooler with SCRAM against PostgreSQL 17', async () => {
        expect((await psql('SELECT 1;\n')).trim()).toBe('1');
        const stored = await compose(['exec', '-T', 'database', 'psql', '-U', 'happier', '-d', 'app', '-At', '-c',
            "SELECT left(rolpassword, 13) FROM pg_authid WHERE rolname = 'happier'"]);
        expect(stored.trim()).toBe('SCRAM-SHA-256');
        const ini = await compose(['exec', '-T', 'pgbouncer', 'cat', '/etc/pgbouncer/pgbouncer.ini']);
        expect(ini).toMatch(/^auth_type = scram-sha-256$/mu);
    }, 120_000);

    it('runs the fixed transaction pool profile with protocol prepared statements across pooled transactions', async () => {
        const ini = await compose(['exec', '-T', 'pgbouncer', 'cat', '/etc/pgbouncer/pgbouncer.ini']);
        expect(ini).toMatch(/^pool_mode = transaction$/mu);
        expect(ini).toMatch(/^max_prepared_statements = 200$/mu);
        // pgbench -M prepared names statements over the extended protocol (Parse/Bind), not SQL PREPARE. Eight clients
        // share two server connections transaction by transaction, so a statement prepared on one server connection
        // is executed on another; without PgBouncer's prepared-statement tracking this fails.
        const report = await inContainer(`printf '%s\\n' '\\set id random(1, 1000)' 'SELECT :id::int + 1;' > /tmp/pooled.sql`
            + ` && pgbench "${pooled}" -n -M prepared -c 8 -j 2 -t 50 -f /tmp/pooled.sql`);
        expect(report).toMatch(/number of transactions actually processed: 400\/400/u);
        expect(report).toMatch(/number of failed transactions: 0 /u);
    }, 120_000);
});
