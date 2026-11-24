export function buildProviderAccountUsageScopeKey(params: Readonly<{
    serverId: string;
    generation: number;
    credentialScope: string;
}>): string {
    const serverId = String(params.serverId ?? '').trim();
    const generation = Number(params.generation);
    const credentialScope = String(params.credentialScope ?? '').trim();
    return serverId
        && Number.isSafeInteger(generation)
        && generation >= 0
        && credentialScope
        ? [serverId, generation, credentialScope].join('\u0000')
        : '';
}
