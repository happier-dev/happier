import { transferableAbortController } from 'node:util';

if (typeof window !== 'undefined') {
    // jsdom replaces the global signal constructors while fetch still uses Node's.
    const controller = transferableAbortController();
    globalThis.AbortController = controller.constructor as typeof AbortController;
    globalThis.AbortSignal = controller.signal.constructor as typeof AbortSignal;
}
