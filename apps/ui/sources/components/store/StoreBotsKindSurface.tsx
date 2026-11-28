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
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SectionActionButton } from '@/components/ui/lists/SectionActionButton';
import { EmptyState } from '@/components/ui/empty/EmptyState';
import { BOTS_GLYPH } from '@/components/sessions/bots/botsGlyph';
import { SessionBotFace } from '@/components/sessions/bots/face/SessionBotFace';
import { buildBotTemplateRecipientRoute } from '@/components/sessions/bots/templates/botTemplateRecipientDestination';
import { t } from '@/text';
import { Directory, StoreKindFrame, useSourceTitle, type DirectoryRow } from './StoreKindPage';
import type { StoreKindSurfaceInput } from './StoreKindSurface';
import { useReceivedBotTemplates } from './catalog/useReceivedBotTemplates';
import { StoreDirectoryUnavailable } from './StoreDirectoryUnavailable';
import { useStoreDirectorySources } from './StoreSearch';
import { BundledBotTemplateSection } from './BundledBotTemplateSection';

const NO_TEMPLATES: readonly { id: string; path: string }[] = [];
const NO_FILTERS = {};
/** Each source is its own titled section, so neither section's rows wait on, or are hidden by, the other's read. */
const NO_GROUPS: readonly [] = [];
/**
 * Bots read as cards (lab session-orchestration G1): the face beside the name, the job on two lines, the facts and
 * Make my own under them. Two across on a page, one on a phone: a card narrower than this cuts the job mid-thought.
 */
const BOT_CARD_MIN_WIDTH = 300;
const BOT_CARD_MARK_PX = 32;

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
    const sourceTitle = useSourceTitle();
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
            group: 'store', mark: item.brandMark ? <HappierBrandMark brand={item.brandMark} pixelSize={BOT_CARD_MARK_PX} />
                : <SessionBotFace facts={{ seed: item.itemId, face: null }} size={BOT_CARD_MARK_PX} motion={false} visible={presented} />,
            facts: { extra: [item.pluginListing?.publisher.displayName || t('common.unknown'), item.version || t('common.unknown')] },
            open: select, add: select, addLabel: t('botTemplateRecipient.makeOwn') };
    }), [list.items, presented]);
    const receivedRows = React.useMemo((): readonly DirectoryRow[] => received.items.map(item => {
        const select = () => open(item.source);
        return { key: item.source.artifactId, title: item.identity.name, description: item.identity.description, group: 'received',
            mark: <SessionBotFace facts={{ seed: item.source.artifactId, face: item.identity.face ?? null }} size={BOT_CARD_MARK_PX} motion={false} visible={presented} />,
            facts: { extra: [item.ownerDisplay || t('common.unknown'), item.version] },
            open: select, add: select, addLabel: t('botTemplateRecipient.makeOwn') };
    }), [received.items, open, presented]);
    const templateRows = React.useMemo((): readonly DirectoryRow[] => templates.map(template => {
        const select = () => openTemplate(template.id);
        return { key: template.id, title: template.id, description: null, mark: null, group: 'templates',
            open: select, add: select, addLabel: t('botTemplateRecipient.makeOwn') };
    }), [templates, openTemplate]);
    const setSource = React.useCallback((id: string | null) => directory.setFilters(current => {
        const { source: _source, ...rest } = current;
        return id ? { ...rest, source: { include: [id], exclude: [] } } : rest;
    }), [directory.setFilters]);
    // A search that finds nothing shared leaves the Store's own answer to speak for it.
    const showShared = !(query && !received.loading && !received.error && received.items.length === 0);
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
            {!source ? <BundledBotTemplateSection query={query} presented={presented} open={open}
                minCardWidth={BOT_CARD_MIN_WIDTH} markSize={BOT_CARD_MARK_PX} /> : null}
            {showShared ? <ItemGroup surface="none" title={t('botTemplates.sharedWithYou')} description={t('botTemplates.sharedWithYouDescription')}
                // A healthy section asks its reader again; a failed read already offers Try again on its own line.
                action={received.error ? undefined : <SectionActionButton testID="store.kind.bot.shared.refresh"
                    title={t('common.refresh')} icon="arrow-clockwise" loading={received.loading} disabled={received.loading}
                    onPress={() => { void received.refresh(); }} />}>{null}</ItemGroup> : null}
            {/* The section header alone: its rows stand on the page's directory inset, as every other kind page's do. */}
            {showShared ? <Directory kind="bot" label={t('botTemplates.sharedWithYou')} rows={receivedRows} groups={NO_GROUPS}
                presentation="grid" minCardWidth={BOT_CARD_MIN_WIDTH}
                list={received} query={query} sourceTitle={null}
                emptyState={<EmptyState testID="store.kind.bot.shared.empty" layout="inline" iconName={BOTS_GLYPH}
                    title={t('botTemplates.sharedEmptyTitle')} subtitle={t('botTemplates.sharedEmptyBody')} />} /> : null}
            <ItemGroup surface="none" title={t('botTemplates.fromStore')} description={t('botTemplates.fromStoreDescription')}>{null}</ItemGroup>
            <Directory kind="bot" label={t('botTemplates.fromStore')} rows={storeRows} groups={NO_GROUPS}
                presentation="grid" minCardWidth={BOT_CARD_MIN_WIDTH}
                list={list} query={query} sourceTitle={sourceTitle}
                emptyState={<EmptyState testID="store.kind.bot.store.empty" layout="line" title={t('capabilities.store.emptyBody')} />} />
        </>}
    </StoreKindFrame>;
}
