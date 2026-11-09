import { HappierPageSheetGroup } from '@happier-dev/plugin-ui/presentation';
import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { SessionContextIntentV1 } from '@happier-dev/protocol/sessions/context/sessionContextV1';
import * as React from 'react';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { PromptStackDocumentMenu } from '@/components/settings/prompts/stacks/PromptStackDocumentMenu';
import { PromptStackEntryRow } from '@/components/settings/prompts/stacks/PromptStackEntryRow';
import { promptStackEntryHref, promptStackPlacementLabel } from '@/components/settings/prompts/stacks/promptStackEntryPresentation';
import { isStaleSessionIntent, SessionIntentConflictLine } from '@/components/sessions/work/SessionIntentConflictLine';
import { WorkSection, WorkSectionDescription, WorkSectionEmptyLine } from '@/components/sessions/work/WorkSection';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { Icon, type IconName } from '@/components/ui/icons/Icon';
import { CollectionListGroupLabel } from '@/components/ui/lists/collection/CollectionList';
import { SurfaceFreshnessLine } from '@/components/ui/surfaces/SurfaceFreshnessLine';
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
import type { SessionContextLayers, SessionContextRow } from './useSessionContextLayers';
import { SessionContextLayersObservation } from './SessionContextLayersScope';

/** What a row is called: its document's title, else what kind of document it is. */
function rowTitle(row: SessionContextRow): string {
    return row.title ?? (row.kind === 'memory' ? t('memoryContext.memory.title') : t('promptLibrary.untitledPrompt'));
}

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
    return <SessionContextLayersObservation params={{ sessionId: session.id, serverId, ownerMetadata, metadataVersion: session.metadataVersion }}>
        {layers => <SessionContextBody key={JSON.stringify([serverId, session.id])} session={session} serverId={serverId} layers={layers} />}
    </SessionContextLayersObservation>;
});

const SessionContextBody = React.memo(function SessionContextBody(props: Readonly<{
    session: Session;
    serverId: string;
    layers: SessionContextLayers;
}>) {
    const { theme } = useUnistyles();
    const { session, serverId } = props;
    const router = useRouter();
    const { layers } = props;
    const [saving, setSaving] = React.useState(false);
    // A refused change says so in the section until the next attempt.
    const [refused, setRefused] = React.useState(false);
    // A change the Session was no longer at the revision for is held, not lost: the rows keep their current values.
    const [held, setHeld] = React.useState<SessionContextIntentV1 | null>(null);
    const [adding, setAdding] = React.useState(false);
    const addAnchorRef = React.useRef<View>(null);
    const target = React.useMemo<MemorySessionTarget>(
        () => ({ sessionId: session.id, serverId, expectedMetadataRevision: session.metadataVersion }),
        [serverId, session.id, session.metadataVersion],
    );

    const update = React.useCallback((intent: SessionContextIntentV1) => {
        setSaving(true);
        setRefused(false);
        setHeld(null);
        fireAndForget((async () => {
            let result: ActionExecuteResult | null = null;
            try {
                result = await memoryDocumentActions.updateSessionContext(target, intent);
            } catch { /* reported below */ }
            setSaving(false);
            if (result && isStaleSessionIntent(result)) setHeld(intent);
            else if (!result || readMemoryActionOutcome(result) !== 'applied') setRefused(true);
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
    // A held switch change names what that entry is now; any other held change just says the Context moved.
    const heldEntryId = held && (held.kind === 'inherited_enable' || held.kind === 'set_enabled') ? held.entryId : null;
    const heldRow = heldEntryId ? groups.flatMap((group) => group.rows).find((row) => row.entry.id === heldEntryId) : undefined;
    const heldSwitchNow = heldRow ? `${rowTitle(heldRow)} · ${heldRow.on ? t('common.on') : t('common.off')}` : undefined;
    const onCount = visible.reduce((sum, group) => sum + group.rows.filter((row) => row.on).length, 0);
    // Documents already in this Session's own layer are left out of "Add document".
    const attachedRefs = React.useMemo(
        () => layers.session.map(row => row.entry.ref),
        [layers.session],
    );

    return (
        <WorkSection
            testID="session-work-context"
            icon="list"
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
            {held ? (
                <SessionIntentConflictLine
                    testID="session-work-context.conflict"
                    subject={t('memoryContext.session.contextTitle')}
                    current={heldSwitchNow}
                    onApply={() => update(held)}
                    onKeep={() => setHeld(null)}
                />
            ) : refused ? (
                <SurfaceFreshnessLine testID="session-work-context.refused" tone="warning" reason={t('memoryContext.session.refused')} />
            ) : null}
            {layers.project.status === 'unavailable' ? (
                <SurfaceFreshnessLine testID="session-work-context.projectUnavailable" tone="warning" reason={t('memoryContext.session.projectUnavailable')} />
            ) : null}
            {visible.length > 0 ? (
                <WorkSectionDescription>{t('memoryContext.session.contextDescription')}</WorkSectionDescription>
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
                        const title = rowTitle(row);
                        const label = row.kind === 'memory'
                            ? (row.layer === 'account' ? t('memoryContext.session.yourMemory')
                                : row.layer === 'project' ? t('memoryContext.session.projectMemory') : title)
                            : title;
                        const subtitle = row.presentationStatus === 'unavailable' ? t('common.unavailable') : row.off === 'session' ? t('memoryContext.session.offForSession')
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
                                loading={row.presentationStatus === 'loading'}
                                unavailable={row.presentationStatus === 'unavailable'}
                                disabled={saving}
                                showDivider={false}
                                onOpen={row.presentationStatus === 'ready' ? () => open(row) : undefined}
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
                                    // One Doc added here can be this Session's plan; Work shows it as its Plan row.
                                    ...(row.kind === 'doc' ? { plan: {
                                        marked: row.entry.plan === true,
                                        onChange: (marked: boolean) => update({ kind: 'set_plan', entryId: marked ? row.entry.id : null }),
                                    } } : {}),
                                })}
                                switchDisabled={row.presentationStatus === 'unavailable' || row.off === 'source' || row.off === 'memory'
                                    || row.layer === 'project' && layers.project.refreshing}
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


