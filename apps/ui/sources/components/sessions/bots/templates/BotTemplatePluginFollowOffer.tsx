import * as React from 'react';
import { selectRegistryBotTemplateUpdatePointerV1 } from '@happier-dev/protocol/registries';
import type { BotTemplateInstanceV1 } from '@happier-dev/protocol/bots/templates/botTemplateV1';
import { readBotTemplateUpdateOfferV1 } from '@happier-dev/protocol/bots/templates/botTemplateActionsV1';
import { useRegistryItem } from '@/registries/useRegistryItem';
import { useAppShellPluginUiProjection } from '@/components/appShell/plugins/AppShellPluginUiProjection';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { useBotTemplateRecipient } from './useBotTemplateRecipient';
import type { BotTemplateFollowOffer } from './useBotTemplateFollowOffer';

/** Index and installation pushes demand one addressed package, then BT2 reads only a changed pointer. */
export default function BotTemplatePluginFollowOffer(props: Readonly<{
    instance: BotTemplateInstanceV1 & { source: Extract<BotTemplateInstanceV1['source'], { kind: 'plugin' }> };
    serverId: string;
    children: (offer: BotTemplateFollowOffer | null) => React.ReactNode;
}>) {
    const { instance, serverId } = props;
    const active = useActiveServerSnapshot();
    const enabled = instance.follow && areServerProfileIdentifiersEquivalent(active.serverId, serverId);
    const pointer = instance.source.registryItem;
    const { item, refresh } = useRegistryItem({ kind: 'plugin', sourceId: pointer.sourceId, itemId: pointer.itemId }, enabled);
    const listing = item?.payload.kind === 'plugin' && 'listing' in item.payload ? item.payload.listing : null;
    const pluginId = listing?.pluginId;
    const installedVersion = useAppShellPluginUiProjection(value => enabled && pluginId
        ? value.pluginUiProjection?.installedPackagesById[pluginId]?.version : undefined);
    const observed = React.useRef<Readonly<{ pluginId: string; version: string | undefined }> | null>(null);
    React.useEffect(() => {
        if (!enabled || !pluginId) { observed.current = null; return; }
        const previous = observed.current;
        observed.current = { pluginId, version: installedVersion };
        if (previous?.pluginId === pluginId && previous.version !== installedVersion) void refresh();
    }, [enabled, pluginId, installedVersion, refresh]);
    const selected = listing ? selectRegistryBotTemplateUpdatePointerV1(pointer, listing) : null;
    const changed = enabled && selected !== null && selected.version !== pointer.version;
    const source = React.useMemo(() => ({ ...instance.source, registryItem: selected ?? pointer }),
        [instance.source.contributionId, pointer.sourceId, pointer.itemId, selected?.version]);
    const { preview } = useBotTemplateRecipient(source, serverId, changed);
    const offer: BotTemplateFollowOffer | null = !enabled || !selected ? null : !changed
        ? { offer: 'current', name: null, author: null, version: instance.acceptedVersion }
        : preview ? { offer: readBotTemplateUpdateOfferV1(instance, preview.release.version),
            name: preview.release.content.identity.name, author: preview.presentation?.ownerDisplayName ?? null,
            version: preview.release.version } : null;
    return props.children(offer);
}
