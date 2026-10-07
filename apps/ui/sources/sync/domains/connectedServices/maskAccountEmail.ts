/** The run that stands for hidden characters in a masked identity (the plain-text form of the blur). */
export const CONNECTED_ACCOUNT_IDENTITY_MASK = '•••';
const MASK = CONNECTED_ACCOUNT_IDENTITY_MASK;

/** Where a resolved account label came from; absent means a name. */
export type ConnectedAccountIdentityLabelKind = 'email' | 'accountId';

export type ConnectedAccountIdentityInput = Readonly<{
    label?: string | null;
    labelKind?: ConnectedAccountIdentityLabelKind;
    email?: string | null;
    accountId?: string | null;
}>;

export type ConnectedAccountIdentityPresenter = (input: ConnectedAccountIdentityInput) => Readonly<{
    label: string | null;
    email: string | null;
    accountId: string | null;
}>;

/**
 * An account email as a recognizable hint that does not print the address: the first two letters of the
 * name and of the domain, and the top-level domain (`kevin@gmail.com` → `k•••@g•••.com`).
 */
export function maskAccountEmail(email: string | null | undefined): string | null {
    const value = email?.trim() ?? '';
    const at = value.indexOf('@');
    if (at <= 0 || at !== value.lastIndexOf('@')) return null;
    const name = value.slice(0, at);
    const domain = value.slice(at + 1);
    const labels = domain.split('.').filter(Boolean);
    if (labels.length < 2) return null;
    const tld = labels[labels.length - 1]!;
    return `${Array.from(name).slice(0, 2).join('')}${MASK}@${Array.from(labels[0]!)[0]}${MASK}.${tld}`;
}

/** An account id keeps its prefix and last two characters when long enough to tell accounts apart. */
export function abbreviateConnectedAccountId(value: string | null | undefined): string | null {
    const chars = Array.from(value?.trim() ?? '');
    if (chars.length === 0) return null;
    if (chars.length < 10) return `${chars.slice(0, 2).join('')}${MASK}`;
    return `${chars.slice(0, 5).join('')}${MASK}${chars.slice(-2).join('')}`;
}

/** A name someone gave the account stays; a label that is itself an address is masked as one. */
function maskIdentityLabel(label: string | null): string | null {
    if (label === null) return null;
    const trimmed = label.trim();
    return maskAccountEmail(trimmed) ?? label;
}

/**
 * One device-local presentation policy for connected-account identity fields ("Hide account emails and
 * IDs", lab `csvc` PV): emails and account ids are masked to a hint that still tells accounts apart;
 * names people gave their accounts stay.
 */
export function presentConnectedAccountIdentity(input: Readonly<{
    hidden: boolean;
    label: string | null;
    labelKind?: ConnectedAccountIdentityLabelKind;
    email: string | null;
    accountId: string | null;
}>): Readonly<{ label: string | null; email: string | null; accountId: string | null }> {
    if (!input.hidden) return { label: input.label, email: input.email, accountId: input.accountId };
    return {
        label: input.labelKind === 'accountId' ? abbreviateConnectedAccountId(input.label) : maskIdentityLabel(input.label),
        email: maskAccountEmail(input.email),
        accountId: abbreviateConnectedAccountId(input.accountId),
    };
}

/**
 * A masked identity as its readable and hidden runs, so a surface can draw exactly the hidden runs as a
 * blur where the platform can (lab `csvc` PV) and keep the `•••` text elsewhere. It reads this owner's own
 * output; it never masks anything itself.
 */
export function splitMaskedConnectedAccountIdentity(value: string): ReadonlyArray<Readonly<{ text: string; masked: boolean }>> {
    const parts: Array<Readonly<{ text: string; masked: boolean }>> = [];
    let rest = value;
    while (rest.length > 0) {
        const at = rest.indexOf(MASK);
        if (at < 0) {
            parts.push({ text: rest, masked: false });
            break;
        }
        if (at > 0) parts.push({ text: rest.slice(0, at), masked: false });
        parts.push({ text: MASK, masked: true });
        rest = rest.slice(at + MASK.length);
    }
    return parts;
}
