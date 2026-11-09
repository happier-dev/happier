import { BUNDLED_LEGACY_CONNECTED_ACCOUNT_COMPATIBILITY_BY_SERVICE_ID } from '@happier-dev/protocol/connect/generatedBuiltInLegacyConnectedAccountCompatibility';
import type { PluginConnectedAccountDescriptorContributionV2, PluginContributionIdentityV1 } from '@happier-dev/protocol';
import { bullets, cmd, sectionTitle } from '@happier-dev/cli-common/output';

export type ConnectTarget = Readonly<{
  service: PluginContributionIdentityV1;
  descriptor: PluginConnectedAccountDescriptorContributionV2;
  commandId: string;
  aliases: readonly string[];
}>;

export function localizedText(
  value: string | Readonly<{ fallback: string }> | undefined,
): string {
  return typeof value === 'string' ? value : value?.fallback ?? '';
}

export function sameService(
  left: PluginContributionIdentityV1,
  right: PluginContributionIdentityV1,
): boolean {
  return left.pluginId === right.pluginId && left.localId === right.localId;
}

export function exactServiceCommandId(service: PluginContributionIdentityV1): string {
  return `${service.pluginId}/${service.localId}`;
}

export function legacyServiceIdFor(
  service: PluginContributionIdentityV1,
): string | null {
  for (const [serviceId, compatibility] of Object.entries(
    BUNDLED_LEGACY_CONNECTED_ACCOUNT_COMPATIBILITY_BY_SERVICE_ID,
  )) {
    if (sameService(service, compatibility.service)) return serviceId;
  }
  return null;
}

export function projectConnectTargets(
  registry: Readonly<{ connectedAccountDescriptors?: readonly Readonly<{ pluginId?: string; definition: PluginConnectedAccountDescriptorContributionV2 }>[] }>,
): readonly ConnectTarget[] {
  const candidates = (registry.connectedAccountDescriptors ?? []).flatMap(
    (contribution) => {
      const pluginId = contribution.pluginId?.trim();
      if (!pluginId) return [];
      const descriptor = { data: contribution.definition };
      const service = Object.freeze({
        pluginId,
        localId: descriptor.data.id,
      });
      return [
        {
          service,
          descriptor: descriptor.data,
          legacyServiceId: legacyServiceIdFor(service),
        },
      ];
    },
  );
  const localIdCounts = new Map<string, number>();
  for (const candidate of candidates) {
    localIdCounts.set(
      candidate.service.localId,
      (localIdCounts.get(candidate.service.localId) ?? 0) + 1,
    );
  }
  return Object.freeze(
    candidates
      .map(({ service, descriptor, legacyServiceId }) => {
        const exactId = exactServiceCommandId(service);
        const aliases = new Set<string>([exactId]);
        if (localIdCounts.get(service.localId) === 1) {
          aliases.add(service.localId);
        }
        if (legacyServiceId) aliases.add(legacyServiceId);
        return Object.freeze({
          service,
          descriptor,
          commandId: legacyServiceId ?? (
            localIdCounts.get(service.localId) === 1
              ? service.localId
              : exactId
          ),
          aliases: Object.freeze([...aliases]),
        });
      })
      .sort((left, right) => left.commandId.localeCompare(right.commandId)),
  );
}

export function showConnectHelp(targets: readonly ConnectTarget[]): void {
  const targetLines =
    targets.length > 0
      ? targets
          .map((target) => {
            const title =
              localizedText(target.descriptor.title) || target.service.localId;
            return `  happier connect ${target.commandId.padEnd(20)} ${title}`;
          })
          .join('\n')
      : '  (no connected-account services registered)';
  console.log(
    [
      `${sectionTitle('happier connect')} - Connect accounts through the Happier daemon`,
      '',
      sectionTitle('Usage:'),
      targetLines,
      `  ${cmd('happier connect status')}                      Show connection status`,
      `  ${cmd('happier connect <service> --account <id>')}    Reconnect an exact account`,
      `  ${cmd('happier connect <service> --mode <mode>')}     Select an authentication mode`,
      `  ${cmd('happier connect <service> --import --source <id>')} Import a native login on this machine`,
      `  ${cmd('happier connect <service> --oauth')}           Select authorization-code OAuth`,
      `  ${cmd('happier connect <service> --device')}          Select device-code OAuth`,
      `  ${cmd('happier connect <service> --token')}           Select the built-in token mode`,
      `  ${cmd('happier connect <service> --yes')}             Confirm this connected-account operation`,
      `  ${cmd('happier connect <service> --no-open')}         Do not open a browser`,
      `  ${cmd('happier connect <service> --timeout <seconds>')} Bound the interactive flow`,
      '',
      sectionTitle('Notes:'),
      bullets([
        `Authenticate with Happier first using ${cmd('happier auth login')}`,
        'Authentication state, PKCE, credentials, and settlement stay in the selected daemon',
        'External services use the unambiguous <pluginId>/<localId> command form',
        'Native import creates a host-owned account; name it afterward in connected-account settings',
      ]),
      '',
    ].join('\n'),
  );
}

export async function printConnectHelp(happyHomeDir: string): Promise<void> {
  const [{ resolveReadOnlyHelpDeclarations }, { BUNDLED_FIRST_PARTY_PLUGIN_LOCATORS }, { readBundledPluginManifest }] = await Promise.all([
    import('@/cli/rootHelp'), import('@/plugins/projection/registry/sources/generatedBundledPluginManifests'),
    import('@/plugins/projection/registry/builtIn/manifestFile'),
  ]);
  const declarations = await resolveReadOnlyHelpDeclarations(happyHomeDir);
  const descriptors: Array<{ pluginId: string; definition: PluginConnectedAccountDescriptorContributionV2 }> = [];
  for (const locator of BUNDLED_FIRST_PARTY_PLUGIN_LOCATORS.filter((candidate) => declarations.pluginIds.includes(candidate.pluginId))) {
    const manifest = readBundledPluginManifest(locator) as import('@/plugins/manifest/types').CanonicalPluginManifest;
    for (const definition of manifest.contributes.connectedAccountDescriptors ?? []) descriptors.push({ pluginId: locator.pluginId, definition });
  }
  for (const plugin of declarations.installedPlugins) {
    for (const definition of plugin.manifest.contributes.connectedAccountDescriptors ?? []) descriptors.push({ pluginId: plugin.pluginId, definition });
  }
  showConnectHelp(projectConnectTargets({ connectedAccountDescriptors: descriptors }));
}

