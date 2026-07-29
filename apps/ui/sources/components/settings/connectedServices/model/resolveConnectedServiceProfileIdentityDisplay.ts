import { resolveConnectedServiceProfileLabel } from '@/sync/domains/connectedServices/connectedServiceProfilePreferences';

type ConnectedServiceProfileIdentityLike = Readonly<{
    profileId?: string | null;
    label?: string | null;
    providerEmail?: string | null;
}>;

type ConnectedServiceProfileIdentityDisplay = Readonly<{
    primaryLabel: string;
    secondaryLabel?: string;
    compactLabel: string;
    diagnosticLabel: string;
    profileId?: string;
    providerEmail?: string;
    warning?: 'label_masks_stable_identity';
}>;

function readIdentityString(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
}

function uniqueNonEmpty(values: ReadonlyArray<string>): string[] {
    const out: string[] = [];
    for (const value of values) {
        const trimmed = value.trim();
        if (!trimmed || out.includes(trimmed)) continue;
        out.push(trimmed);
    }
    return out;
}

function joinSecondaryIdentityParts(values: ReadonlyArray<string>): string {
    return uniqueNonEmpty(values).join(' · ');
}

function resolveProfileIdentityDisplay(profile: ConnectedServiceProfileIdentityLike): ConnectedServiceProfileIdentityDisplay {
    const profileId = readIdentityString(profile.profileId);
    const label = readIdentityString(profile.label);
    const providerEmail = readIdentityString(profile.providerEmail);
    const primaryLabel = label || providerEmail || profileId;
    const secondaryLabel = label
        ? joinSecondaryIdentityParts([providerEmail, profileId !== label ? profileId : ''])
        : joinSecondaryIdentityParts([providerEmail && profileId !== providerEmail ? profileId : '']);
    const diagnosticLabel = uniqueNonEmpty([primaryLabel, providerEmail, profileId]).join(' · ') || primaryLabel;
    const labelMasksStableIdentity = Boolean(label && (
        (providerEmail && providerEmail !== label)
        || (profileId && profileId !== label)
    ));

    return {
        primaryLabel,
        ...(secondaryLabel ? { secondaryLabel } : {}),
        compactLabel: providerEmail || primaryLabel,
        diagnosticLabel,
        ...(profileId ? { profileId } : {}),
        ...(providerEmail ? { providerEmail } : {}),
        ...(labelMasksStableIdentity ? { warning: 'label_masks_stable_identity' as const } : {}),
    };
}

export function resolveConnectedServiceProfileIdentityDisplay(params: Readonly<{
    serviceId: string;
    profileId: string;
    labelsByKey: Readonly<Record<string, string | undefined>>;
    profile?: ConnectedServiceProfileIdentityLike | null;
    profiles?: ReadonlyArray<ConnectedServiceProfileIdentityLike>;
}>): ConnectedServiceProfileIdentityDisplay {
    const profileId = readIdentityString(params.profileId);
    const label = resolveConnectedServiceProfileLabel({
        labelsByKey: params.labelsByKey,
        serviceId: params.serviceId,
        profileId,
    });
    const profile = params.profile
        ?? params.profiles?.find((candidate) => readIdentityString(candidate.profileId) === profileId)
        ?? null;
    return resolveProfileIdentityDisplay({
        profileId,
        label: label ?? profile?.label ?? null,
        providerEmail: profile?.providerEmail ?? null,
    });
}

export function formatConnectedServiceIdentityVisibleLabel(display: ConnectedServiceProfileIdentityDisplay): string {
    return display.secondaryLabel
        ? `${display.primaryLabel} · ${display.secondaryLabel}`
        : display.primaryLabel;
}

export function resolveConnectedServiceProfileDiagnosticLabel(params: Readonly<{
    serviceId: string;
    profileId: string;
    labelsByKey: Readonly<Record<string, string | undefined>>;
    profiles?: ReadonlyArray<ConnectedServiceProfileIdentityLike>;
}>): string {
    return resolveConnectedServiceProfileIdentityDisplay(params).diagnosticLabel;
}
