export type TimeoutBudgetV1 = Readonly<{
    startedAtMs: number;
    timeoutMs: number;
}>;

export interface TimeoutRuntimeServiceV1 {
    withMs<T>(timeoutMs: number, operation: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T>;
    withBudget<T>(budget: TimeoutBudgetV1, operation: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T>;
}
