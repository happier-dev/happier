import { renderHelpPage } from '@happier-dev/cli-common/output';
import { filterRelayAccessProviderDescriptors } from '@happier-dev/cli-common/relayAccess';
import { resolveCliFeatureDecision } from '@/features/featureDecisionService';

export function readAvailableRelayAccessDescriptors() {
    return filterRelayAccessProviderDescriptors({
        allowTailscale: resolveCliFeatureDecision({ featureId: 'setup.relayAccess.allowTailscale', env: process.env }).state === 'enabled',
        allowCloudflareTunnel: resolveCliFeatureDecision({ featureId: 'setup.relayAccess.allowCloudflareTunnel', env: process.env }).state === 'enabled',
    }).filter(descriptor => descriptor.definition.targets.includes('homeRelay'));
}

export function showRelayAccessHelp(): void {
    console.log(renderHelpPage({
        title: 'happier relay access',
        subtitle: 'Relay share URL configuration',
        usage: [
            { label: 'happier relay access status [--ssh <user@host>] [--ssh-port <number>] [--ssh-auth agent|keyfile|password] [--identity-file <path>] [--ssh-config-file <path>] [--known-hosts-path <path>] [--trusted-host-key <line>] [--yes] [--json]', description: 'Show configured method + current share URL (if available)' },
            { label: 'happier relay access configure --provider <provider-id> [--config <json>] [--credential-refs <json>] [--upstream-url <url>] [--ssh <user@host>] [--ssh-port <number>] [--ssh-auth agent|keyfile|password] [--identity-file <path>] [--ssh-config-file <path>] [--known-hosts-path <path>] [--trusted-host-key <line>] [--yes] [--json]', description: 'Configure share URL strategy' },
            { label: 'happier relay access disable [--ssh <user@host>] [--ssh-port <number>] [--ssh-auth agent|keyfile|password] [--identity-file <path>] [--ssh-config-file <path>] [--known-hosts-path <path>] [--trusted-host-key <line>] [--yes] [--json]', description: 'Disable share URL strategy (remove persisted config)' },
        ],
        notes: [
            `Providers: ${readAvailableRelayAccessDescriptors().map(descriptor => descriptor.id).join(', ')}`,
            'String config fields also accept --<field> <value>. Credentials use Saved Secret or Connected Account references, never raw values.',
            'The share URL may require completing provider setup on the host before it becomes available.',
            'Share URLs are provider status only. Home routes are admitted through server-published connection descriptors.',
            'When using --ssh, Happier manages an app-scoped known_hosts file (StrictHostKeyChecking=yes). Use --yes to auto-accept host trust prompts in non-interactive runs.',
        ],
    }));
}

