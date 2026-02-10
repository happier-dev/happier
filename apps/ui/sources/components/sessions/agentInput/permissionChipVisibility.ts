export function shouldRenderPermissionChip(label: string | null | undefined): boolean {
    return typeof label === 'string' && label.trim().length > 0;
}
