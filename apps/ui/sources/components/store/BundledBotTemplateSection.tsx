import * as React from 'react';
import { listBundledBotTemplates } from '@happier-dev/plugins-bot-templates/catalog';
import type { BotTemplateReleaseSourceV1 } from '@happier-dev/protocol/bots/templates/botTemplateV1';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Icon } from '@/components/ui/icons/Icon';
import { SessionBotFace } from '@/components/sessions/bots/face/SessionBotFace';
import { t } from '@/text';
import { Directory, type DirectoryRow } from './StoreKindPage';

const TEMPLATES = listBundledBotTemplates();

export function BundledBotTemplateSection({ query, presented, open, minCardWidth, markSize }: Readonly<{
    query: string; presented: boolean; minCardWidth: number; markSize: number;
    open: (source: BotTemplateReleaseSourceV1) => void;
}>) {
    const rows = React.useMemo((): readonly DirectoryRow[] => {
        const words = query.trim().toLocaleLowerCase().split(/\s+/);
        return TEMPLATES.filter(({ identity }) => {
            const description = `${identity.name} ${identity.description}`.toLocaleLowerCase();
            return words.every(word => description.includes(word));
        }).map(({ source, identity }) => {
            const select = () => open(source);
            return { key: source.contributionId, title: identity.name, description: identity.description, group: 'bundled',
                mark: <SessionBotFace facts={{ seed: source.contributionId, face: identity.face ?? null }}
                    size={markSize} motion={false} visible={presented} />,
                facts: { extra: [source.registryItem.version] }, open: select, add: select, addLabel: t('botTemplateRecipient.makeOwn') };
        });
    }, [query, open, presented, markSize]);
    if (!rows.length) return null;
    const title = t('botTemplates.fromHappier');
    return <>
        <ItemGroup surface="none" testID="store.kind.bot.bundled" title={title} titleLeading={<Icon name="seal-check" />}>{null}</ItemGroup>
        <Directory kind="bot" label={title} rows={rows} groups={[]} presentation="grid" minCardWidth={minCardWidth}
            list={{ loading: false, hasNextPage: false }} query={query} sourceTitle={null} />
    </>;
}
