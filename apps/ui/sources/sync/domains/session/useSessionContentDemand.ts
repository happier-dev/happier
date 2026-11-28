import * as React from 'react';

import { isSessionContentUnsettled as isSessionRowContentUnsettled, readSessionContentAvailability } from '@/sync/domains/session/encryptedContentAvailability';
import { readSessionListRowForServerId } from '@/sync/domains/session/listing/sessionListRowStateLookup';
import { sessionAddressKey, type SessionAddress } from '@/sync/domains/session/sessionAddress';
import { retainVisibleSessionListSurfaces, type SessionListContentDemand } from '@/sync/domains/session/sessionSurfaceVisibility';
import { readRegisteredStorageState } from '@/sync/domains/state/storageStateReaderBridge';
import { sync } from '@/sync/sync';
import { fireAndForget } from '@/utils/system/fireAndForget';

/**
 * Whether a Session's content is still waiting for a decision: an encrypted row no decryption owner
 * has settled yet (neither readable nor blocked). A row this device has not listed is undecided too.
 */
function isSessionContentUnsettled(address: SessionAddress, demand: SessionListContentDemand): boolean {
    const row = readSessionListRowForServerId(
        readRegisteredStorageState()?.sessionListRowsByServerId, address.serverId, address.sessionId,
    );
    return row === null || isSessionRowContentUnsettled(row)
        || (demand === 'list-display' && row.metadata === null && readSessionContentAvailability(row) === 'ready');
}

/**
 * The one owner of "a surface that shows a Session demands its content". A Session shown anywhere
 * outside its own page names itself from encrypted content, and an encrypted row nobody has decided is
 * only unsettled, not locked: without this demand it reads as "Encrypted session" until some other
 * surface happens to hydrate it. Every such surface passes the Sessions it shows right now; this retains
 * them as visible, hydrates the ones that entered the demand, and releases them when the surface
 * hides, unmounts or its Home scope resets.
 *
 * - `viewport` hydrates every Session that enters (a scrolling list refreshes each row it reveals).
 * - `unsettled` hydrates only entered Sessions whose content is still undecided.
 */
export function useSessionContentDemand(
    addresses: readonly SessionAddress[],
    options: Readonly<{
        tag: string;
        hydrate: 'viewport' | 'unsettled';
        /** Naming chrome needs the admitted display row, without a full Session carrier. */
        contentDemand?: SessionListContentDemand;
        /** The surface is not showing its Sessions (inactive pane): nothing is demanded. */
        active?: boolean;
        /** A server-scope reset releases every retained row; re-entry then hydrates again. */
        resetVersion?: number;
        /** Reports completion of this entry's acquisition, including a settled refusal. */
        onSettled?: () => void;
        /** A visible result row also consumes its selected Turn's final reply. */
        resultTurnId?: string;
    }>,
): React.RefObject<Promise<void> | null> {
    const pending = React.useRef<Promise<void> | null>(null);
    const { tag, hydrate, active = true, resetVersion = 0, onSettled, resultTurnId } = options;
    const contentDemand = resultTurnId ? 'session' : options.contentDemand ?? 'session';
    const previous = React.useRef<Readonly<{ keys: ReadonlySet<string>; resetVersion: number }>>({ keys: new Set(), resetVersion });
    // Callers rebuild their arrays freely; the demand follows the Sessions, not the array identity.
    const demandKey = (address: SessionAddress) => JSON.stringify([sessionAddressKey(address), resultTurnId, contentDemand]);
    const identity = addresses.map(demandKey).join('\u0000');
    React.useEffect(() => {
        const demanded = active ? addresses : [];
        const earlier = previous.current.resetVersion === resetVersion ? previous.current.keys : new Set<string>();
        previous.current = { keys: new Set(demanded.map(demandKey)), resetVersion };
        if (demanded.length === 0) return;
        const entered = demanded.filter(address => !earlier.has(demandKey(address)));
        const release = retainVisibleSessionListSurfaces(demanded, contentDemand);
        const toHydrate = hydrate === 'unsettled' && !resultTurnId ? entered.filter(address => isSessionContentUnsettled(address, contentDemand)) : entered;
        let current = true;
        const settled = () => { if (current) onSettled?.(); };
        if (toHydrate.length > 0) {
            const acquisition = (resultTurnId
            ? sync.hydrateSessionListRows(toHydrate, { resultTurnId })
            : contentDemand === 'list-display'
                ? sync.hydrateSessionListRows(toHydrate, { contentDemand })
                : sync.hydrateSessionListRows(toHydrate)).finally(settled);
            pending.current = acquisition;
            fireAndForget(acquisition, { tag });
        } else settled();
        return () => { current = false; release(); };
        // The addresses are fully described by their identity key.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [identity, active, resetVersion, hydrate, contentDemand, tag, onSettled]);
    return pending;
}
