export type ProgressStateV1 = 'active' | 'finished' | 'failed';

export type ProgressSnapshotV1 = Readonly<{
    id: string;
    label: string;
    state: ProgressStateV1;
    current: number | null;
    total: number | null;
    message: string | null;
}>;

export type ProgressHandleV1 = Readonly<{
    id: string;
    report(update: Readonly<{
        current?: number | null;
        total?: number | null;
        message?: string | null;
    }>): void;
    finish(message?: string | null): void;
    fail(error: unknown): void;
    snapshot(): ProgressSnapshotV1;
}>;

export interface ProgressRuntimeServiceV1 {
    start(params: Readonly<{
        id?: string;
        label: string;
        total?: number | null;
    }>): ProgressHandleV1;
    report(id: string, update: Parameters<ProgressHandleV1['report']>[0]): void;
    finish(id: string, message?: string | null): void;
}
