import { createRequire } from 'node:module';

import { warn } from '@/utils/logging/log';
import { isBunRuntime } from './isBunRuntime';

type BunFfi = Readonly<{
    dlopen(path: string, symbols: Record<string, Readonly<{ args: readonly string[]; returns: string }>>): Readonly<{
        symbols: Readonly<{ malloc_trim: (pad: number) => number }>;
    }>;
}>;

let mallocTrim: ((pad: number) => number) | null | undefined;

/**
 * Return glibc's free arena pages to the OS once. Prisma's native engine
 * serves multi-megabyte values from per-thread glibc arenas, which keep the
 * freed memory after the work ends (P03-SERVER-MEMORY: 35 MB in use of 623 MB
 * held). Only the shipped Linux Bun binaries reach glibc from JS (bun:ffi);
 * other runtimes and platforms have nothing to trim here.
 */
export function trimNativeHeap(): boolean {
    if (mallocTrim === undefined) {
        mallocTrim = null;
        if (isBunRuntime() && process.platform === 'linux') {
            try {
                // Bun builtin, resolved only under Bun; Node never loads it.
                const ffi = createRequire(import.meta.url)('bun:ffi') as BunFfi;
                mallocTrim = ffi.dlopen('libc.so.6', { malloc_trim: { args: ['u64'], returns: 'i32' } }).symbols.malloc_trim;
            } catch (error) {
                // A non-glibc Linux (musl) has no malloc_trim; its allocator returns memory itself.
                warn({ module: 'runtime', event: 'native-heap-trim-unavailable', error: String(error) },
                    'glibc malloc_trim is unavailable; native arena memory stays with the allocator');
            }
        }
    }
    if (!mallocTrim) return false;
    mallocTrim(0);
    return true;
}
