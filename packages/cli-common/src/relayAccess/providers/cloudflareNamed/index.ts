import type { RelayAccessConfig, RelayAccessProvider, RelayAccessStatus } from '../../types.js';
import { parseRelayAccessConfig, readBuiltinRelayAccessProviderId, relayAccessProviderDescriptorsById } from '../../catalog.js';

export type CloudflareNamedControllerConfig = Readonly<{
    accountId: string;
    zoneId: string;
    tunnel: Readonly<{ kind: 'create'; name: string }> | Readonly<{ kind: 'adopt'; tunnelId: string; name: string }>;
    owned: readonly Readonly<{ hostname: string; path?: string; expectedService: string }>[];
    dnsOwnership: readonly Readonly<{ hostname: string; recordId: string }>[];
    connector: Readonly<{ imageRef: string; version: string }>;
}>;

type ControllerSelection = RelayAccessConfig & Readonly<{
    config: Readonly<{ controller: CloudflareNamedControllerConfig }>;
}>;

/** Only called with the catalog parser's successful closed-schema result. */
function hasController(selection: RelayAccessConfig): selection is ControllerSelection {
    return readBuiltinRelayAccessProviderId(selection.provider) === 'cloudflareNamed'
        && selection.config !== null && typeof selection.config === 'object'
        && 'controller' in selection.config;
}

/** Domain callers consume the descriptor's one admission and typed selection. */
export function readCloudflareNamedControllerSelection(value: unknown): Readonly<{
    selection: RelayAccessConfig;
    controller: CloudflareNamedControllerConfig;
}> | null {
    const selection = parseRelayAccessConfig(value);
    if (!selection || !hasController(selection)) return null;
    return { selection, controller: selection.config.controller };
}

function inspectSelection(config: RelayAccessConfig | null): RelayAccessStatus {
    if (!config || readBuiltinRelayAccessProviderId(config.provider) !== 'cloudflareNamed') return { state: 'unknown' };
    const value = config.config;
    const hostname = value !== null && typeof value === 'object' && 'hostname' in value && typeof value.hostname === 'string' ? value.hostname.trim() : '';
    if (!hostname || /[\s\r\n\0/]/.test(hostname)) return { state: 'error', details: { reason: 'invalid_hostname' } };
    try {
        if (new URL(`https://${hostname}`).hostname !== hostname) return { state: 'error', details: { reason: 'invalid_hostname' } };
    } catch { return { state: 'error', details: { reason: 'invalid_hostname' } }; }
    const account = config.credentialRefs.find(ref => ref.purpose === 'tunnel.manage');
    if (account?.credentialRef.kind !== 'connectedAccount') return { state: 'needs_auth', details: { reason: 'connected_account_required' } };
    // A desired hostname is not connector, DNS or route evidence. The admitted
    // controller lifecycle owns those facts and supplies its verified result.
    return { state: 'unknown', details: { reason: 'connector_verification_required' } };
}

export const cloudflareNamedRelayAccessProvider: RelayAccessProvider = {
    descriptor: relayAccessProviderDescriptorsById.cloudflareNamed,
    status: ({ config }) => inspectSelection(config),
    configure: ({ config }) => inspectSelection(config),
    disable: () => { throw Object.assign(new Error('admitted_controller_required'), { code: 'admitted_controller_required' }); },
};
