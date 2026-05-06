export type ExecLaunchInputV1 = Readonly<{
    kind: 'resolvedExecutable';
    executablePath: string;
    args?: readonly string[];
    cwd?: string;
    env?: Readonly<Record<string, string>>;
    stdin?: string | Uint8Array;
}>;

export type ExecRunOptionsV1 = Readonly<{
    signal?: AbortSignal;
    timeoutMs?: number;
    maxStdoutBytes?: number;
    maxStderrBytes?: number;
}>;

export type ExecRunResultV1 = Readonly<{
    exitCode: number | null;
    signal: string | null;
    stdout: string;
    stderr: string;
}>;

export type ExecProcessHandleV1 = Readonly<{
    pid: number | null;
    exit: Promise<ExecRunResultV1>;
    writeStdin(input: string | Uint8Array): Promise<void>;
    kill(signal?: string): void;
    dispose(): Promise<void>;
}>;

export type ExecClientHandleV1 = Readonly<{
    process: ExecProcessHandleV1;
    request?(message: unknown): Promise<unknown>;
    notify?(message: unknown): Promise<void>;
    dispose(): Promise<void>;
}>;

export interface ExecRuntimeServiceV1 {
    run(input: ExecLaunchInputV1, options?: ExecRunOptionsV1): Promise<ExecRunResultV1>;
    spawn(input: ExecLaunchInputV1, options?: ExecRunOptionsV1): Promise<ExecProcessHandleV1>;
    spawnClient(input: ExecLaunchInputV1, options?: ExecRunOptionsV1): Promise<ExecClientHandleV1>;
}
