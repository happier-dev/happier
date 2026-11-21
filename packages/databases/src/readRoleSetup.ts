import { createHash, createHmac, pbkdf2, randomBytes } from 'node:crypto';
import { promisify } from 'node:util';
import type { DatabaseFailureCauseV1 } from '@happier-dev/plugin-sdk/database';
import { quoteMysqlIdentifier } from './mysql/operations.js';
import { quotePostgresqlIdentifier } from './postgresql/identifiers.js';

export type DatabaseReadRolePlan = Readonly<{
    engine: 'postgresql' | 'mysql';
    database: string;
    role: string;
    statements: readonly string[];
}>;

export type DatabaseReadRoleFailure = Readonly<{
    ok: false;
    status: 'failed' | 'cancelled' | 'outcome_unknown';
    code: string;
    cause?: DatabaseFailureCauseV1;
}>;

/** The password is returned only to the binding owner for private storage. */
export type DatabaseReadRoleSetupResult = Readonly<{ ok: true; password: string }> | DatabaseReadRoleFailure;
export type DatabaseReadRoleVerificationResult = Readonly<{ ok: true }> | DatabaseReadRoleFailure;

export type DatabaseReadRoleConnection = Readonly<{
    prepareReadRole(role: string, signal?: AbortSignal): Promise<DatabaseReadRolePlan>;
    setupReadRole(plan: DatabaseReadRolePlan, signal?: AbortSignal): Promise<DatabaseReadRoleSetupResult>;
    verifyReadRole(signal?: AbortSignal): Promise<DatabaseReadRoleVerificationResult>;
}>;

type PlanInput = Readonly<{ database: string; role: string }> & (
    Readonly<{ engine: 'postgresql'; schemas: readonly string[] }>
    | Readonly<{ engine: 'mysql'; partialRevokes: boolean }>
);

const scramPlaceholder = '<generated SCRAM verifier>';
const deriveKeys = promisify(pbkdf2);
const readRolePrefix = 'happier_ro_';
const readRoleRandomBytes = 8;
const readRoleName = new RegExp(`^${readRolePrefix}[a-f0-9]{${readRoleRandomBytes * 2}}$`, 'u');

export function generateDatabaseReadRoleName(): string {
    return `${readRolePrefix}${randomBytes(readRoleRandomBytes).toString('hex')}`;
}

export class DatabaseReadRoleError extends Error {
    constructor(readonly failure: DatabaseReadRoleFailure) {
        super(failure.code);
        this.name = 'DatabaseReadRoleError';
    }
}

export function readRoleFailure(code: string, status: DatabaseReadRoleFailure['status'] = 'failed', cause?: DatabaseFailureCauseV1): DatabaseReadRoleFailure {
    return { ok: false, code, status, ...(cause ? { cause: {
        source: cause.source,
        code: /^[0-9A-Z_]+$/u.test(cause.code) ? cause.code : 'action_failed',
        // Native errors can carry SQL, connection details and generated authentication data.
        message: 'The database read role operation failed',
    } } : {}) };
}

export function mysqlReadRoleAccount(role: string): string {
    // Used only for a role accepted by the planner.
    return `'${role}'@'%'`;
}

export function mysqlReadRoleDatabase(database: string, partialRevokes: boolean): string {
    return quoteMysqlIdentifier(partialRevokes ? database : database.replace(/[\\_%]/gu, '\\$&'));
}

export function planDatabaseReadRoleSetup(input: PlanInput): DatabaseReadRolePlan {
    const { engine, database, role } = input;
    if (!readRoleName.test(role)) throw new Error('Invalid database read role name');
    if (!database || database.includes('\0')) throw new Error('Invalid database name');
    if (engine === 'mysql') {
        const account = mysqlReadRoleAccount(role);
        const grantDatabase = mysqlReadRoleDatabase(database, input.partialRevokes);
        return { engine, database, role, statements: [
            `CREATE USER ${account} IDENTIFIED BY RANDOM PASSWORD REQUIRE SSL ACCOUNT LOCK`,
            `GRANT SELECT, SHOW VIEW ON ${grantDatabase}.* TO ${account}`,
            `ALTER USER ${account} ACCOUNT UNLOCK`,
        ] };
    }
    const account = quotePostgresqlIdentifier(role);
    const schemas = [...new Set(input.schemas)].sort();
    return { engine, database, role, statements: [
        `CREATE ROLE ${account} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD ${scramPlaceholder}`,
        `GRANT CONNECT ON DATABASE ${quotePostgresqlIdentifier(database)} TO ${account}`,
        ...schemas.flatMap(schema => {
            if (!schema || schema.includes('\0')) throw new Error('Invalid database schema name');
            const identifier = quotePostgresqlIdentifier(schema);
            return [`GRANT USAGE ON SCHEMA ${identifier} TO ${account}`, `GRANT SELECT ON ALL TABLES IN SCHEMA ${identifier} TO ${account}`];
        }),
        `ALTER ROLE ${account} SET default_transaction_read_only = on`,
    ] };
}

export function matchesDatabaseReadRolePlan(reviewed: DatabaseReadRolePlan, current: DatabaseReadRolePlan): boolean {
    return reviewed.engine === current.engine && reviewed.database === current.database && reviewed.role === current.role
        && reviewed.statements.length === current.statements.length
        && current.statements.every((statement, index) => statement === reviewed.statements[index]);
}

export async function postgresqlReadRolePassword(): Promise<Readonly<{ password: string; statement(reviewed: string): string }>> {
    // Base64url is ASCII, so applying SCRAM's SASLprep normalization would leave the password unchanged.
    const password = randomBytes(32).toString('base64url');
    const salt = randomBytes(16);
    const iterations = 4096;
    const salted = await deriveKeys(password, salt, iterations, 32, 'sha256');
    const clientKey = createHmac('sha256', salted).update('Client Key').digest();
    const storedKey = createHash('sha256').update(clientKey).digest('base64');
    const serverKey = createHmac('sha256', salted).update('Server Key').digest('base64');
    const verifier = `SCRAM-SHA-256$${iterations}:${salt.toString('base64')}$${storedKey}:${serverKey}`;
    return { password, statement: reviewed => reviewed.replace(scramPlaceholder, () => `'${verifier}'`) };
}
