import { vi } from 'vitest';
import type { PasswordEnvelopeKdfV1 } from '@happier-dev/protocol/auth/accountPasswordCredential';

/** Worker IO stand-in; password validation, cancellation and envelope crypto remain real. */
export function installPasswordKdfWorkerBoundary(): void {
    vi.stubGlobal('Worker', class {
        onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
        onerror: (() => void) | null = null;
        onmessageerror: (() => void) | null = null;
        private terminated = false;

        postMessage(input: { password: Uint8Array; kdf: PasswordEnvelopeKdfV1 }): void {
            // postMessage copies synchronously; the real adapter clears its input immediately.
            const password = input.password.slice();
            const seed = new Uint8Array([
                ...password,
                ...new TextEncoder().encode(`${input.kdf.salt}|${input.kdf.opsLimit}|${input.kdf.memLimitBytes}`),
            ]);
            password.fill(0);
            const key = new Uint8Array(32);
            for (let index = 0; index < seed.length; index += 1) {
                const slot = index % key.length;
                key[slot] = (key[slot]! * 31 + seed[index]! + index) & 0xff;
            }
            seed.fill(0);
            queueMicrotask(() => {
                if (this.terminated) key.fill(0);
                else this.onmessage?.({ data: { ok: true, key } } as MessageEvent<unknown>);
            });
        }

        terminate(): void { this.terminated = true; }
    });
}
