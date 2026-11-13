import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { HttpRequest } from '@happier-dev/plugin-sdk/http';

/** Test-only Neon vendor boundary backed by an owned, isolated PostgreSQL role. */
export const managedQueryPostgresBin = '/usr/lib/postgresql/16/bin';
export const managedQueryRolePassword = 'managed-query-test-password';
const managedQueryNull = '__HAPPIER_MANAGED_QUERY_NULL__';
const managedQueryGuardComplete = '__HAPPIER_MANAGED_QUERY_GUARD_COMPLETE__';
export const managedQueryEndpoint = { id: 'ep-main', project_id: 'project', branch_id: 'br-main', type: 'read_write',
    host: 'ep-main.eu-central-1.aws.neon.tech', disabled: false };

export const managedDataQueryPostgresAvailable = existsSync(join(managedQueryPostgresBin, 'initdb'));

export type ManagedQueryPostgres = Readonly<{
    root: string;
    pid: number;
    run(sql: string, username?: string, password?: string, database?: string): Readonly<{ status: number | null; stdout: string }>;
    stop(): Promise<void>;
}>;

function managedQueryCsv(text: string): string[][] {
    const rows: string[][] = [];
    let row: string[] = [], cell = '', quoted = false;
    for (let index = 0; index < text.length; index++) {
        const character = text[index]!;
        if (quoted) {
            if (character === '"' && text[index + 1] === '"') { cell += '"'; index++; }
            else if (character === '"') quoted = false;
            else cell += character;
        } else if (character === '"') quoted = true;
        else if (character === ',') { row.push(cell); cell = ''; }
        else if (character === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
        else if (character !== '\r') cell += character;
    }
    if (cell || row.length) { row.push(cell); rows.push(row); }
    return rows;
}

export async function startManagedQueryPostgres(): Promise<ManagedQueryPostgres> {
    const root = await mkdtemp(join(tmpdir(), 'happier-managed-query-pg-'));
    const data = join(root, 'data');
    const ctl = (args: string[]) => execFileSync(join(managedQueryPostgresBin, 'pg_ctl'), ['-D', data, ...args], { stdio: 'pipe' });
    let started = false;
    try {
        execFileSync(join(managedQueryPostgresBin, 'initdb'), ['-D', data, '-A', 'trust', '--no-locale'], { stdio: 'pipe' });
        await writeFile(join(data, 'pg_hba.conf'), 'local all happier_ro scram-sha-256\nlocal all all trust\n');
        ctl(['-l', join(root, 'server.log'), '-o', `-c listen_addresses= -k ${root}`, '-w', 'start']);
        started = true;
        const pid = Number((await readFile(join(data, 'postmaster.pid'), 'utf8')).split('\n')[0]);
        if (!Number.isInteger(pid) || pid <= 0) throw new Error('Could not read the isolated PostgreSQL PID');
        const run: ManagedQueryPostgres['run'] = (sql, username, password, database = 'neondb') => {
            const result = spawnSync(join(managedQueryPostgresBin, 'psql'), ['-X', '-A', '-t', '-h', root, '-d', database,
                '-v', 'ON_ERROR_STOP=1', ...(username ? [`--username=${username}`] : []), '-q', '-c', sql],
            { encoding: 'utf8', env: { ...process.env, ...(password ? { PGPASSWORD: password } : {}) } });
            return { status: result.status, stdout: result.stdout };
        };
        const role = run(`CREATE ROLE happier_ro LOGIN PASSWORD '${managedQueryRolePassword}' NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOREPLICATION NOBYPASSRLS;`,
            undefined, undefined, 'postgres');
        const database = role.status === 0 ? run('CREATE DATABASE neondb;', undefined, undefined, 'postgres') : null;
        if (role.status !== 0 || database?.status !== 0) throw new Error('Could not initialize the isolated PostgreSQL role fixture');
        const fixture = run(`
            GRANT pg_read_all_data TO happier_ro;
            REVOKE CREATE ON SCHEMA public FROM PUBLIC;
            CREATE TABLE query_fixture (value text);
            INSERT INTO query_fixture VALUES ('original');
        `);
        if (fixture.status !== 0) throw new Error('Could not initialize the isolated PostgreSQL data fixture');
        return { root, pid, run, async stop() {
            try { ctl(['-m', 'fast', '-w', 'stop']); }
            finally { await rm(root, { recursive: true, force: true }); }
        } };
    } catch (error) {
        try { if (started) ctl(['-m', 'fast', '-w', 'stop']); }
        finally { await rm(root, { recursive: true, force: true }); }
        throw error;
    }
}

function managedQueryResponse(body: unknown, status = 200) {
    return { status, finalUrl: undefined, body: new TextEncoder().encode(JSON.stringify(body)), headers: {} };
}

/** The only mockable boundary in managed-query compositions: Neon vendor HTTP. */
export function managedQueryProviderHttp(postgres: ManagedQueryPostgres, requests: HttpRequest[]) {
    return { async request(request: HttpRequest) {
        requests.push(request);
        const path = new URL(request.url).pathname;
        if (path.endsWith('/endpoints')) return { ...managedQueryResponse({ endpoints: [managedQueryEndpoint] }), finalUrl: request.url };
        if (path.endsWith('/databases')) return { ...managedQueryResponse({ databases: [{ name: 'neondb', branch_id: 'br-main' }] }), finalUrl: request.url };
        if (path !== '/sql' || !request.body || !request.headers) return { ...managedQueryResponse({ code: 'invalid_request' }, 400), finalUrl: request.url };
        const connectionValue = request.headers['Neon-Connection-String'];
        if (!connectionValue) return { ...managedQueryResponse({ code: 'invalid_request' }, 400), finalUrl: request.url };
        const connection = new URL(connectionValue);
        const database = decodeURIComponent(connection.pathname.slice(1));
        let body: unknown;
        try { body = JSON.parse(new TextDecoder().decode(request.body)); } catch { return { ...managedQueryResponse({ code: 'invalid_request' }, 400), finalUrl: request.url }; }
        if (!body || typeof body !== 'object' || !('queries' in body) || !Array.isArray(body.queries) || body.queries.length !== 2) {
            return { ...managedQueryResponse({ code: 'invalid_request' }, 400), finalUrl: request.url };
        }
        const [guard, caller] = body.queries;
        if (!guard || !caller || typeof guard !== 'object' || typeof caller !== 'object'
            || !('query' in guard) || typeof guard.query !== 'string' || !('query' in caller) || typeof caller.query !== 'string'
            || !('params' in caller) || !Array.isArray(caller.params) || !caller.params.every((value: unknown) => typeof value === 'string')) {
            return { ...managedQueryResponse({ code: 'invalid_request' }, 400), finalUrl: request.url };
        }
        if (caller.query === 'SELECT 1; SELECT 2') {
            return { ...managedQueryResponse({ code: 'multiple_statements_not_supported' }, 400), finalUrl: request.url };
        }
        const params = caller.params as string[];
        const variables = params.flatMap((value, index) => ['-v', `p${index + 1}=${value}`]);
        const execute = params.length
            ? `PREPARE happier_query AS ${caller.query};\nEXECUTE happier_query(${params.map((_value, index) => `:'p${index + 1}'`).join(', ')});`
            : caller.query;
        const native = spawnSync(join(managedQueryPostgresBin, 'psql'), ['-X', '-h', postgres.root, '-d', database,
            `--username=${decodeURIComponent(connection.username)}`, '-v', 'ON_ERROR_STOP=1', '-q', '--csv', '-P', `null=${managedQueryNull}`,
            ...variables], { input: `BEGIN READ ONLY;\n${guard.query}\n\\echo ${managedQueryGuardComplete}\n${execute}\nCOMMIT;\n`, encoding: 'utf8',
            env: { ...process.env, PGPASSWORD: decodeURIComponent(connection.password) } });
        const guarded = native.stdout.includes(managedQueryGuardComplete);
        if (native.status !== 0) return { ...managedQueryResponse({ code: '42501',
            message: guarded ? 'query_rejected' : 'happier_read_role_unavailable' }, 400), finalUrl: request.url };
        const [columns, ...rows] = managedQueryCsv(native.stdout.replace(`${managedQueryGuardComplete}\n`, ''));
        if (!columns || !rows.length) return { ...managedQueryResponse({ code: 'invalid_response' }, 400), finalUrl: request.url };
        return { ...managedQueryResponse({ results: [
            { command: 'DO', fields: [], rows: [], rowCount: null, rowAsArray: true },
            { command: 'SELECT', fields: columns.map(name => ({ name, dataTypeID: 25 })),
                rows: rows.map(row => row.map(value => value === managedQueryNull ? null : value)), rowCount: rows.length, rowAsArray: true },
        ] }), finalUrl: request.url };
    }, async openWebSocket() { throw new Error('No WebSocket requested'); } };
}
