import { renderHelpPage } from '@happier-dev/cli-common/output';
import { filterRelayAccessProviderDescriptors } from '@happier-dev/cli-common/relayAccess';
import { resolveCliFeatureDecision } from '@/features/featureDecisionService';

export function showRelayAccessHelp(): void {
    console.log(renderHelpPage({
        title: 'happier relay access',
        subtitle: 'Relay share URL configuration',
        usage: [
            { label: 'happier relay access status [--ssh <user@host>] [--ssh-port <number>] [--ssh-auth agent|keyfile|password] [--identity-file <path>] [--ssh-config-file <path>] [--known-hosts-path <path>] [--trusted-host-key <line>] [--yes] [--json]', description: 'Show configured method + current share URL (if available)' },
            { label: 'happier relay access configure --provider <provider-id> [--upstream-url <url>] [--url <url>] [--hostname <hostname>] [--token <token>] [--ssh <user@host>] [--ssh-port <number>] [--ssh-auth agent|keyfile|password] [--identity-file <path>] [--ssh-config-file <path>] [--known-hosts-path <path>] [--trusted-host-key <line>] [--yes] [--json]', description: 'Configure share URL strategy' },
            { label: 'happier relay access disable [--ssh <user@host>] [--ssh-port <number>] [--ssh-auth agent|keyfile|password] [--identity-file <path>] [--ssh-config-file <path>] [--known-hosts-path <path>] [--trusted-host-key <line>] [--yes] [--json]', description: 'Disable share URL strategy (remove persisted config)' },
        ],
        notes: [
            'Providers: localOnly, tailscaleServe, tailscaleFunnel, lan, cloudflareNamed',
            'When configuring tailscale/cloudflare, the share URL may require completing provider setup on the host before it becomes available.',
            'Share URLs are provider status only. Home routes are admitted through server-published connection descriptors.',
            'When using --ssh, Happier manages an app-scoped known_hosts file (StrictHostKeyChecking=yes). Use --yes to auto-accept host trust prompts in non-interactive runs.',
        ],
    }));
}


export function readAvailableRelayAccessDescriptors() {
    return filterRelayAccessProviderDescriptors({
        allowTailscale: resolveCliFeatureDecision({ featureId: 'setup.relayAccess.allowTailscale', env: process.env }).state === 'enabled',
        allowCloudflareTunnel: resolveCliFeatureDecision({ featureId: 'setup.relayAccess.allowCloudflareTunnel', env: process.env }).state === 'enabled',
    }).filter(descriptor => descriptor.definition.targets.includes('homeRelay'));
}
