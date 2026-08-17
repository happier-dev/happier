export type AfterTxCallback = () => void | Promise<void>;
export type TxWithAfterTxCallbacks = {
    __afterTxCallbacks: AfterTxCallback[];
};

type SessionTransactionRow = Readonly<{
    id: string;
    seq: number;
    updatedAt: Date;
}> & Readonly<Record<string, unknown>>;

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function compareSessionField(actual: unknown, condition: unknown): boolean {
    if (!isRecord(condition)) return Object.is(actual, condition);

    if ("equals" in condition && !Object.is(actual, condition.equals)) return false;
    if ("in" in condition) {
        if (!Array.isArray(condition.in) || !condition.in.some((value) => Object.is(actual, value))) return false;
    }

    const comparableActual = actual instanceof Date ? actual.getTime() : actual;
    for (const [operator, expected] of Object.entries(condition)) {
        if (operator === "equals" || operator === "in") continue;
        const comparableExpected = expected instanceof Date ? expected.getTime() : expected;
        if (operator === "lt" && !(comparableActual! < comparableExpected!)) return false;
        if (operator === "lte" && !(comparableActual! <= comparableExpected!)) return false;
        if (operator === "gt" && !(comparableActual! > comparableExpected!)) return false;
        if (operator === "gte" && !(comparableActual! >= comparableExpected!)) return false;
        if (!["lt", "lte", "gt", "gte"].includes(operator)) {
            throw new Error(`Unsupported Session transaction harness filter: ${operator}`);
        }
    }
    return true;
}

function sessionRowMatchesWhere(row: SessionTransactionRow, where: unknown): boolean {
    if (!isRecord(where)) return true;
    if ("AND" in where) {
        if (!Array.isArray(where.AND) || !where.AND.every((clause) => sessionRowMatchesWhere(row, clause))) {
            return false;
        }
    }
    for (const [field, condition] of Object.entries(where)) {
        if (field === "AND") continue;
        if (!compareSessionField(row[field], condition)) return false;
    }
    return true;
}

export function createSessionTransactionModel<TRow extends SessionTransactionRow>(initialRow: TRow | null) {
    let row: TRow | null = initialRow ? { ...initialRow } : null;

    const session = {
        findFirst: async (args: { where?: unknown } = {}): Promise<TRow | null> =>
            row && sessionRowMatchesWhere(row, args.where) ? { ...row } : null,
        updateMany: async (args: { where?: unknown; data?: unknown }): Promise<{ count: number }> => {
            if (!row || !sessionRowMatchesWhere(row, args.where)) return { count: 0 };
            const data = isRecord(args.data) ? args.data : {};
            const seqUpdate = isRecord(data.seq) ? data.seq : null;
            const increment = typeof seqUpdate?.increment === "number" ? seqUpdate.increment : 0;
            row = {
                ...row,
                seq: row.seq + increment,
                updatedAt: data.updatedAt instanceof Date ? data.updatedAt : new Date(),
            };
            return { count: 1 };
        },
        deleteMany: async (args: { where?: unknown } = {}): Promise<{ count: number }> => {
            if (!row || !sessionRowMatchesWhere(row, args.where)) return { count: 0 };
            row = null;
            return { count: 1 };
        },
    };

    return {
        session,
        readSession: (): TRow | null => row && { ...row },
    };
}

export function withAfterTxCallbacks<TTx extends object>(
    txState: TTx,
): TTx & TxWithAfterTxCallbacks {
    return {
        __afterTxCallbacks: [],
        ...txState,
    };
}

export function registerAfterTxCallback(
    tx: TxWithAfterTxCallbacks,
    callback: AfterTxCallback,
): void {
    tx.__afterTxCallbacks.push(callback);
}

export async function flushAfterTxCallbacks(
    tx: TxWithAfterTxCallbacks,
): Promise<void> {
    for (const callback of tx.__afterTxCallbacks) {
        await callback();
    }
}

export function createInTxHarness<TTx extends object>(createTxState: () => TTx) {
    const afterTx = (tx: any, callback: AfterTxCallback) => {
        registerAfterTxCallback(tx, callback);
    };

    const inTx = async <T>(fn: (tx: TTx) => Promise<T>): Promise<T> => {
        const tx = withAfterTxCallbacks(createTxState()) as any;

        const result = await fn(tx as TTx);
        await flushAfterTxCallbacks(tx);
        return result;
    };

    return { inTx, afterTx };
}
