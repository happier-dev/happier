export type LocalServiceRouteLockStore = Readonly<{
    claim(input: Readonly<{ name: string; serviceId: string }>): Readonly<{ ok: true } | { ok: false; reason: 'route_name_claimed' }>;
    release(input: Readonly<{ name: string; serviceId: string }>): void;
}>;

export function createLocalServiceRouteLockStore(): LocalServiceRouteLockStore {
    const claims = new Map<string, string>();
    return {
        claim({ name, serviceId }) {
            const claimedBy = claims.get(name);
            if (claimedBy && claimedBy !== serviceId) {
                return { ok: false, reason: 'route_name_claimed' };
            }
            claims.set(name, serviceId);
            return { ok: true };
        },
        release({ name, serviceId }) {
            if (claims.get(name) === serviceId) {
                claims.delete(name);
            }
        },
    };
}
