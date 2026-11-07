import type { PublicActionInputById, PublicActionResultById } from '@happier-dev/protocol/actions/actionSpecs';
import { sessionMessagePinRowsMatch, toggleSessionMessagePin } from '@happier-dev/session-core/pins';
import {
    readPersistedSessionMessagePins,
    savePersistedSessionMessagePins,
} from '@/sync/domains/state/sessionMessagePinsPersistence';
import type { LazyActionAccountContext } from './actionAccountContext';

/** Pins stay on this device, under the invoking Home and Account's existing local owner. */
export function executeSessionMessagePinsAction(
    account: LazyActionAccountContext,
    input: PublicActionInputById['session.messages.pins'],
): PublicActionResultById['session.messages.pins'] {
    account.assertCurrent();
    const scope = { serverId: account.serverId, accountId: account.accountId };
    const pins = readPersistedSessionMessagePins(input.sessionId, scope);
    if (input.op === 'read') return { status: 'ready', sessionId: input.sessionId, pins: [...pins] };
    const isPinned = pins.some(existing => sessionMessagePinRowsMatch(existing, input.pin));
    const nextPins = isPinned === (input.op === 'pin') ? pins : toggleSessionMessagePin(pins, input.pin);
    if (nextPins !== pins) savePersistedSessionMessagePins(input.sessionId, nextPins, scope);
    return { status: 'ready', sessionId: input.sessionId, pins: [...nextPins] };
}
