import * as React from 'react';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { formatHappierAsOfTime, HappierPressable } from '@happier-dev/plugin-ui/presentation';
import type { PluginContributionIdentityV1, PublicActionResultById } from '@happier-dev/protocol';
import { readWidgetDefinitionResourcesV1, type WidgetDefinitionV1, type WidgetInstanceRefV1 } from '@happier-dev/protocol/widgets';

import { useAppShellPluginUiProjection } from '@/components/appShell/plugins/AppShellPluginUiProjection';
import { useWorkBoardSummaries } from '@/components/boards/model/useWorkBoards';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Icon } from '@/components/ui/icons/Icon';
import { focusRingStyle } from '@/components/ui/interactions/interactionFeedback';
import { Text } from '@/components/ui/text/Text';
import { readPluginUiContributionOrigin } from '@/sync/domains/plugins/ui/projectionUnion';
import { resolveServerScopedMachine } from '@/sync/store/domains/machines/resolveServerScopedMachine';
import { storage, useArtifact } from '@/sync/domains/state/storage';
import { t } from '@/text';
import { getMachineDisplayName } from '@/utils/sessions/machineDisplayNames';
import { getSessionName } from '@/utils/sessions/sessionUtils';

import { WidgetDefinitionPanel, WidgetFactRow, widgetPanelText } from './WidgetDefinitionPanel';

type PlacementSummary = NonNullable<PublicActionResultById['widgets.definition.get']['placementSummary']>;

/** One read the definition admits, as the person reads it. */
export type WidgetAboutSource = Readonly<{
    key: string;
    /** The serving plugin ("analytics replica"). */
    plugin: string;
    /** The machine its read runs on, when the projection says so. */
    machine: string | null;
    /** Each viewer's own connection is used for it. */
    usesViewerConnection: boolean;
    /** The exact declared read. Its saved query text is shown only if the plugin itself exposes it. */
    read: string;
}>;

/** The admitted reads of a definition, from the current projection — never invented from an id. */
export function useWidgetAboutSources(definition: WidgetDefinitionV1): readonly WidgetAboutSource[] {
    const projection = useAppShellPluginUiProjection().pluginUiProjection;
    return React.useMemo(() => {
        const resources: readonly PluginContributionIdentityV1[] = readWidgetDefinitionResourcesV1(definition);
        const state = storage.getState();
        return resources.map((resource) => {
            const declaration = Object.values(projection?.resourcesById ?? {}).find((row) => row.pluginId === resource.pluginId && row.id === resource.localId);
            const origin = readPluginUiContributionOrigin(declaration);
            const machine = origin?.machineId ? resolveServerScopedMachine(state, origin.serverId, origin.machineId) : null;
            return {
                key: `${resource.pluginId}/${resource.localId}`,
                plugin: projection?.installedPackagesById[resource.pluginId]?.displayName ?? resource.pluginId,
                machine: getMachineDisplayName(machine),
                usesViewerConnection: (declaration?.connectedAccountPurposes?.length ?? 0) > 0,
                read: resource.localId,
            };
        });
    }, [definition, projection]);
}

/** Where the copies are, in words ("Launch board · Home"); scopes it cannot list are said, never guessed. */
export function useWidgetPlacementLabels(summary: PlacementSummary | null): readonly string[] {
    const boards = useWorkBoardSummaries(summary?.placements.some(ref => ref.surface.owner.kind === 'workBoard') ?? false);
    return React.useMemo(() => {
        if (!summary) return [];
        const labels = summary.placements.map((ref: WidgetInstanceRefV1) => {
            const owner = ref.surface.owner;
            switch (owner.kind) {
                case 'home': return t('widgetDefinition.placedOnHome');
                case 'workBoard': {
                    const board = boards.find((candidate) => candidate.id === owner.boardId);
                    return board ? t('widgetDefinition.placedOnBoard', { board: board.name }) : t('widgetDefinition.placedOnABoard');
                }
                case 'sessionBoard':
                case 'companion': {
                    const session = storage.getState().sessions[owner.sessionId];
                    return session ? getSessionName(session, ref.surface.serverId) : t('widgetDefinition.placedInASession');
                }
                case 'project': return t('widgetDefinition.placedInAProject');
                case 'pluginArea': return t('widgetDefinition.placedOnAPluginPage');
            }
        });
        return [...new Set(labels)];
    }, [boards, summary]);
}

/**
 * About this widget (lab `dashboards` dagent G2): who made it and from where, the read it is allowed
 * to make and where that runs, its inputs for this copy, how it refreshes, and every place it is
 * used — with the consequence said plainly: editing the widget changes all of them. Change with the
 * agent drafts a request; Duplicate makes an independent copy.
 */
export function WidgetAboutPanel(props: Readonly<{
    artifactId: string;
    definition: WidgetDefinitionV1;
    placements: PlacementSummary | null;
    /** This copy's binding, in words, and the step that edits it. */
    inputs?: Readonly<{ binding: string | null; onEdit?: () => void }>;
    onRefresh?: () => Promise<boolean>;
    onChangeWithAgent?: () => void;
    onDuplicate: () => Promise<string | null>;
    testID: string;
}>): React.ReactElement {
    const { theme } = useUnistyles();
    const text = widgetPanelText;
    const artifact = useArtifact(props.artifactId);
    const sources = useWidgetAboutSources(props.definition);
    const placements = useWidgetPlacementLabels(props.placements);
    const [refresh, setRefresh] = React.useState<'idle' | 'busy' | 'done' | 'failed'>('idle');
    const [duplicate, setDuplicate] = React.useState<Readonly<{ state: 'idle' | 'busy' } | { state: 'done'; name: string } | { state: 'failed' }>>({ state: 'idle' });

    const provenance = props.definition.provenance.source;
    const origin = provenance.kind === 'session'
        ? (() => {
            const session = storage.getState().sessions[provenance.sessionId];
            return t('widgetDefinition.savedFromSession', { session: session ? getSessionName(session, provenance.serverId) : t('widgetDefinition.aSession') });
        })()
        : t('widgetDefinition.madeInYourAccount');
    const edited = artifact?.updatedAt ? t('widgetDefinition.edited', { time: formatHappierAsOfTime(artifact.updatedAt) }) : null;
    const count = props.placements?.placements.length ?? 0;
    const unlisted = (props.placements?.unavailableScopes.length ?? 0) > 0;

    const link = (label: string, onPress: () => void, testID: string) => (
        <HappierPressable testID={testID} accessibilityRole="button" accessibilityLabel={label} onPress={onPress}
            style={(state) => focusRingStyle({ focused: state.focused, color: theme.colors.border.focus })}>
            <Text style={text.link}>{label}</Text>
        </HappierPressable>
    );

    return (
        <WidgetDefinitionPanel
            title={props.definition.name}
            hint={edited ? `${origin} · ${edited}` : origin}
            testID={props.testID}
            footerStart={(
                <View style={{ flex: 1, flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
                    {props.onChangeWithAgent ? (
                        <RoundButton testID={`${props.testID}.changeWithAgent`} size="small" display="secondary"
                            title={t('widgetDefinition.changeWithAgent')} onPress={props.onChangeWithAgent} />
                    ) : null}
                    <RoundButton
                        testID={`${props.testID}.duplicate`}
                        size="small"
                        display="secondary"
                        title={t('widgetDefinition.duplicate')}
                        loading={duplicate.state === 'busy'}
                        disabled={duplicate.state === 'busy'}
                        onPress={() => {
                            setDuplicate({ state: 'busy' });
                            void props.onDuplicate().then((name) => setDuplicate(name ? { state: 'done', name } : { state: 'failed' }));
                        }}
                    />
                    {duplicate.state === 'done' || duplicate.state === 'failed' ? (
                        <Text style={text.secondary} accessibilityLiveRegion="polite" testID={`${props.testID}.duplicateResult`}>
                            {duplicate.state === 'done' ? t('widgetDefinition.duplicated', { name: duplicate.name }) : t('widgetDefinition.duplicateFailed')}
                        </Text>
                    ) : null}
                </View>
            )}
        >
            {sources.length > 0 ? (
                <WidgetFactRow label={t('widgetDefinition.aboutData')} testID={`${props.testID}.data`}>
                    {sources.map((source) => (
                        <View key={source.key}>
                            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                                <Icon name="hard-drives" size={14} color={theme.colors.text.secondary} />
                                <Text style={[text.primary, text.strong]}>{source.plugin}</Text>
                            </View>
                            <Text style={text.secondary}>
                                {[t('widgetDefinition.readsOnly'),
                                    source.machine ? t('widgetDefinition.runsOn', { machine: source.machine }) : null,
                                    source.usesViewerConnection ? t('widgetDefinition.withYourConnection') : null].filter(Boolean).join(' · ')}
                            </Text>
                        </View>
                    ))}
                </WidgetFactRow>
            ) : null}
            {sources.length > 0 ? (
                <WidgetFactRow label={t('widgetDefinition.aboutReads')} testID={`${props.testID}.reads`}>
                    {sources.map((source) => (
                        <Text key={source.key} style={text.primary}>{t('widgetDefinition.readsResource', { read: source.read, plugin: source.plugin })}</Text>
                    ))}
                    <Text style={text.secondary}>{t('widgetDefinition.cannotRunAnythingElse')}</Text>
                </WidgetFactRow>
            ) : null}
            {props.inputs && props.definition.inputs.fields.length > 0 ? (
                <WidgetFactRow label={t('widgetDefinition.aboutInputs')} testID={`${props.testID}.inputs`}>
                    <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'baseline', gap: 6 }}>
                        <Text style={text.primary}>
                            {props.inputs.binding ?? props.definition.inputs.fields.map((field) => field.title).join(', ')}
                        </Text>
                        {props.inputs.onEdit ? link(t('common.edit'), props.inputs.onEdit, `${props.testID}.editInputs`) : null}
                    </View>
                    <Text style={text.secondary}>{t('widgetDefinition.inputsThisCopy')}</Text>
                </WidgetFactRow>
            ) : null}
            {sources.length > 0 ? (
                <WidgetFactRow label={t('widgetDefinition.aboutRefresh')} testID={`${props.testID}.refresh`}>
                    <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'baseline', gap: 6 }}>
                        <Text style={text.primary}>{t('widgetDefinition.refreshWhenOpen')}</Text>
                        {props.onRefresh ? link(
                            refresh === 'busy' ? t('widgetDefinition.refreshing') : t('widgetDefinition.refreshNow'),
                            () => {
                                if (refresh === 'busy') return;
                                setRefresh('busy');
                                void props.onRefresh!().then((ok) => setRefresh(ok ? 'done' : 'failed'));
                            },
                            `${props.testID}.refreshNow`,
                        ) : null}
                    </View>
                    {refresh === 'done' || refresh === 'failed' ? (
                        <Text style={text.secondary} accessibilityLiveRegion="polite">
                            {refresh === 'done' ? t('widgetDefinition.refreshed') : t('widgetDefinition.refreshFailed')}
                        </Text>
                    ) : null}
                </WidgetFactRow>
            ) : null}
            <WidgetFactRow label={t('widgetDefinition.aboutUsedIn')} testID={`${props.testID}.usedIn`}>
                <Text style={text.primary}>{placements.length > 0 ? placements.join(' · ') : t('widgetDefinition.notPlacedYet')}</Text>
                {unlisted ? <Text style={text.secondary}>{t('widgetDefinition.otherPlacesNotListed')}</Text> : null}
                <Text style={text.secondary} testID={`${props.testID}.consequence`}>
                    {unlisted || count === 0 ? t('widgetDefinition.editsChangeEverywhere') : t('widgetDefinition.editsChangeAll', { count })}
                </Text>
            </WidgetFactRow>
        </WidgetDefinitionPanel>
    );
}
