import { createRequire } from 'node:module';

import { isBunRuntime } from './isBunRuntime';

type NativeEnvironmentLibrary = Readonly<{
    symbols: Readonly<Record<string, (...args: unknown[]) => number>>;
    close(): void;
}>;
type BunFfi = Readonly<{
    dlopen(path: string, symbols: Record<string, Readonly<{ args: readonly string[]; returns: string }>>): NativeEnvironmentLibrary;
}>;

/**
 * Set a variable that native code reads from the process environment, such as
 * TOKIO_WORKER_THREADS, which Prisma's engine reads once when it starts its
 * runtime. Node's process.env assignment writes the native environment; Bun's
 * process.env is JS-only, so under Bun (the shipped server binaries) the
 * native environment is written directly as well.
 */
export function setNativeEnvironmentVariable(name: string, value: string): void {
    process.env[name] = value;
    if (!isBunRuntime()) return;
    // Bun builtin, resolved only under Bun; Node never loads it.
    const ffi = createRequire(import.meta.url)('bun:ffi') as BunFfi;
    if (process.platform === 'win32') {
        // Rust's std::env reads the Win32 process environment block.
        const wide = (text: string) => Buffer.from(`${text}\0`, 'utf16le');
        const kernel = ffi.dlopen('kernel32.dll', { SetEnvironmentVariableW: { args: ['ptr', 'ptr'], returns: 'i32' } });
        try {
            if (kernel.symbols.SetEnvironmentVariableW!(wide(name), wide(value)) === 0) {
                throw new Error(`SetEnvironmentVariableW failed for ${name}`);
            }
        } finally {
            kernel.close();
        }
        return;
    }
    const narrow = (text: string) => Buffer.from(`${text}\0`, 'utf8');
    const libc = ffi.dlopen(process.platform === 'darwin' ? 'libSystem.B.dylib' : 'libc.so.6',
        { setenv: { args: ['ptr', 'ptr', 'i32'], returns: 'i32' } });
    try {
        if (libc.symbols.setenv!(narrow(name), narrow(value), 1) !== 0) throw new Error(`setenv failed for ${name}`);
    } finally {
        libc.close();
    }
}
