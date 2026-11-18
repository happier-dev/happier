import type { ApiSocketStatus } from './apiSocket';

/**
 * How every reader presents the applied socket's status. A `paused` socket (a hidden web tab or a
 * backgrounded app) was stopped on purpose and is never presented as a loss:
 * - its status presents as `connecting`: the resume reconnects, so status chrome reads "reconnecting";
 * - the Home it was serving stays presented online until the resume settles or a real failure lands.
 *
 * Transport logic that needs live delivery (catch-up after resume, readiness to carry traffic) reads
 * the raw status instead: a paused socket delivers nothing until it reconnects.
 */
export type PresentedSocketStatus = Exclude<ApiSocketStatus, 'paused'>;

export function presentSocketStatus(status: ApiSocketStatus): PresentedSocketStatus {
    return status === 'paused' ? 'connecting' : status;
}

/** Whether the socket keeps its Home presented online: connected, or paused while connected. */
export function socketPresentsHomeOnline(status: ApiSocketStatus): boolean {
    return status === 'connected' || status === 'paused';
}
