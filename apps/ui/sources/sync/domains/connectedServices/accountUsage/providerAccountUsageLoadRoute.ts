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

/**
 * Reads exactly one account-mode-selected PAU representation.
 *
 * A successful plaintext miss is authoritative and never triggers a sealed
 * request. The account mode is resolved before this boundary.
 */
export async function readProviderAccountUsageSnapshotForMode<
    TSnapshot,
    TSealed,
>(params: Readonly<{
    mode: 'plain' | 'e2ee';
    readPlain(): Promise<TSnapshot | null>;
    readSealed(): Promise<TSealed | null>;
    openSealed(sealed: TSealed): TSnapshot | null;
}>): Promise<TSnapshot | null> {
    if (params.mode === 'plain') {
        return await params.readPlain();
    }
    const sealed = await params.readSealed();
    return sealed === null ? null : params.openSealed(sealed);
}
