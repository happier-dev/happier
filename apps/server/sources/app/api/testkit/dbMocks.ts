import { vi } from "vitest";

type MockFn = ReturnType<typeof vi.fn>;
type DbMockLeaf = readonly string[];
type DbMockValue = DbMockLeaf | DbMockShape;
type ModuleMockFactory<TModule extends object> = TModule | (() => TModule);
export interface DbMockShape {
    readonly [key: string]: DbMockValue;
}

function isDbMockRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value) && !(value instanceof Date);
}

/** Evaluates the Prisma where subset used by stateful transaction fixtures. */
export function matchesDbMockWhere(actual: unknown, expected: unknown): boolean {
    if (!isDbMockRecord(expected)) return actual instanceof Date && expected instanceof Date
        ? actual.getTime() === expected.getTime() : actual === expected;
    for (const [key, value] of Object.entries(expected)) {
        if (key === "AND" || key === "OR") {
            const clauses = Array.isArray(value) ? value : [value];
            if (key === "AND" ? !clauses.every(clause => matchesDbMockWhere(actual, clause)) : !clauses.some(clause => matchesDbMockWhere(actual, clause))) return false;
        } else if (key === "equals" || key === "is") {
            if (!matchesDbMockWhere(actual, value)) return false;
        } else if (key === "not") {
            if (matchesDbMockWhere(actual, value)) return false;
        } else if (key === "in" || key === "notIn") {
            if (!Array.isArray(value)) throw new Error("Invalid database set predicate");
            if (key === "in" ? !value.includes(actual) : value.includes(actual)) return false;
        } else if (key === "some" || key === "none") {
            if (!Array.isArray(actual)) return false;
            const hasMatch = actual.some(item => matchesDbMockWhere(item, value));
            if (key === "some" ? !hasMatch : hasMatch) return false;
        } else if (key === "lt" || key === "lte" || key === "gt" || key === "gte") {
            const left = actual instanceof Date ? actual.getTime() : actual;
            const right = value instanceof Date ? value.getTime() : value;
            if ((typeof left !== "number" && typeof left !== "bigint") || (typeof right !== "number" && typeof right !== "bigint")) return false;
            if (key === "lt" ? !(left < right) : key === "lte" ? !(left <= right) : key === "gt" ? !(left > right) : !(left >= right)) return false;
        } else if (!isDbMockRecord(actual) || !matchesDbMockWhere(actual[key], value)) return false;
    }
    return true;
}

/**
 * Field references (`db.<model>.fields.<column>`) are how Prisma expresses a column-to-column
 * comparison in a `where`, so a mocked delegate has to carry them the way a real one does.
 */
export interface DbMockFieldRef {
    readonly modelName: string;
    readonly name: string;
}

export type DbMockFromShape<TShape> =
    TShape extends DbMockLeaf
        ? { [K in TShape[number] & string]: MockFn } & { fields: Record<string, DbMockFieldRef> }
        : TShape extends Record<string, unknown>
            ? { [K in keyof TShape]: DbMockFromShape<TShape[K]> }
            : never;

type TransactionalDb<TDb extends object, TTx extends object> = TDb & {
    $transaction: {
        <T>(fn: (tx: TTx) => Promise<T>): Promise<T>;
        <T extends readonly unknown[]>(operations: T): Promise<{ [K in keyof T]: Awaited<T[K]> }>;
    };
};

function isDbMockLeaf(value: DbMockValue): value is DbMockLeaf {
    return Array.isArray(value);
}

function resolveModuleMock<TModule extends object>(module: ModuleMockFactory<TModule>): TModule {
    return typeof module === "function" ? (module as () => TModule)() : module;
}

function createDbMockFieldRefs(modelName: string): Record<string, DbMockFieldRef> {
    // Any column may be referenced, and the shape only declares delegate methods, so resolve field
    // refs on demand instead of enumerating columns the mock does not know about.
    return new Proxy({} as Record<string, DbMockFieldRef>, {
        get(_target, property) {
            return typeof property === "string"
                ? { modelName, name: property }
                : undefined;
        },
    });
}

export function createDbMocks<const TShape extends DbMockShape>(shape: TShape): {
    db: DbMockFromShape<TShape>;
    reset: () => void;
} {
    const fns: MockFn[] = [];

    const build = (current: DbMockValue, modelName: string): Record<string, unknown> => {
        if (isDbMockLeaf(current)) {
            const delegate = { fields: createDbMockFieldRefs(modelName) } as Record<string, unknown>;
            for (const method of current) {
                const fn = vi.fn();
                fns.push(fn);
                delegate[method] = fn;
            }
            return delegate;
        }

        const nested = {} as Record<string, unknown>;
        for (const [key, value] of Object.entries(current)) {
            nested[key] = build(value, key);
        }
        return nested;
    };

    return {
        db: build(shape, "") as DbMockFromShape<TShape>,
        reset() {
            for (const fn of fns) {
                fn.mockReset();
            }
        },
    };
}

export function installDbModuleMock<TModule extends object>(module: ModuleMockFactory<TModule>): void {
    vi.doMock("@/storage/db", () => resolveModuleMock(module));
}

export function installPrismaModuleMock<TModule extends object>(module: ModuleMockFactory<TModule>): void {
    vi.doMock("@/storage/prisma", () => resolveModuleMock(module));
}

/** Mirrors the transaction-local PostgreSQL control statements owned by `inTx`. */
export const inTxPostgresControlStatementMock = {
    async $executeRaw(query: TemplateStringsArray, ...values: unknown[]): Promise<number> {
        if (query.join('?').trim() === 'SET TRANSACTION READ ONLY' && values.length === 0) return 0;
        throw new Error('Unexpected fixture SQL');
    },
    async $queryRaw(query: TemplateStringsArray, ...values: unknown[]) {
        if (query.join('?').trim() === 'SHOW statement_timeout' && values.length === 0) return [{ statement_timeout: '0' }];
        throw new Error('Unexpected fixture SQL');
    },
    async $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number> {
        if (/^SET LOCAL statement_timeout = [1-9]\d*$/.test(query) && values.length === 0) return 0;
        if (/^SET LOCAL application_name = '[a-zA-Z0-9._-]+:[a-zA-Z0-9-]+'$/.test(query) && values.length === 0) return 0;
        throw new Error('Unexpected fixture SQL');
    },
};

export function createDbTransactionMock<TTx extends object>(createTxState: () => TTx): {
    transaction: ReturnType<typeof vi.fn>;
    readSnapshot: <T>(read: (reader: TTx) => Promise<T>) => Promise<T>;
    wrapDb: <TDb extends object>(db: TDb) => TransactionalDb<TDb, TTx>;
} {
    const transaction = vi.fn(async <T>(fnOrOperations: ((tx: TTx) => Promise<T>) | readonly unknown[]): Promise<T> => {
        if (typeof fnOrOperations === "function") {
            return await fnOrOperations(createTxState());
        }

        return await Promise.all(fnOrOperations) as T;
    });

    return {
        transaction,
        // Substitute the persistent connection only; the real reader callback
        // still owns configuration, policy, and query interpretation.
        readSnapshot: async <T>(read: (reader: TTx) => Promise<T>): Promise<T> =>
            await read(createTxState()),
        wrapDb<TDb extends object>(db: TDb): TransactionalDb<TDb, TTx> {
            return {
                ...db,
                $transaction: async <T>(fnOrOperations: ((tx: TTx) => Promise<T>) | readonly unknown[]): Promise<T> =>
                    await transaction(fnOrOperations) as T,
            };
        },
    };
}
