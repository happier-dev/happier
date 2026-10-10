import { happierPageTextMetrics, HAPPIER_WORK_PANE_METRICS, HappierPageSheetGroup } from '@happier-dev/plugin-ui/presentation';
import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { SessionContextIntentV1 } from '@happier-dev/protocol/sessions/context/sessionContextV1';
import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { PromptStackDocumentMenu } from '@/components/settings/prompts/stacks/PromptStackDocumentMenu';
import { PromptStackEntryRow } from '@/components/settings/prompts/stacks/PromptStackEntryRow';
import { promptStackEntryHref, promptStackPlacementLabel } from '@/components/settings/prompts/stacks/promptStackEntryPresentation';
import { WorkSection, WorkSectionEmptyLine } from '@/components/sessions/work/WorkSection';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { Icon, type IconName } from '@/components/ui/icons/Icon';
import { CollectionListGroupLabel } from '@/components/ui/lists/collection/CollectionList';
import { Text } from '@/components/ui/text/Text';
import { SurfaceFreshnessLine } from '@/components/ui/surfaces/SurfaceFreshnessLine';
import { Typography } from '@/constants/Typography';
import { randomUUID } from '@/platform/randomUUID';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import type { Session } from '@/sync/domains/state/storageTypes';
import {
    memoryDocumentActions,
    readMemoryActionOutcome,
    type MemorySessionTarget,
} from '@/sync/ops/promptLibrary/memoryDocuments';
import { t } from '@/text';
import { fireAndForget } from '@/utils/system/fireAndForget';

import { resolveSessionInstructionsAccess } from '../instructions/SessionInstructionsSection';
import { useSessionContextLayers, type SessionContextRow } from './useSessionContextLayers';

/** Session-layer entries that already have their own Work section. */
const OWN_SECTION_ENTRY_IDS = new Set(['session.instructions', 'session.memory']);

/**
 * Work › Context (plan 65 §2/§8, lab `c-mem O`): everything this Session reads before each turn, in
 * the resolver's order — From your account, From the profile, From the project, Added here — each
 * with its switch. A switch on an inherited entry changes only this Session
 * (`session.context.update` `inherited_enable`); entries added here can be switched or removed. An
 * entry that is off where it was added says so and cannot be switched on from here.
 */
export const SessionContextSection = React.memo(function SessionContextSection(props: Readonly<{
    session: Session;
    serverId: string;
}>) {
    const { session, serverId } = props;
    const access = resolveSessionInstructionsAccess(session);
    const ownerMetadata = React.useMemo(() => readSessionOwnerMetadataView(session), [session]);
    if (access !== 'readable' || !ownerMetadata) return null;
    return <SessionContextBody session={session} serverId={serverId} ownerMetadata={ownerMetadata} />;
});

const SessionContextBody = React.memo(function SessionContextBody(props: Readonly<{
    session: Session;
    serverId: string;
    ownerMetadata: unknown;
}>) {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const { session, serverId } = props;
    const router = useRouter();
    const layers = useSessionContextLayers({
        sessionId: session.id, serverId, ownerMetadata: props.ownerMetadata, metadataVersion: session.metadataVersion,
    });
    const [saving, setSaving] = React.useState(false);
    // A refused change says so in the section until the next attempt.
    const [refused, setRefused] = React.useState(false);
    const [adding, setAdding] = React.useState(false);
    const addAnchorRef = React.useRef<View>(null);
    const target = React.useMemo<MemorySessionTarget>(
        () => ({ sessionId: session.id, serverId, expectedMetadataRevision: session.metadataVersion }),
        [serverId, session.id, session.metadataVersion],
    );

    const update = React.useCallback((intent: SessionContextIntentV1) => {
        setSaving(true);
        setRefused(false);
        fireAndForget((async () => {
            let result: ActionExecuteResult | null = null;
            try {
                result = await memoryDocumentActions.updateSessionContext(target, intent);
            } catch { /* reported below */ }
            setSaving(false);
            if (!result || readMemoryActionOutcome(result) !== 'applied') setRefused(true);
        })(), { tag: 'SessionContextSection.update' });
    }, [target]);

    const open = React.useCallback((row: SessionContextRow) => {
        const href = promptStackEntryHref(row.entry, row.currentPresentation().kind, serverId);
        if (href) router.push(href as never);
    }, [router, serverId]);

    const added = layers.session.filter((row) => !OWN_SECTION_ENTRY_IDS.has(row.entry.id));
    const groups: readonly Readonly<{ id: string; icon: IconName; label: string; rows: readonly SessionContextRow[] }>[] = [
        { id: 'account', icon: 'user-circle', label: t('memoryContext.session.fromAccount'), rows: layers.account },
        { id: 'profile', icon: 'sliders-horizontal', label: layers.profile.name ? t('memoryContext.session.fromProfile', { name: layers.profile.name }) : t('memoryContext.session.fromProfileUnnamed'), rows: layers.profile.rows },
        {
            id: 'project', icon: 'folder',
            label: layers.project.name ? t('memoryContext.session.fromProject', { name: layers.project.name }) : t('memoryContext.session.fromProjectUnnamed'),
            rows: layers.project.rows,
        },
        { id: 'session', icon: 'file-text', label: t('memoryContext.session.addedHere'), rows: added },
    ];
    const visible = groups.filter((group) => group.rows.length > 0);
    const layersKnown = layers.accountStatus === 'ready' && layers.profile.status === 'ready'
        && (layers.project.status === 'ready' || layers.project.status === 'none') && layers.sessionStackValid;
    const unavailable = layers.accountStatus === 'unavailable' || layers.profile.status === 'unavailable' || !layers.sessionStackValid;
    const onCount = visible.reduce((sum, group) => sum + group.rows.filter((row) => row.on).length, 0);
    // Documents already in this Session's own layer are left out of "Add document".
    const attachedRefs = React.useMemo(
        () => layers.session.map(row => row.entry.ref),
        [layers.session],
    );

    return (
        <WorkSection
            testID="session-work-context"
            anatomy="page"
            title={t('memoryContext.session.contextTitle')}
            count={onCount > 0 ? t('memoryContext.session.contextOnCount', { count: onCount }) : ''}
            nativeID="context"
            action={layers.accountKnown ? (
                <View ref={addAnchorRef} collapsable={false}>
                    <IconButton
                        testID="session-work-context.add"
                        iconName="plus"
                        variant="plain"
                        accessibilityLabel={t('memoryContext.session.addDocument')}
                        tooltip={t('memoryContext.session.addDocument')}
                        expanded={adding}
                        hasPopup="menu"
                        disabled={saving}
                        onPress={() => setAdding(true)}
                    />
                    {adding ? (
                        <PromptStackDocumentMenu
                            testID="session-work-context.addMenu"
                            anchorRef={addAnchorRef}
                            serverId={serverId}
                            attachedRefs={attachedRefs}
                            onClose={() => setAdding(false)}
                            onPick={(ref) => {
                                setAdding(false);
                                update({ kind: 'attach', entry: { id: `session.${randomUUID()}`, ref, enabled: true, placement: 'system_append' } });
                            }}
                        />
                    ) : null}
                </View>
            ) : null}
        >
            {!layersKnown && layers.project.status !== 'unavailable' ? (
                <SurfaceFreshnessLine testID="session-work-context.layersUnavailable" tone={unavailable ? 'warning' : 'neutral'}
                    busy={!unavailable}
                    reason={t(unavailable ? 'memoryContext.session.layersUnavailable' : 'memoryContext.session.layersLoading')} />
            ) : null}
            {refused ? (
                <SurfaceFreshnessLine testID="session-work-context.refused" tone="warning" reason={t('memoryContext.session.refused')} />
            ) : null}
            {layers.project.status === 'unavailable' ? (
                <SurfaceFreshnessLine testID="session-work-context.projectUnavailable" tone="warning" reason={t('memoryContext.session.projectUnavailable')} />
            ) : null}
            {visible.length > 0 ? (
                <Text style={styles.description}>{t('memoryContext.session.contextDescription')}</Text>
            ) : null}
            {visible.length === 0 && layersKnown ? (
                <WorkSectionEmptyLine testID="session-work-context.empty" text={t('memoryContext.session.contextEmpty')} />
            ) : visible.map((group) => (
                <HappierPageSheetGroup
                    key={group.id}
                    header={(
                        <CollectionListGroupLabel
                            testID={`session-work-context.group.${group.id}`}
                            title={group.label}
                            mark={<Icon name={group.icon} size={16} color={theme.colors.text.secondary} />}
                        />
                    )}
                >
                    {group.rows.map((row, index) => {
                        const title = row.title ?? (row.kind === 'memory' ? t('memoryContext.memory.title') : t('promptLibrary.untitledPrompt'));
                        const label = row.kind === 'memory'
                            ? (row.layer === 'account' ? t('memoryContext.session.yourMemory')
                                : row.layer === 'project' ? t('memoryContext.session.projectMemory') : title)
                            : title;
                        const subtitle = row.kind === 'unknown' ? t('common.unavailable') : row.off === 'session' ? t('memoryContext.session.offForSession')
                            : row.off === 'source' ? t('memoryContext.session.offAtSource')
                                : row.off === 'memory' ? t('memoryContext.session.memoryOff')
                                    : row.kind === 'memory' ? t('memoryContext.memory.title')
                                        // What it is to the agent ("System append", "Skill instructions"), as its own page says it.
                                        : promptStackPlacementLabel(row.entry.placement);
                        const inherited = row.layer !== 'session';
                        // The one Context row every layer draws; this layer adds only what a Session decides:
                        // its own on/off over an inherited entry, and that an inherited entry is not removed here.
                        return (
                            <PromptStackEntryRow
                                key={`${row.layer}:${row.entry.id}`}
                                testID={`session-work-context.entry.${row.layer}.${row.entry.id}`}
                                entry={row.entry}
                                title={label}
                                note={subtitle}
                                on={row.on}
                                unavailable={row.kind === 'unknown'}
                                disabled={saving}
                                showDivider={false}
                                onOpen={row.kind === 'unknown' ? undefined : () => open(row)}
                                // An inherited entry is edited where it was added: opening it is the row's press.
                                {...(inherited ? {} : {
                                    onRemove: () => update({ kind: 'detach', entryId: row.entry.id }),
                                    removeLabel: t('memoryContext.session.remove'),
                                    onMove: (delta: -1 | 1) => {
                                        const sibling = added[index + delta];
                                        if (sibling) update({ kind: 'reorder', entryId: row.entry.id,
                                            siblingId: sibling.entry.id, position: delta < 0 ? 'before' : 'after' });
                                    },
                                    canMoveUp: index > 0,
                                    canMoveDown: index < added.length - 1,
                                    onBudgetChange: (maxChars: number | null) => update({ kind: 'set_budget', entryId: row.entry.id, maxChars }),
                                })}
                                switchDisabled={row.kind === 'unknown' || row.off === 'source' || row.off === 'memory'}
                                onEnabledChange={(enabled) => update(inherited
                                    ? { kind: 'inherited_enable', entryId: row.entry.id, enabled }
                                    : { kind: 'set_enabled', entryId: row.entry.id, enabled })}
                            />
                        );
                    })}
                </HappierPageSheetGroup>
            ))}
        </WorkSection>
    );
});

const stylesheet = StyleSheet.create((theme) => ({
    description: {
        ...Typography.default(),
        ...happierPageTextMetrics('sectionDescription'),
        color: theme.colors.text.secondary,
        paddingHorizontal: HAPPIER_WORK_PANE_METRICS.rowInsetPx,
        paddingBottom: 6,
    },
}));
