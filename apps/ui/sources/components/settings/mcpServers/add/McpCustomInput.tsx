import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useStore } from 'zustand';
import { McpServerCatalogEntryV1Schema, type McpServerCatalogEntryV1 } from '@happier-dev/protocol/mcp/servers/settingsV1';

import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { ActionApprovalPendingNotice } from '@/components/approvals/ActionApprovalPendingNotice';
import { CapabilityAddDetailAction, type CapabilityAddInputContext } from '@/components/capabilities/add/CapabilityAddModal';
import { CapabilityDetailHeader } from '@/components/capabilities/detail/CapabilityDetailHeader';
import { buildCapabilityCollectionAnatomy } from '@/components/capabilities/row/buildCapabilityCollectionAnatomy';
import { WhereItsOnControl } from '@/components/capabilities/where/WhereItsOnControl';
import { useSavedSecretCatalog } from '@/components/secrets/useSavedSecretCatalog';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { useCollectionDraftTitle } from '@/components/ui/lists/collection/CollectionDraftTitle';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Text } from '@/components/ui/text/Text';
import { projectReachOnMachines } from '@/sync/domains/capabilities/reach/useReachProjection';
import { t } from '@/text';
import { McpServerConfigurationSection, withMcpServerTransport } from '../McpServerConfigurationSection';
import { HappierBrandMark } from '@/components/ui/media/HappierBrandMark';
import type { useMcpServersSettings } from '../useMcpServersSettings';
import type { McpAddPlaces } from './useMcpAddPlaces';
import type { McpServerDraft } from './useMcpServerDraft';

type Props = Readonly<{
    draft: McpServerDraft;
    approval: ReturnType<typeof useMcpServersSettings>['approval'];
    places: McpAddPlaces;
    onCreated?: (serverId: string) => void;
    onOpen?: (serverId: string) => void | Promise<void>;
    onDiscard?: () => void;
    publishTitle?: boolean;
    /** Inside the Add dialog: how Happier reaches the server leads the list, its form is the details (lab `n:custom`). */
    ctx?: CapabilityAddInputContext;
    /** Inside the Add dialog, after adding: Done steps back. */
    onDone?: () => void | Promise<void>;
}>;

type Reach = Readonly<{ key: 'command' | 'remote'; title: string; description: string; icon: 'terminal' | 'globe' }>;

const reachOf = (server: McpServerCatalogEntryV1): Reach['key'] => server.transport === 'stdio' ? 'command' : 'remote';

/** Retired Account drafts never mount readers or expose the previous Account's fields. */
export function McpCustomInput(props: Props): React.ReactElement {
    if (!props.draft.current) return <SurfaceStateCard kind={props.draft.resolving ? 'loading' : 'error'} size="line"
        title={props.draft.resolving ? t('common.loading') : t('common.unavailable')} testID="mcp.server.editor.unavailable" />;
    return props.ctx ? <McpCustomFound {...props} ctx={props.ctx} /> : <McpCustomEditor {...props} />;
}

/** Why Add can't run yet, said once beside it; `null` when the draft is a server Happier can save. */
function incompleteReason(server: McpServerCatalogEntryV1): string | null {
    if (McpServerCatalogEntryV1Schema.safeParse(server).success) return null;
    if (server.transport === 'stdio' && !server.stdio?.command.trim()) return t('capabilities.mcpAdd.custom.needsCommand');
    if (server.transport !== 'stdio' && !server.remote?.url.trim()) return t('capabilities.mcpAdd.custom.needsAddress');
    return t('capabilities.mcpAdd.custom.needsName');
}

function McpCustomFound(props: Props & Readonly<{ ctx: CapabilityAddInputContext }>): React.ReactElement {
    const { draft } = props;
    const { theme } = useUnistyles();
    const state = useStore(draft.store);
    const reaches = React.useMemo((): readonly Reach[] => [
        { key: 'command', title: t('capabilities.mcpAdd.custom.command'), description: t('capabilities.mcpAdd.custom.commandBody'), icon: 'terminal' },
        { key: 'remote', title: t('capabilities.mcpAdd.custom.remote'), description: t('capabilities.mcpAdd.custom.remoteBody'), icon: 'globe' },
    ], []);
    const anatomy = React.useMemo(() => buildCapabilityCollectionAnatomy<Reach>({
        title: reach => reach.title,
        description: reach => reach.description,
        mark: reach => <Icon name={reach.icon} size={ICON_SIZE.md} color={theme.colors.text.secondary} />,
        facts: () => ({}),
        accessibilityLabel: reach => `${reach.title}, ${reach.description}`,
        testID: reach => `mcp.server.reach.${reach.key}`,
    }), [theme.colors.text.secondary]);
    const reason = !draft.writable ? t('capabilities.add.addFailed') : incompleteReason(state.server);
    const addedId = state.addedId;
    return props.ctx.renderFound<Reach>({
        items: reaches,
        initialItemKey: reachOf(state.server),
        itemKey: reach => reach.key,
        groups: [{ key: 'reach', title: t('capabilities.mcpAdd.custom.reachTitle'), itemKeys: reaches.map(reach => reach.key) }],
        anatomy,
        empty: null,
        renderDetail: reach => <McpCustomDetail {...props} reach={reach} />,
        detailFooter: () => ({
            provenance: <Text variant="meta" style={{ color: theme.colors.text.secondary }}>{t('capabilities.mcpAdd.detail.runsNote')}</Text>,
            primary: {
                label: t('capabilities.mcpAdd.addServer'),
                busy: state.busy,
                ...(reason === null ? {} : { disabledReason: reason }),
                onPress: async () => {
                    const id = await draft.create();
                    return id ? { itemId: id, then: 'stay' as const } : null;
                },
            },
            afterAdd: {
                start: (
                    <View style={styles.note} testID="mcp.server.editor.added" accessibilityLiveRegion="polite">
                        <Icon name="check" size={ICON_SIZE.xs} color={theme.colors.text.secondary} />
                        <Text variant="meta" style={{ color: theme.colors.text.secondary }}>{t('capabilities.add.added')}</Text>
                    </View>
                ),
                ...(addedId && props.onOpen ? { open: { label: t('capabilities.mcpAdd.open'), onPress: () => { void props.onOpen?.(addedId); } } } : {}),
                ...(props.onDone ? { onDone: () => { void props.onDone?.(); } } : {}),
            },
        }),
    });
}

/** The chosen way in, edited in its own form: the command's or the address's fields, never a second transport picker. */
function McpCustomDetail(props: Props & Readonly<{ reach: Reach }>): React.ReactElement {
    const { draft, reach } = props;
    const state = useStore(draft.store);
    const { theme } = useUnistyles();
    // Choosing a row is the transport choice; a remote keeps HTTP or SSE, whichever the form last chose.
    React.useEffect(() => {
        const server = draft.store.getState().server;
        if (reachOf(server) !== reach.key) draft.changeServer(current => withMcpServerTransport(current, reach.key === 'command' ? 'stdio' : 'http'));
    }, [draft, reach.key]);
    const displayName = state.server.title?.trim() || (state.server.name === draft.initialName ? '' : state.server.name.trim());
    return <View>
        <CapabilityDetailHeader
            testID="mcp.server.editor.header"
            mark={<Icon name={reach.icon} size={28} color={theme.colors.text.secondary} />}
            title={displayName || t('mcpSettings.newServer')}
            purpose={reach.key === 'command' ? t('capabilities.mcpAdd.custom.runsCommand') : t('capabilities.mcpAdd.custom.runsRemote')}
            facts={{ source: { kind: 'you' } }}
        />
        <CapabilityAddDetailAction />
        <McpCustomSections {...props} transports={reach.key === 'command' ? ['stdio'] : ['http', 'sse']} />
    </View>;
}

function McpCustomEditor({ draft, approval, places, onCreated, onOpen, onDiscard, publishTitle }: Props): React.ReactElement {
    const state = useStore(draft.store);
    const displayName = state.server.title?.trim() || (state.server.name === draft.initialName ? '' : state.server.name.trim());
    const collectionTitle = useCollectionDraftTitle();
    React.useEffect(() => {
        if (publishTitle) collectionTitle.publish(displayName);
    }, [collectionTitle, displayName, publishTitle]);
    React.useEffect(() => publishTitle ? () => collectionTitle.publish('') : undefined, [collectionTitle, publishTitle]);
    const save = async () => {
        const id = await draft.create();
        if (id) onCreated?.(id);
    };
    return <ItemList keyboardShouldPersistTaps="handled">
        <CapabilityDetailHeader
            testID="mcp.server.editor.header"
            mark={<HappierBrandMark brand={{ displayName: displayName || t('mcpSettings.newServer') }} pixelSize={28} externallyLabelled />}
            title={displayName || t('mcpSettings.newServer')}
            purpose={t('mcpSettings.serverPurpose')}
            facts={{ source: { kind: 'you' }, extra: [state.server.transport === 'stdio' ? t('capabilities.mcp.local') : t('capabilities.mcp.remote')] }}
            menuItems={onDiscard ? [{ id: 'discard', title: t('mcpSettings.discardDraft'),
                testID: 'mcp.server.editor.secondaryAction', onSelect: onDiscard }] : undefined}
            primaryAction={state.addedId ? {
                testID: 'mcp.server.editor.open', title: t('capabilities.mcpAdd.open'),
                onPress: () => state.addedId ? onOpen?.(state.addedId) : undefined,
            } : {
                testID: 'mcp.server.editor.save', title: t('capabilities.mcpAdd.addServer'),
                disabled: !draft.writable || state.busy || !McpServerCatalogEntryV1Schema.safeParse(state.server).success,
                onPress: save,
            }}
        />
        {state.addedId ? <SurfaceStateCard kind="empty" size="line" testID="mcp.server.editor.added" title={t('capabilities.add.added')} />
            : <McpCustomSections draft={draft} approval={approval} places={places} />}
    </ItemList>;
}

/**
 * What a new server holds, then where it's on (lab `n:custom`). While its add is pending, or once it landed, every
 * field holds still: the draft refuses edits then, so the form says so instead of accepting keystrokes it drops.
 */
function McpCustomSections(props: Pick<Props, 'draft' | 'approval' | 'places'> & Readonly<{
    transports?: React.ComponentProps<typeof McpServerConfigurationSection>['transports'];
}>): React.ReactElement {
    const { draft, approval, places } = props;
    const state = useStore(draft.store);
    const router = useRouter();
    const secrets = useSavedSecretCatalog({ scope: draft.scope });
    const materializedSecrets = React.useMemo(() => [...secrets.materializedSecrets], [secrets.materializedSecrets]);
    const projection = React.useMemo(() => projectReachOnMachines(draft.reach.rules, places.machines, undefined, places.workspaceRefs),
        [draft.reach.rules, places.machines, places.workspaceRefs]);
    const readOnly = state.busy || state.addedId !== null;
    return <>
        {approval.approvalId && draft.scope ? <ItemGroup>
            <ActionApprovalPendingNotice testID="mcp.server.editor.approval" message={t('secrets.catalog.approvalPending')}
                onOpenApproval={() => router.pushRetainingCurrent(`/inbox/approvals/${encodeURIComponent(approval.approvalId!)}?serverId=${encodeURIComponent(draft.scope!.serverId)}`)} />
        </ItemGroup> : null}
        {state.error ? <SurfaceStateCard kind="error" size="line" title={state.error} testID="mcp.server.editor.error" /> : null}
        <McpServerConfigurationSection draftServer={state.server} secrets={materializedSecrets}
            scope={draft.scope} mode="create" readOnly={readOnly}
            {...(props.transports ? { transports: props.transports } : {})}
            onChangeServer={draft.changeServer} />
        <WhereItsOnControl testID="mcp.server.where" kind="mcp_server" presentation="section"
            rules={draft.reach.rules} status="ready" projection={projection}
            {...(readOnly ? { readOnlyReason: state.addedId ? t('capabilities.add.added') : t('capabilities.mcpAdd.custom.adding') } : {})}
            places={{ agentIds: places.agentIds, machines: places.placeMachines, projects: places.projects }}
            agentTakes={places.agentTakes} onChange={draft.reach.onChange} />
    </>;
}

const styles = StyleSheet.create((theme) => ({
    note: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s8 },
}));
