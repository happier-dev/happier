export type RetryPolicyV1 = Readonly<{
    maxAttempts: number;
    baseDelayMs?: number;
    maxDelayMs?: number;
    signal?: AbortSignal;
}>;

export type RetryAttemptContextV1 = Readonly<{
    attempt: number;
    maxAttempts: number;
    signal?: AbortSignal;
}>;

export interface RetryRuntimeServiceV1 {
    wrap<T>(operation: (context: RetryAttemptContextV1) => Promise<T>, policy: RetryPolicyV1): Promise<T>;
}
