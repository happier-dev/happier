import { createLiveMicSession } from './createLiveMicSession';
import type { CreateMicSessionOptions } from './MicSession';

export function createRealtimeMicSession(options: CreateMicSessionOptions = {}) {
    return createLiveMicSession(options);
}
