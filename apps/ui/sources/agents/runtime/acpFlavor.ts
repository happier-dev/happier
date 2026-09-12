export function isAcpFlavorPrefix(flavor: string | null | undefined): boolean {
    return typeof flavor === 'string' && flavor.trim().toLowerCase().startsWith('acp:');
}
