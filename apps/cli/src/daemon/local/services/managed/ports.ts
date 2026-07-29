export type LocalServicePortPolicy =
    | Readonly<{ kind: 'fixed'; port: number; onCollision: 'fail' | 'fallback' }>
    | Readonly<{ kind: 'allocated'; preferredPort?: number; onCollision?: 'fail' | 'fallback' }>;

export type LocalServicePortReservationDiagnostic = Readonly<{
    code: string;
    severity: 'warning' | 'error';
}>;

export type LocalServicePortReservationResult =
    | Readonly<{ ok: true; port: number; diagnostics: readonly LocalServicePortReservationDiagnostic[] }>
    | Readonly<{ ok: false; reason: 'port_unavailable' | 'no_available_ports'; diagnostics: readonly LocalServicePortReservationDiagnostic[] }>;

export type LocalServicePortAllocator = Readonly<{
    reserve(input: Readonly<{ serviceId: string; policy: LocalServicePortPolicy }>): LocalServicePortReservationResult;
    /**
     * Claims a port whose exact surviving listener was already verified by the managed
     * runtime. This intentionally does not probe availability: the proved survivor owns it.
     */
    adoptVerified(input: Readonly<{ serviceId: string; port: number }>): LocalServicePortReservationResult;
    release(serviceId: string): void;
}>;

function isValidPort(port: number): boolean {
    return Number.isInteger(port) && port >= 1 && port <= 65_535;
}

export function createLocalServicePortAllocator(input: Readonly<{
    range: Readonly<{ start: number; end: number }>;
    isPortAvailable: (port: number) => boolean;
}>): LocalServicePortAllocator {
    const reservations = new Map<string, number>();
    const reservedPorts = new Set<number>();
    const start = Math.max(1, Math.trunc(input.range.start));
    const end = Math.min(65_535, Math.trunc(input.range.end));

    const canUse = (port: number): boolean => isValidPort(port) && !reservedPorts.has(port) && input.isPortAvailable(port);
    const claim = (serviceId: string, port: number, diagnostics: readonly LocalServicePortReservationDiagnostic[]): LocalServicePortReservationResult => {
        reservations.set(serviceId, port);
        reservedPorts.add(port);
        return { ok: true, port, diagnostics };
    };
    const fallback = (serviceId: string, diagnostics: readonly LocalServicePortReservationDiagnostic[]): LocalServicePortReservationResult => {
        for (let port = start; port <= end; port += 1) {
            if (canUse(port)) {
                return claim(serviceId, port, diagnostics);
            }
        }
        return {
            ok: false,
            reason: 'no_available_ports',
            diagnostics: [...diagnostics, { code: 'no_available_ports', severity: 'error' }],
        };
    };

    return {
        reserve({ serviceId, policy }) {
            const existing = reservations.get(serviceId);
            if (existing !== undefined) return { ok: true, port: existing, diagnostics: [] };
            if (policy.kind === 'fixed') {
                if (canUse(policy.port)) return claim(serviceId, policy.port, []);
                if (policy.onCollision === 'fallback') {
                    return fallback(serviceId, [{ code: 'fixed_port_unavailable', severity: 'warning' }]);
                }
                return {
                    ok: false,
                    reason: 'port_unavailable',
                    diagnostics: [{ code: 'port_unavailable', severity: 'error' }],
                };
            }
            if (policy.preferredPort !== undefined) {
                if (canUse(policy.preferredPort)) return claim(serviceId, policy.preferredPort, []);
                if ((policy.onCollision ?? 'fallback') === 'fail') {
                    return {
                        ok: false,
                        reason: 'port_unavailable',
                        diagnostics: [{ code: 'port_unavailable', severity: 'error' }],
                    };
                }
                return fallback(serviceId, [{ code: 'preferred_port_unavailable', severity: 'warning' }]);
            }
            return fallback(serviceId, []);
        },
        adoptVerified({ serviceId, port }) {
            if (!isValidPort(port)) {
                return {
                    ok: false,
                    reason: 'port_unavailable',
                    diagnostics: [{ code: 'port_unavailable', severity: 'error' }],
                };
            }
            const existing = reservations.get(serviceId);
            if (existing !== undefined) {
                return existing === port
                    ? { ok: true, port, diagnostics: [] }
                    : {
                        ok: false,
                        reason: 'port_unavailable',
                        diagnostics: [{ code: 'port_unavailable', severity: 'error' }],
                    };
            }
            if (reservedPorts.has(port)) {
                return {
                    ok: false,
                    reason: 'port_unavailable',
                    diagnostics: [{ code: 'port_unavailable', severity: 'error' }],
                };
            }
            return claim(serviceId, port, []);
        },
        release(serviceId) {
            const port = reservations.get(serviceId);
            if (port === undefined) return;
            reservations.delete(serviceId);
            reservedPorts.delete(port);
        },
    };
}
