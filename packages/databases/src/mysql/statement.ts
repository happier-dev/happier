import { DatabaseStatementError, databaseStatementWords, normalizeScannedStatement, scanSqlStatements, type MysqlLexicalOptions } from '../statement.js';
export type { MysqlLexicalOptions } from '../statement.js';

export const mysqlStatementRanges = (sql: string, options?: MysqlLexicalOptions) => scanSqlStatements(sql, 'mysql', options).ranges;
export const normalizeMysqlStatement = (sql: string, options?: MysqlLexicalOptions) => normalizeScannedStatement(sql, scanSqlStatements(sql, 'mysql', options));

/** MySQL 8.4 implicit-commit and non-rollbackable statements cannot participate
 * in the caller-owned transaction (including an ordered write batch).
 * https://dev.mysql.com/doc/refman/8.4/en/implicit-commit.html */
export function admitMysqlWorkbenchStatement(sql: string, options?: MysqlLexicalOptions): string {
    const { tokens, ranges } = scanSqlStatements(sql, 'mysql', options);
    if (ranges.length !== 1) throw new DatabaseStatementError('unsupported_multi_result');
    const words = databaseStatementWords(sql, tokens);
    const first = words[0];
    const transaction = ['BEGIN', 'COMMIT', 'ROLLBACK', 'SAVEPOINT', 'RELEASE', 'START', 'XA'].includes(first ?? '');
    const implicitCommit = ['ALTER', 'CREATE', 'DROP', 'TRUNCATE', 'RENAME', 'GRANT', 'REVOKE', 'INSTALL', 'UNINSTALL',
        'LOCK', 'UNLOCK', 'ANALYZE', 'CACHE', 'CHECK', 'FLUSH', 'LOAD', 'OPTIMIZE', 'REPAIR', 'RESET', 'STOP', 'CHANGE'].includes(first ?? '');
    // SQL PREPARE/EXECUTE could hide an implicit commit in the statement body.
    const dynamicSql = first === 'PREPARE' || first === 'EXECUTE' || first === 'DEALLOCATE' || first === 'CALL';
    const modeSetting = first === 'SET' && (words[1] === 'PASSWORD' || (words[1] === 'DEFAULT' && words[2] === 'ROLE')
        || words.some(word => ['TRANSACTION', 'TRANSACTION_READ_ONLY', 'TX_READ_ONLY', 'AUTOCOMMIT', 'SQL_MODE'].includes(word)));
    if (transaction || implicitCommit || dynamicSql || modeSetting) throw new DatabaseStatementError('mysql_transaction_control');
    return sql.slice(ranges[0]!.start, ranges[0]!.end);
}
