import { vi } from "vitest";

type MockFn = ReturnType<typeof vi.fn>;
type DbMockLeaf = readonly string[];
type DbMockValue = DbMockLeaf | DbMockShape;
type ModuleMockFactory<TModule extends object> = TModule | (() => TModule);
export interface DbMockShape {
    readonly [key: string]: DbMockValue;
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

export function createDbTransactionMock<TTx extends object>(createTxState: () => TTx): {
    transaction: ReturnType<typeof vi.fn>;
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
        wrapDb<TDb extends object>(db: TDb): TransactionalDb<TDb, TTx> {
            return {
                ...db,
                $transaction: async <T>(fnOrOperations: ((tx: TTx) => Promise<T>) | readonly unknown[]): Promise<T> =>
                    await transaction(fnOrOperations) as T,
            };
        },
    };
}
