import { describe, expect, it } from 'vitest';
import { createDeploymentEnvironmentDetailV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { resolveOwnServerDataQueryDefinitionForHost } from './dataQueryScope';
import { bootstrapOwnServerReadOnlyDataRoleForHost } from './dataRoleBootstrap';
import type { OwnServerDataQueryNative } from './dataQuery';

describe('self-hosted database query identity', () => {
    const content = () => {
        const result = createDeploymentEnvironmentDetailV1().content;
        result.template = { templateRef: { sourceId: 'catalog', itemId: 'postgres', version: '1', ref: { kind: 'version', version: '1' } },
            definition: { kind: 'stored', contentRevision: 1, composeDigest: `sha256:${'a'.repeat(64)}` },
            services: ['db', 'analytics'], data: [
                { engine: 'postgres', service: 'db', version: '16', variables: { database: 'DB_NAME' } },
                { engine: 'postgres', service: 'analytics', version: '16', variables: { database: 'ANALYTICS_NAME' } },
            ] };
        result.bindings = [{ purpose: 'variable', name: 'DB_NAME', phase: 'runtime', source: { kind: 'value', value: 'app' } },
            { purpose: 'variable', name: 'ANALYTICS_NAME', phase: 'runtime', source: { kind: 'value', value: 'analytics' } }];
        return result;
    };
    it('derives the selected database without a data target link or neighboring service fallback', () => {
        expect(resolveOwnServerDataQueryDefinitionForHost(content(), 'db')).toMatchObject({ engine: 'postgresql', database: 'app' });
        expect(resolveOwnServerDataQueryDefinitionForHost(content(), 'analytics')).toMatchObject({ database: 'analytics' });
        expect(() => resolveOwnServerDataQueryDefinitionForHost(content(), 'foreign')).toThrowError(expect.objectContaining({ code: 'target_mismatch' }));
    });
    it('refuses stale, ambiguous and unsupported declarations before database or secret work', () => {
        const stale = content();
        stale.template!.services = ['analytics'];
        expect(() => resolveOwnServerDataQueryDefinitionForHost(stale, 'db')).toThrowError(expect.objectContaining({ code: 'target_mismatch' }));
        const ambiguous = content();
        ambiguous.template!.data!.push(ambiguous.template!.data![0]!);
        expect(() => resolveOwnServerDataQueryDefinitionForHost(ambiguous, 'db')).toThrowError(expect.objectContaining({ code: 'target_mismatch' }));
        const unsupported = content();
        unsupported.template!.data![0]!.engine = 'redis';
        expect(() => resolveOwnServerDataQueryDefinitionForHost(unsupported, 'db')).toThrowError(expect.objectContaining({ code: 'unsupported_action' }));
        const maria = content();
        maria.template!.data![0]!.engine = 'mariadb';
        expect(() => resolveOwnServerDataQueryDefinitionForHost(maria, 'db')).toThrowError(expect.objectContaining({ code: 'unsupported_action' }));
    });
    it('requires an exact nonsecret database operand instead of borrowing a username or another database', () => {
        const missing = content();
        missing.bindings = missing.bindings.filter(row => row.purpose !== 'variable' || row.name !== 'DB_NAME');
        expect(() => resolveOwnServerDataQueryDefinitionForHost(missing, 'db')).toThrowError(expect.objectContaining({ code: 'deployment_invalid' }));
    });
    it('uses the active deployment database while a different Environment value awaits deployment', () => {
        const active = content();
        const draft = content();
        draft.bindings = draft.bindings.map(row => row.purpose === 'variable' && row.name === 'DB_NAME'
            ? { ...row, source: { kind: 'value', value: 'next_database' } } : row);
        expect(resolveOwnServerDataQueryDefinitionForHost(draft, 'db', active.bindings)).toMatchObject({ database: 'app' });
    });
});

describe('reviewed database read-role setup', () => {
    const input = { engine: 'mysql' as const, database: 'app', password: 'selected-private-password',
        signal: new AbortController().signal };

    it('refuses an existing privileged account before sending the selected password', async () => {
        const requests: Parameters<OwnServerDataQueryNative['run']>[0][] = [];
        const native: OwnServerDataQueryNative = { async run(request) {
            requests.push(request);
            return { exitCode: 0, stdout: requests.length === 1 ? 'exists\n' : '0\n', stdoutTruncated: false };
        } };
        await expect(bootstrapOwnServerReadOnlyDataRoleForHost(input, native))
            .rejects.toMatchObject({ code: 'read_role_unavailable' });
        const disclosed = requests.map(request => [request.argv.join(' '), Buffer.from(request.stdin).toString(),
            JSON.stringify(request.env)].join('\n')).join('\n');
        expect(disclosed).not.toContain(input.password);
        expect(disclosed).not.toContain(Buffer.from(input.password).toString('base64'));
    });

    it('finishes setup only after the selected password logs in as the dedicated role', async () => {
        let rolePassword: string | undefined;
        const native: OwnServerDataQueryNative = { async run(request) {
            const sql = Buffer.from(request.stdin).toString();
            if (request.argv[0] === 'sh') return { exitCode: 0,
                stdout: sql.includes('SELECT IF(EXISTS') ? 'absent\n' : sql.includes('SELECT @happier_query_authorized') ? '1\n' : '', stdoutTruncated: false };
            rolePassword = request.env.MYSQL_PWD;
            return { exitCode: 0, stdout: '<resultset><row><field name="happier_role_ready">1</field></row></resultset>', stdoutTruncated: false };
        } };
        await expect(bootstrapOwnServerReadOnlyDataRoleForHost(input, native)).resolves.toBeUndefined();
        expect(rolePassword).toBe(input.password);
    });

    it('keeps a new role with inherited server privileges locked when setup refuses', async () => {
        let readRoleLogin = false;
        let accountLocked = false;
        const native: OwnServerDataQueryNative = { async run(request) {
            const sql = Buffer.from(request.stdin).toString();
            if (request.argv[0] === 'sh') {
                // The native DB is the boundary: model its account-lock effect,
                // leaving the real bootstrap SQL and grant policy unmocked.
                if (sql.includes('CREATE') && sql.includes('USER')) accountLocked = sql.includes('ACCOUNT LOCK');
                if (sql.includes('ACCOUNT UNLOCK')) accountLocked = false;
                return { exitCode: 0, stdout: sql.includes('SELECT IF(EXISTS') ? 'absent\n'
                    : sql.includes('SELECT @happier_query_authorized') ? '0\n' : '', stdoutTruncated: false };
            }
            readRoleLogin = true;
            return { exitCode: 0, stdout: '<resultset><row><field name="happier_role_ready">1</field></row></resultset>', stdoutTruncated: false };
        } };
        await expect(bootstrapOwnServerReadOnlyDataRoleForHost(input, native))
            .rejects.toMatchObject({ code: 'read_role_unavailable' });
        expect(readRoleLogin).toBe(false);
        expect(accountLocked).toBe(true);
    });
});
