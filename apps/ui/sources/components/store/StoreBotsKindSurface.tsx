import * as React from 'react';
import type { BotTemplateReleaseSourceV1 } from '@happier-dev/protocol/bots/templates/botTemplateV1';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { useAccountSettingsScope } from '@/sync/store/settingsWriters';
import { useStoreDirectoryState } from '@/components/settings/plugins/model/usePluginsOpenItem';
import { useRegistryItems } from '@/registries/useRegistryItems';
import { useRegistryItem } from '@/registries/useRegistryItem';
import { HappierBrandMark } from '@/components/ui/media/HappierBrandMark';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { SessionBotFace } from '@/components/sessions/bots/face/SessionBotFace';
import { buildBotTemplateRecipientRoute } from '@/components/sessions/bots/templates/botTemplateRecipientDestination';
import { t } from '@/text';
import { Directory, StoreKindFrame, type DirectoryRow } from './StoreKindPage';
import type { StoreKindSurfaceInput } from './StoreKindSurface';
import { useReceivedBotTemplates } from './catalog/useReceivedBotTemplates';
import { StoreDirectoryUnavailable } from './StoreDirectoryUnavailable';
import { useStoreDirectorySources } from './StoreSearch';

const NO_TEMPLATES: readonly { id: string; path: string }[] = [];
const NO_FILTERS = {};

/** Native Bot discovery is a projection of Plugin catalogs and received Artifact headers. */
export default function StoreBotsKindSurface(props: Readonly<{ kind: string; input: StoreKindSurfaceInput }>) {
    const { presented } = props.input;
    const directory = useStoreDirectoryState();
    const query = props.input.mode !== 'listing' && props.input.query !== undefined ? props.input.query : directory.state?.query ?? '';
    const source = directory.state?.filters.source;
    const sourceId = source?.include.length === 1 && source.exclude.length === 0 ? source.include[0]! : null;
    const { sourceIds } = useStoreDirectorySources(directory.state?.filters ?? NO_FILTERS, presented && directory.state !== null);
    const list = useRegistryItems({ kind: 'plugin', contributionFamily: 'botTemplates', query, sourceIds }, presented && directory.state !== null);
    const received = useReceivedBotTemplates(query, presented && directory.state !== null);
    const router = useRouter();
    const scope = useAccountSettingsScope();
    const [selected, setSelected] = React.useState<Omit<Parameters<typeof useRegistryItem>[0], 'kind'> | null>(null);
    const read = useRegistryItem({ kind: 'plugin', sourceId: selected?.sourceId ?? '', itemId: selected?.itemId ?? '',
        ...(selected?.version ? { version: selected.version } : {}) }, presented && selected !== null);
    const payload = selected && !read.stale && read.item?.payload.kind === 'plugin' ? read.item.payload : null;
    const templates = payload?.listing.summary.botTemplates ?? NO_TEMPLATES;
    const open = React.useCallback((template: BotTemplateReleaseSourceV1) => {
        if (scope) router.push(buildBotTemplateRecipientRoute(template, scope.serverId));
    }, [router, scope]);
    const openTemplate = React.useCallback((contributionId: string) => {
        if (!selected || read.stale || !read.item?.summary.version) return;
        open({ kind: 'plugin', registryItem: { ...selected, version: read.item.summary.version }, contributionId });
    }, [open, selected, read.stale, read.item?.summary.version]);
    React.useEffect(() => {
        if (presented && templates.length === 1) openTemplate(templates[0]!.id);
    }, [presented, templates, openTemplate]);
    const storeRows = React.useMemo((): readonly DirectoryRow[] => list.items.map(item => {
        const select = () => setSelected({ sourceId: item.sourceId, itemId: item.itemId,
            ...(item.version ? { version: item.version } : {}) });
        return { key: `plugin|${item.sourceId}|${item.itemId}`, title: item.title, description: item.description ?? null,
            group: 'store', mark: item.brandMark ? <HappierBrandMark brand={item.brandMark} pixelSize={26} />
                : <SessionBotFace facts={{ seed: item.itemId, face: null }} size={26} motion={false} visible={presented} />,
            facts: { extra: [item.pluginListing?.publisher.displayName || t('common.unknown'), { text: item.version || t('common.unknown'), mono: true }] },
            open: select, add: select, addLabel: t('botTemplates.fromTemplate') };
    }), [list.items, presented]);
    const receivedRows = React.useMemo((): readonly DirectoryRow[] => received.items.map(item => {
        const select = () => open(item.source);
        return { key: item.source.artifactId, title: item.identity.name, description: item.identity.description, group: 'received',
            mark: <SessionBotFace facts={{ seed: item.source.artifactId, face: item.identity.face ?? null }} size={26} motion={false} visible={presented} />,
            facts: { extra: [item.ownerDisplay || t('common.unknown'), { text: item.version, mono: true }] },
            open: select, add: select, addLabel: t('botTemplates.fromTemplate') };
    }), [received.items, open, presented]);
    const templateRows = React.useMemo((): readonly DirectoryRow[] => templates.map(template => {
        const select = () => openTemplate(template.id);
        return { key: template.id, title: template.id, description: null, mark: null, group: 'templates',
            open: select, add: select, addLabel: t('botTemplates.fromTemplate') };
    }), [templates, openTemplate]);
    const setSource = React.useCallback((id: string | null) => directory.setFilters(current => {
        const { source: _source, ...rest } = current;
        return id ? { ...rest, source: { include: [id], exclude: [] } } : rest;
    }), [directory.setFilters]);
    if (directory.state === null) return <StoreDirectoryUnavailable view="kind" kind="bot" />;
    return <StoreKindFrame kind="bot" query={query} onQueryChange={directory.setQuery} sourceId={sourceId}
        onSourceChange={setSource} presented={presented}>
        {selected ? <>
            <RoundButton size="small" display="secondary" title={t('common.back')} onPress={() => setSelected(null)} />
            {read.error || !read.loading && !read.stale && (payload === null || templates.length === 0)
                ? <SurfaceStateCard kind="error" size="line" title={t('botTemplates.unavailable')} action={{ label: t('common.retry'), onPress: read.refresh }} />
                : <Directory kind="bot" rows={templateRows} groups={[{ key: 'templates', title: read.item?.summary.title ?? '' }]}
                    list={{ loading: read.loading, hasNextPage: false }} query="" sourceTitle={null} />}
        </> : <>
            <Directory kind="bot" label={t('botTemplates.sharedWithYou')} rows={receivedRows} groups={[{ key: 'received', title: t('botTemplates.sharedWithYou'), description: t('botTemplates.sharedWithYouDescription') }]}
                list={received} query={query} sourceTitle={null} showEmptyState={false} />
            <Directory kind="bot" label={t('botTemplates.fromStore')} rows={storeRows} groups={[{ key: 'store', title: t('botTemplates.fromStore'), description: t('botTemplates.fromStoreDescription') }]}
                list={list} query={query} sourceTitle={null} />
        </>}
    </StoreKindFrame>;
}
