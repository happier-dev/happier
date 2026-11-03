import type { PluginConnectedAccountAuthenticationModeV2 } from '@happier-dev/protocol/connect/plugin-connected-account-authentication-v2';

type RankableMode = Pick<PluginConnectedAccountAuthenticationModeV2, 'id' | 'kind'>;

/** A code works from any device and needs nothing pasted back; a browser sign-in next; a pasted key last. */
const KIND_RANK: Readonly<Record<string, number>> = {
    oauthDeviceCode: 0,
    oauthAuthorizationCode: 1,
    manual: 2,
};

/**
 * The ways to sign in to a service in the order the setup panel offers them (lab A2/A3): the first
 * is selected by default and marked recommended when there is a choice. Issuing a device code still
 * requires the person's explicit action. Ranked by what the way asks of
 * the person, never by service or mode id; the declared order breaks ties.
 */
export function rankConnectedAccountSetupModes<M extends RankableMode>(
    modes: readonly M[],
): readonly Readonly<{ mode: M; recommended: boolean }>[] {
    const ranked = modes
        .map((mode, index) => ({ mode, index, rank: KIND_RANK[mode.kind] ?? 3 }))
        .sort((left, right) => left.rank - right.rank || left.index - right.index);
    return ranked.map((entry, position) => ({
        mode: entry.mode,
        recommended: position === 0 && modes.length > 1,
    }));
}

export function resolveConnectedAccountSetupMode<M extends RankableMode>(modes: readonly M[], selectedId?: string | null): M | null {
    return modes.find(mode => mode.id === selectedId) ?? rankConnectedAccountSetupModes(modes)[0]?.mode ?? null;
}
