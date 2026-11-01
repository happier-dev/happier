/** getfacl access entries; default ACLs describe future children, not current access. */
export function parsePosixAcl(text: string): string[] {
    return text.split('\n').map(line => line.split('#')[0]!.trim()).filter(Boolean).sort();
}

/** Named users and every group entry are constrained by the access mask. */
export function posixAclEntryAllows(lines: readonly string[], entry: string, permission: 'r' | 'w' | 'x'): boolean {
    const value = lines.find(line => line.startsWith(entry))?.slice(entry.length);
    if (!value || !/^[r-][w-][x-]$/.test(value) || !value.includes(permission)) return false;
    const mask = lines.find(line => line.startsWith('mask::'))?.slice('mask::'.length);
    return mask === undefined || /^[r-][w-][x-]$/.test(mask) && mask.includes(permission);
}
