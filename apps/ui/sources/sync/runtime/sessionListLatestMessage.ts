import { normalizeRawMessage } from '@happier-dev/session-core/raw';
import type { SessionMessageV1 } from '@happier-dev/protocol/sessions/messages/sessionMessagesPageV1';
import { isSessionListPreviewMessage, SESSION_LIST_PREVIEW_TEXT_LIMIT } from '@happier-dev/protocol/sessions/messages/sessionMessageRole';

import { readSessionListRowForServerId } from '@/sync/domains/session/listing/sessionListRowStateLookup';
import { sessionAddressKey, type SessionAddress } from '@/sync/domains/session/sessionAddress';
import { subscribeSessionSurfaceVisibilityReset } from '@/sync/domains/session/sessionSurfaceVisibility';
import { readRegisteredStorageState } from '@/sync/domains/state/storageStateReaderBridge';
import type { Encryption } from '@/sync/encryption/encryption';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { readStoredSessionMessage } from '@/sync/runtime/readStoredSessionContent';
import type { ApiUpdateContainer } from '@/sync/api/types/apiTypes';

type Preview = Readonly<{ seq: number; revision: number; text: string | null }>;
type Demand = Readonly<{ address: SessionAddress; viewports: Set<string> }> & { preview?: Preview };
const viewports = new Map<string, Map<string, Demand>>();
const demands = new Map<string, Demand>();
const rowListeners = new Map<string, Set<() => void>>();
const demandListeners = new Set<() => void>();

function publishDemandChange(): void {
    for (const listener of demandListeners) listener();
}

function publishRowChange(key: string): void {
    for (const listener of rowListeners.get(key) ?? []) listener();
}

function readDemand(address: SessionAddress): Demand | undefined {
    return demands.get(sessionAddressKey(address));
}

/** Publishes only the viewport entrants. Departing rows release their opened text. */
export function replaceSessionListLatestMessageViewport(viewportId: string, addresses: readonly SessionAddress[]): readonly Demand[] {
    const previous = viewports.get(viewportId);
    const next = new Map<string, Demand>();
    const entered: Demand[] = [];
    for (const address of addresses) {
        const key = sessionAddressKey(address);
        let demand = demands.get(key);
        if (!demand) {
            demand = { address, viewports: new Set() };
            demands.set(key, demand);
            entered.push(demand);
        }
        demand.viewports.add(viewportId);
        next.set(key, demand);
    }
    let changed = entered.length > 0;
    for (const [key, demand] of previous ?? []) {
        if (next.has(key)) continue;
        demand.viewports.delete(viewportId);
        if (demand.viewports.size !== 0) continue;
        demands.delete(key);
        if (demand.preview?.text) publishRowChange(key);
        changed = true;
    }
    if (next.size) viewports.set(viewportId, next);
    else viewports.delete(viewportId);
    if (changed) publishDemandChange();
    return entered;
}

subscribeSessionSurfaceVisibilityReset(() => {
    for (const viewportId of viewports.keys()) replaceSessionListLatestMessageViewport(viewportId, []);
});

export function readLatestMessageSessionIds(serverId: string): string[] {
    return [...demands.values()].filter(({ address }) =>
        areServerProfileIdentifiersEquivalent(address.serverId, serverId)).map(({ address }) => address.sessionId);
}

export function subscribeLatestMessageDemand(listener: () => void): () => void {
    demandListeners.add(listener);
    return () => { demandListeners.delete(listener); };
}

export function readSessionListLatestMessage(address: SessionAddress): string | null {
    return readDemand(address)?.preview?.text ?? null;
}

export function subscribeSessionListLatestMessage(address: SessionAddress, listener: () => void): () => void {
    const key = sessionAddressKey(address);
    const listeners = rowListeners.get(key) ?? new Set();
    listeners.add(listener);
    rowListeners.set(key, listeners);
    return () => {
        listeners.delete(listener);
        if (listeners.size === 0) rowListeners.delete(key);
    };
}

export function isSessionListLatestMessageDemandCurrent(demand: Demand): boolean {
    return readDemand(demand.address) === demand;
}

export async function applySessionListLatestMessage(
    demand: Demand, message: SessionMessageV1, encryption: Encryption | null, isCurrent: () => boolean,
): Promise<void> {
    const { address } = demand;
    const revision = message.updatedAt ?? message.createdAt;
    const canApply = () => {
        if (!isCurrent() || !isSessionListLatestMessageDemandCurrent(demand)) return false;
        const previous = demand.preview;
        return !previous || message.seq > previous.seq || (message.seq === previous.seq && revision > previous.revision);
    };
    if (!canApply()) return;
    const row = readSessionListRowForServerId(readRegisteredStorageState()?.sessionListRowsByServerId, address.serverId, address.sessionId);
    if (!row?.encryptionMode) return;
    const sessionEncryption = encryption?.getSessionEncryption(address.sessionId);
    const opened = await readStoredSessionMessage({ message, sessionEncryptionMode: row.encryptionMode,
        decryptMessage: sessionEncryption ? value => sessionEncryption.decryptMessage(value) : undefined });
    if (!opened?.content || !canApply()) return;
    const raw = normalizeRawMessage(opened.id, opened.localId, opened.createdAt, opened.content, { messageRole: opened.messageRole });
    const body = raw?.role === 'user' ? raw.content.text : raw?.role === 'agent'
        ? raw.content.flatMap(part => part.type === 'text' ? [part.text] : []).join(' ')
        : '';
    const text = body.trim().slice(0, SESSION_LIST_PREVIEW_TEXT_LIMIT).replace(/\s+/gu, ' ') || null;
    const previousText = demand.preview?.text ?? null;
    demand.preview = { seq: message.seq, revision, text };
    if (text !== previousText) publishRowChange(sessionAddressKey(address));
}

export function consumeSessionListLatestMessageUpdate(
    body: ApiUpdateContainer['body'], serverId: string, encryption: Encryption | null, isCurrent: () => boolean,
): Promise<void> | undefined {
    if (demands.size === 0 || (body.t !== 'new-message' && body.t !== 'message-updated') || body.delivery !== 'full') return;
    const demand = readDemand({ serverId, sessionId: body.sid });
    if (demand && isSessionListPreviewMessage(body.message)) return applySessionListLatestMessage(demand, body.message, encryption, isCurrent);
}
