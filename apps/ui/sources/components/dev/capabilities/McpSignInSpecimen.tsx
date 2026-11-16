import * as React from 'react';

import { McpSignInSection } from '@/components/settings/mcpServers/signIn/McpSignInSection';
import type { McpSignInView } from '@/components/settings/mcpServers/signIn/useMcpServerSignIn';
import { ItemList } from '@/components/ui/lists/ItemList';

const inert = {
    start: async () => undefined,
    cancel: async () => undefined,
    complete: async () => false,
    signOut: async () => false,
    busy: false,
};

const LAB_STATES: readonly Readonly<{ key: string; name: string; view: McpSignInView }>[] = [
    { key: 'not-connected', name: 'Linear', view: { state: 'not_connected' } },
    { key: 'signing', name: 'Linear', view: { state: 'signing', authorizationUrl: 'https://linear.app/oauth/authorize?client_id=https%3A%2F%2Fcloud.happier.dev%2Foauth%2Fmcp%2Fclient-metadata.json&state=attempt-1.n', expiresAtMs: Date.now() + 581_000 } },
    { key: 'finishing', name: 'Linear', view: { state: 'finishing', machineName: 'nl2' } },
    { key: 'connected', name: 'Linear', view: { state: 'connected', identity: 'leeroy@acme.dev', scopes: ['read', 'write', 'issues:create'], lastUsedAt: Date.now() - 86_400_000 * 11 } },
    { key: 'more-access', name: 'Linear', view: { state: 'needs_more_access' } },
    { key: 'expired', name: 'Sentry', view: { state: 'expired', reason: 'expired' } },
    { key: 'address-changed', name: 'Sentry', view: { state: 'expired', reason: 'address_changed' } },
    { key: 'revoked', name: 'Sentry', view: { state: 'revoked' } },
    { key: 'did-not-finish', name: 'Linear', view: { state: 'did_not_finish' } },
    { key: 'no-machine', name: 'Linear', view: { state: 'no_machine_online' } },
    { key: 'client-refused', name: 'Context7', view: { state: 'client_refused' } },
];

/**
 * Dev-only (P7 U7.9): every Sign-in state with the lab cast (ms-B), through the real section and inert
 * actions. States the QA Account cannot reach with real data (more access, revoked, address changed,
 * client refused, finishing) are judged here; `?state=<key>` shows one.
 */
export function McpSignInSpecimen(props: Readonly<{ state?: string }>) {
    const states = props.state ? LAB_STATES.filter((entry) => entry.key === props.state) : LAB_STATES;
    return (
        <ItemList>
            {states.map((entry) => (
                <McpSignInSection key={entry.key} testID={`specimen:${entry.key}`} name={entry.name}
                    signIn={{ ...inert, view: entry.view }} onUseApiKey={entry.view.state === 'client_refused' ? () => undefined : undefined} />
            ))}
        </ItemList>
    );
}
