import { vi } from "vitest";

type MockFn = ReturnType<typeof vi.fn>;
type DbMockLeaf = readonly string[];
type DbMockValue = DbMockLeaf | DbMockShape;
type ModuleMockFactory<TModule extends object> = TModule | (() => TModule);
export interface DbMockShape {
    readonly [key: string]: DbMockValue;
}

export type DbMockFromShape<TShape> =
    TShape extends DbMockLeaf
        ? { [K in TShape[number] & string]: MockFn }
        : TShape extends Record<string, unknown>
            ? { [K in keyof TShape]: DbMockFromShape<TShape[K]> }
            : never;

type TransactionalDb<TDb extends object, TTx extends object> = TDb & {
    $transaction: <T>(fn: (tx: TTx) => Promise<T>) => Promise<T>;
};

function isDbMockLeaf(value: DbMockValue): value is DbMockLeaf {
    return Array.isArray(value);
}

function resolveModuleMock<TModule extends object>(module: ModuleMockFactory<TModule>): TModule {
    return typeof module === "function" ? (module as () => TModule)() : module;
}

export function createDbMocks<const TShape extends DbMockShape>(shape: TShape): {
    db: DbMockFromShape<TShape>;
    reset: () => void;
} {
    const fns: MockFn[] = [];

    const build = (current: DbMockValue): Record<string, unknown> => {
        if (isDbMockLeaf(current)) {
            const delegate = {} as Record<string, MockFn>;
            for (const method of current) {
                const fn = vi.fn();
                fns.push(fn);
                delegate[method] = fn;
            }
            return delegate;
        }

        const nested = {} as Record<string, unknown>;
        for (const [key, value] of Object.entries(current)) {
            nested[key] = build(value);
        }
        return nested;
    };

    return {
        db: build(shape) as DbMockFromShape<TShape>,
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
    const transaction = vi.fn(async <T>(fn: (tx: TTx) => Promise<T>): Promise<T> => await fn(createTxState()));

    return {
        transaction,
        wrapDb<TDb extends object>(db: TDb): TransactionalDb<TDb, TTx> {
            return {
                ...db,
                $transaction: async <T>(fn: (tx: TTx) => Promise<T>): Promise<T> => await transaction(fn) as T,
            };
        },
    };
}
