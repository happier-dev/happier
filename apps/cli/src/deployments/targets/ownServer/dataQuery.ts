import { admitPsqlInput } from './postgresqlInput';
import { PluginError } from '@happier-dev/plugin-sdk/errors';
import { assertOwnServerDataQuerySupportedEngine, ownServerMysqlNativeTextLiteral, type OwnServerDataEngine } from './dataRoleGuard';
import type { DeploymentDataQueryInputV1, DeploymentDataQuerySuccessV1 } from '@happier-dev/protocol/deployments/deploymentReadsV1';
import { EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES,
    measureExternalActionResultResponseEnvelopeUtf8BytesV1 } from '@happier-dev/protocol/actions/externalActionLimits';

import type { OwnServerDataQueryNative } from './dataQueryNative';
export type { OwnServerDataQueryNative } from './dataQueryNative';
export type OwnServerReadOnlyDataQueryInput = Readonly<{
    engine: OwnServerDataEngine; database: string; sql: string;
    port?: number; params: Readonly<DeploymentDataQueryInputV1['params']>; password: string; signal: AbortSignal;
}>;
export type OwnServerReadOnlyDataQueryResult = Readonly<Omit<DeploymentDataQuerySuccessV1, 'ok'>>;
function refuse(code: string, reason: string): never {
    throw new PluginError({ code, message: 'The read-only database query is unavailable', details: { reason } });
}

export { assertOwnServerDataQuerySupportedEngine, ownServerReadOnlyRoleGuardSql } from './dataRoleGuard';

export { admitPsqlInput } from './postgresqlInput';

/** The response owner supplies the complete envelope budget. Measure each row
 * once, retaining a whole-row prefix that also fits its incompleteness reason. */
function queryRows(columns: OwnServerReadOnlyDataQueryResult['columns'], truncated: boolean) {
    const rows: OwnServerReadOnlyDataQueryResult['rows'] = [];
    const original = { columns, rows, complete: !truncated,
        ...(truncated ? { diagnostic: { code: 'native_output_truncated' } } : {}) };
    const limited = { columns, rows, complete: false, diagnostic: { code: 'action_result_size_limit' } };
    const originalBytes = measureExternalActionResultResponseEnvelopeUtf8BytesV1({ ok: true, ...original });
    const limitedBytes = measureExternalActionResultResponseEnvelopeUtf8BytesV1({ ok: true, ...limited });
    let rowBytes = 0;
    let fittingRows = 0;
    let stopped = originalBytes > EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES;
    return {
        get stopped() { return stopped; },
        add(row: OwnServerReadOnlyDataQueryResult['rows'][number]): boolean {
            const added = Buffer.byteLength(JSON.stringify(row), 'utf8') + (rows.length ? 1 : 0);
            if (originalBytes + rowBytes + added > EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES) {
                stopped = true;
                rows.length = fittingRows;
                return false;
            }
            rows.push(row);
            rowBytes += added;
            if (limitedBytes + rowBytes <= EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES) fittingRows = rows.length;
            return true;
        },
        result(): OwnServerReadOnlyDataQueryResult {
            if (!stopped) return original;
            // A header can itself exceed the carrier. Preserve it whenever its
            // incomplete framing fits; otherwise return only the typed reason.
            return limitedBytes <= EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES ? limited : { ...limited, columns: [], rows: [] };
        },
    };
}

type CsvField = { value: string; quoted: boolean };
function readCsv(stdout: string, truncated: boolean): OwnServerReadOnlyDataQueryResult {
    let output: ReturnType<typeof queryRows> | undefined;
    let columnCount = 0;
    let record: CsvField[] = [];
    let field = '';
    let quoted = false;
    let inQuote = false;
    let closedQuote = false;
    const endField = () => { record.push({ value: field, quoted }); field = ''; quoted = false; closedQuote = false; };
    const endRecord = () => {
        endField();
        if (!output) {
            columnCount = record.length;
            output = queryRows(record.map(column => ({ name: column.value })), truncated);
        } else {
            if (record.length !== columnCount) refuse('query_failed', 'invalid_native_result');
            output.add(record.map(value => !value.quoted && value.value === '' ? null : value.value));
        }
        record = [];
    };
    for (let index = 0; index < stdout.length; index++) {
        const char = stdout[index]!;
        if (inQuote) {
            if (char === '"' && stdout[index + 1] === '"') { field += '"'; index++; }
            else if (char === '"') { inQuote = false; closedQuote = true; }
            else field += char;
        } else if (char === ',') endField();
        else if (char === '\n') endRecord();
        else if (char === '\r' && stdout[index + 1] === '\n') { endRecord(); index++; }
        else if (char === '"' && !field && !closedQuote) { inQuote = true; quoted = true; }
        else if (closedQuote || char === '"') refuse('query_failed', 'invalid_native_result');
        else field += char;
        if (output?.stopped) return output.result();
    }
    if (!truncated && (inQuote || field.length || record.length || closedQuote)) {
        if (inQuote) refuse('query_failed', 'invalid_native_result');
        endRecord();
    }
    return (output ?? queryRows([], truncated)).result();
}

function xmlText(value: string): string {
    return value.replace(/&([^;]+);/g, (_whole, entity: string) => {
        const named: Readonly<Record<string, string>> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
        if (named[entity] !== undefined) return named[entity]!;
        const number = entity.startsWith('#x') ? Number.parseInt(entity.slice(2), 16)
            : entity.startsWith('#') ? Number(entity.slice(1)) : NaN;
        if (!Number.isInteger(number) || number < 0 || number > 0x10ffff) return refuse('query_failed', 'invalid_native_result');
        return String.fromCodePoint(number);
    });
}
function readMysqlXml(stdout: string, truncated: boolean): OwnServerReadOnlyDataQueryResult {
    if (/<!DOCTYPE|<!ENTITY/i.test(stdout)) refuse('query_failed', 'invalid_native_result');
    const sets = [...stdout.matchAll(/<resultset\b[^>]*>([\s\S]*?)(?:<\/resultset>|$)/g)];
    if (sets.length > 1) refuse('unsupported_action', 'unsupported_multi_result');
    if (!truncated && stdout.trim() && (!sets.length || !stdout.includes('</resultset>'))) refuse('query_failed', 'invalid_native_result');
    const columns: { name: string }[] = [];
    let output: ReturnType<typeof queryRows> | undefined;
    for (const row of sets[0]?.[1]?.matchAll(/<row>([\s\S]*?)<\/row>/g) ?? []) {
        const names: string[] = [];
        const values: (string | null)[] = [];
        const fields = /<field name="([^"]*)"(?:\s+xsi:nil="(true)")?\s*(?:\/>|>([\s\S]*?)<\/field>)/g;
        for (const field of row[1]!.matchAll(fields)) {
            names.push(xmlText(field[1]!));
            values.push(field[2] === 'true' ? null : xmlText(field[3] ?? ''));
        }
        if (row[1]!.replace(fields, '').trim()) refuse('query_failed', 'invalid_native_result');
        if (!output) {
            columns.push(...names.map(name => ({ name })));
            output = queryRows(columns, truncated);
            if (output.stopped) return output.result();
        }
        if (names.length !== columns.length || names.some((name, index) => name !== columns[index]?.name)) {
            refuse('query_failed', 'invalid_native_result');
        }
        if (!output.add(values)) return output.result();
    }
    return (output ?? queryRows(columns, truncated)).result();
}

/** Host admission owns Environment, service/container identity and secret
 * materialization. This adapter is bound to that one native container; no
 * inventory, alternate credentials, database discovery or admin fallback. */
export async function executeOwnServerReadOnlyDataQuery(input: OwnServerReadOnlyDataQueryInput,
    native: OwnServerDataQueryNative): Promise<OwnServerReadOnlyDataQueryResult> {
    assertOwnServerDataQuerySupportedEngine(input.engine);
    const params = Object.entries(input.params);
    const postgres = input.engine === 'postgresql';
    const statement = postgres ? admitPsqlInput(input.sql, 'query') : input.sql;
    const argv = postgres ? ['psql', '-X', '-q', '--no-password', '--host=127.0.0.1', '--username=happier_ro',
        `--dbname=dbname='${input.database.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`, '--csv', '-P', 'footer=off',
        '-v', 'ON_ERROR_STOP=1', ...params.flatMap(([name, value]) => ['-v', `${name}=${value}`])]
        : ['mysql', '--no-defaults', '--binary-mode', '--batch', '--xml',
            '--protocol=TCP', '--host=127.0.0.1', '--user=happier_ro', `--database=${input.database}`];
    if (input.port !== undefined) argv.push(`--port=${input.port}`);
    // The engine's COPY CSV serializer quotes empty text and leaves NULL empty.
    // psql --csv itself emits both as an unquoted empty field, losing the type.
    const sql = postgres ? `BEGIN READ ONLY;\nCOPY (\n${statement}\n) TO STDOUT WITH (FORMAT CSV, HEADER TRUE);\nROLLBACK;\n`
        : `${params.map(([name, value]) => `SET @${name} = ${ownServerMysqlNativeTextLiteral(value)};`).join('\n')}\n`
            + `SET @happier_query_sql = ${ownServerMysqlNativeTextLiteral(input.sql)};\n`
            + 'START TRANSACTION READ ONLY;\nPREPARE happier_query FROM @happier_query_sql;\nEXECUTE happier_query;\nROLLBACK;\n';
    const env: Readonly<Record<string, string>> = postgres ? { PGPASSWORD: input.password, PGHOSTADDR: '',
        PGCLIENTENCODING: 'UTF8', PGOPTIONS: '-c default_transaction_read_only=on -c standard_conforming_strings=on', LC_ALL: 'C' }
        : { MYSQL_PWD: input.password, LC_ALL: 'C' };
    const result = await native.run({ argv, env, stdin: new TextEncoder().encode(sql), signal: input.signal });
    if (result.exitCode === 126 || result.exitCode === 127) refuse('unsupported_action', 'database_client_unavailable');
    if (result.exitCode !== 0) throw new PluginError({ code: 'query_failed', message: 'The database refused the read-only query',
        details: { exitCode: result.exitCode, ...(result.stderr?.includes('happier_read_role_unavailable')
            ? { reason: 'read_role_unavailable' } : {}) } });
    return postgres ? readCsv(result.stdout, result.stdoutTruncated) : readMysqlXml(result.stdout, result.stdoutTruncated);
}
