import { canonicalizeServerUrl } from './url/serverUrlCanonical';

/** Deliberate device-local routing choice, never a replacement for Home identity. */
export type HomeAddressSelection = Readonly<{
    serverIdentityId: string;
    enteredUrl: string;
    canonicalServerUrl: string;
    useCanonical: boolean;
}>;

type AddressableHome = Readonly<{
    serverUrl: string;
    canonicalServerUrl?: string | null;
    serverIdentityId?: string | null;
    addressSelection?: HomeAddressSelection;
}>;

export function parseHomeAddressSelection(value: unknown): HomeAddressSelection | undefined {
    if (!value || typeof value !== 'object') return undefined;
    const record = value as Record<string, unknown>;
    const enteredUrl = typeof record.enteredUrl === 'string' ? canonicalizeServerUrl(record.enteredUrl) : '';
    const canonicalServerUrl = typeof record.canonicalServerUrl === 'string' ? canonicalizeServerUrl(record.canonicalServerUrl) : '';
    if (typeof record.serverIdentityId !== 'string' || !record.serverIdentityId.trim()
        || !enteredUrl || !canonicalServerUrl || typeof record.useCanonical !== 'boolean') return undefined;
    return { serverIdentityId: record.serverIdentityId.trim(), enteredUrl, canonicalServerUrl, useCanonical: record.useCanonical };
}

export function readHomeAddressSelection(
    profile: AddressableHome,
    canonicalServerUrl = profile.canonicalServerUrl ?? profile.serverUrl,
): HomeAddressSelection | undefined {
    const selection = profile.addressSelection;
    return selection && selection.serverIdentityId === profile.serverIdentityId
        && selection.canonicalServerUrl === canonicalServerUrl
        ? selection : undefined;
}

/** All URL-addressed consumers share this choice; signed audiences remain canonical. */
export function resolveHomeConnectionAddress(profile: AddressableHome): string {
    const selection = readHomeAddressSelection(profile);
    return selection && !selection.useCanonical ? selection.enteredUrl : profile.serverUrl;
}
