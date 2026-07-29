export type RouteGrantActivationFailurePolicy = 'release' | 'consume';

export type RouteGrantReservation = Readonly<{
    commit: () => void;
    activationFailed: () => void;
}>;

export type AtomicRouteGrantConsumption = Readonly<{
    reserve: (input: Readonly<{
        grantId: string;
        expiresAt: number;
        nowMs: number;
    }>) => RouteGrantReservation | null;
    clear: () => void;
}>;

type GrantConsumptionEntry = {
    expiresAt: number;
    state: 'reserved' | 'consumed';
    reservation: object;
};

/**
 * Atomically reserves verified route-grant identities in one JavaScript turn.
 * Callers instantiate separate stores for route boundaries with different
 * pre-activation failure policies. Committed entries remain until expiry.
 */
export function createAtomicRouteGrantConsumption(input: Readonly<{
    activationFailurePolicy: RouteGrantActivationFailurePolicy;
}>): AtomicRouteGrantConsumption {
    const entriesByGrantId = new Map<string, GrantConsumptionEntry>();

    function pruneExpired(nowMs: number): void {
        for (const [grantId, entry] of entriesByGrantId) {
            if (entry.expiresAt <= nowMs) entriesByGrantId.delete(grantId);
        }
    }

    return {
        reserve(reservationInput) {
            pruneExpired(reservationInput.nowMs);
            if (entriesByGrantId.has(reservationInput.grantId)) return null;

            const reservation = {};
            entriesByGrantId.set(reservationInput.grantId, {
                expiresAt: reservationInput.expiresAt,
                state: 'reserved',
                reservation,
            });

            function readOwnedEntry(): GrantConsumptionEntry | null {
                const entry = entriesByGrantId.get(reservationInput.grantId);
                return entry?.reservation === reservation ? entry : null;
            }

            return {
                commit() {
                    const entry = readOwnedEntry();
                    if (entry) entry.state = 'consumed';
                },
                activationFailed() {
                    const entry = readOwnedEntry();
                    if (!entry || entry.state === 'consumed') return;
                    if (input.activationFailurePolicy === 'release') {
                        entriesByGrantId.delete(reservationInput.grantId);
                        return;
                    }
                    entry.state = 'consumed';
                },
            };
        },
        clear() {
            entriesByGrantId.clear();
        },
    };
}
