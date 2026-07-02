export type ManagedLocalServiceCleanupCandidate = Readonly<{
    id: string;
    phase: 'starting' | 'detecting' | 'running' | 'unhealthy' | 'stopping' | 'stopped' | 'failed';
    updatedAt: number;
    staleAfterMs: number;
}>;

export function selectManagedLocalServiceCleanupIds(input: Readonly<{
    now: number;
    services: readonly ManagedLocalServiceCleanupCandidate[];
}>): readonly string[] {
    const now = Math.max(0, Math.trunc(input.now));
    return input.services
        .filter((service) => (service.phase === 'stopped' || service.phase === 'failed')
            && now - Math.max(0, Math.trunc(service.updatedAt)) >= Math.max(0, Math.trunc(service.staleAfterMs)))
        .map((service) => service.id);
}
