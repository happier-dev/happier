export type RuntimeErrorKindV1 =
    | 'abort'
    | 'timeout'
    | 'permission'
    | 'network'
    | 'transient'
    | 'unsupported'
    | 'unknown';

export type ClassifiedRuntimeErrorV1 = Readonly<{
    kind: RuntimeErrorKindV1;
    code: string | null;
    message: string;
    retryable: boolean;
}>;

export interface ErrorRuntimeServiceV1 {
    classify(error: unknown): ClassifiedRuntimeErrorV1;
    wrap(error: unknown, fallbackCode?: string): Error;
    report(error: unknown, fields?: Readonly<Record<string, unknown>>): void;
}
