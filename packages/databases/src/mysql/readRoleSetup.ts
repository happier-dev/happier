import { scanSqlStatements, type MysqlLexicalOptions } from '../lexer.js';
import { mysqlReadRoleDatabase } from '../readRoleSetup.js';
import { quoteMysqlIdentifier, type MysqlNativeResult } from './operations.js';

export const mysqlReadRoleSettingsQuery = 'SELECT @@GLOBAL.partial_revokes, @@GLOBAL.mandatory_roles';

export function mysqlReadRoleSettings(frame: MysqlNativeResult): Readonly<{ partialRevokes: boolean; mandatoryRoles: string }> {
    const [partialRevokes, mandatoryRoles] = frame.rows[0] ?? [];
    if ((partialRevokes !== 0 && partialRevokes !== 1 && partialRevokes !== '0' && partialRevokes !== '1') || typeof mandatoryRoles !== 'string') {
        throw new Error('MySQL omitted read role settings');
    }
    return { partialRevokes: partialRevokes === 1 || partialRevokes === '1', mandatoryRoles };
}

export function mysqlGeneratedReadPassword(frame: MysqlNativeResult, role: string): string | undefined {
    const cell = (name: string) => frame.rows[0]?.[frame.fields.findIndex(field => field.name === name)];
    const password = cell('generated password');
    return frame.rows.length === 1 && cell('user') === role && cell('host') === '%'
        && typeof password === 'string' && password.length > 0 ? password : undefined;
}

export function mysqlManagedReadGrants(frame: MysqlNativeResult, role: string, database: string, partialRevokes: boolean): boolean {
    const account = `${quoteMysqlIdentifier(role)}@\`%\``;
    const grants = new Set(frame.rows.map(row => row[0]));
    return grants.size === 2 && grants.has(`GRANT USAGE ON *.* TO ${account}`)
        && grants.has(`GRANT SELECT, SHOW VIEW ON ${mysqlReadRoleDatabase(database, partialRevokes)}.* TO ${account}`);
}

/** SHOW GRANTS for the authenticated login includes mandatory roles and every direct grant.
 * Accept read privileges in the selected database and the server's empty global grant. */
export function mysqlVerifyReadGrants(frame: MysqlNativeResult, database: string, partialRevokes: boolean, lexical: MysqlLexicalOptions): boolean {
    let canSelect = false;
    const selectedSchema = mysqlReadRoleDatabase(database, partialRevokes);
    const selectedTableSchema = quoteMysqlIdentifier(database);
    for (const row of frame.rows) {
        const grant = row[0];
        if (typeof grant !== 'string') return false;
        const { tokens, ranges } = scanSqlStatements(grant, 'mysql', lexical);
        const raw = tokens.map(token => grant.slice(token.start, token.end));
        const on = raw.indexOf('ON');
        if (ranges.length !== 1 || raw[0] !== 'GRANT' || on < 2 || raw.length !== on + 8
            || raw[on + 2] !== '.' || raw[on + 4] !== 'TO' || raw[on + 6] !== '@'
            || tokens[on + 5]?.kind !== 'identifier' || tokens[on + 7]?.kind !== 'identifier') return false;
        const schema = raw[on + 1];
        const relation = raw[on + 3];
        const permissions = raw.slice(1, on).join(' ').split(' , ');
        if (schema === '*' && relation === '*' && permissions.length === 1 && permissions[0] === 'USAGE') continue;
        if ((relation === '*' ? schema !== selectedSchema : schema !== selectedTableSchema || tokens[on + 3]?.kind !== 'identifier')
            || permissions.some(permission => permission !== 'SELECT' && permission !== 'SHOW VIEW')) return false;
        canSelect ||= permissions.includes('SELECT');
    }
    return canSelect;
}
