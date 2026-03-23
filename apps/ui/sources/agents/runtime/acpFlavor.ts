export function isAcpFlavorPrefix(flavor: string | null | undefined): boolean {
    return typeof flavor === 'string' && flavor.trim().toLowerCase().startsWith('acp:');
}

export function deriveAcpBackendIdFromFlavor(flavor: string | null | undefined): string | null {
    if (!isAcpFlavorPrefix(flavor)) return null;
    const normalizedFlavor = String(flavor).trim();
    const backendId = normalizedFlavor.slice('acp:'.length).trim();
    return backendId.length > 0 ? backendId : null;
}
