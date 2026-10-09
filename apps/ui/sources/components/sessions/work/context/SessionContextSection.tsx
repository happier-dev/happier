import { happierPageTextMetrics, HAPPIER_WORK_PANE_METRICS, HappierPageSheetGroup } from '@happier-dev/plugin-ui/presentation';
import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { SessionContextIntentV1 } from '@happier-dev/protocol/sessions/context/sessionContextV1';
import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { memoryDocumentHref } from '@/components/memory/memoryDocumentRoutes';
import { promptCollectionItemHref } from '@/components/settings/prompts/collection/promptCollectionModel';
import { WorkSection } from '@/components/sessions/work/WorkSection';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { Switch } from '@/components/ui/forms/Switch';
import { Icon, type IconName } from '@/components/ui/icons/Icon';
import { CollectionListGroupLabel } from '@/components/ui/lists/collection/CollectionList';
import { Item } from '@/components/ui/lists/Item';
import { ItemRowActions } from '@/components/ui/lists/ItemRowActions';
import { Text } from '@/components/ui/text/Text';
import { SurfaceFreshnessLine } from '@/components/ui/surfaces/SurfaceFreshnessLine';
import { Typography } from '@/constants/Typography';
import { Modal } from '@/modal';
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

import { AttachExistingMenu, resolveSessionInstructionsAccess } from '../instructions/SessionInstructionsSection';
import { useSessionContextLayers, type SessionContextRow } from './useSessionContextLayers';

/** Session-layer entries that already have their own Work section. */
const OWN_SECTION_ENTRY_IDS = new Set(['session.instructions', 'session.memory']);
const OVERFLOW_ONLY_WIDTH_PX = 1;

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
    const [adding, setAdding] = React.useState(false);
    const addAnchorRef = React.useRef<View>(null);
    const target = React.useMemo<MemorySessionTarget>(
        () => ({ sessionId: session.id, serverId, expectedMetadataRevision: session.metadataVersion }),
        [serverId, session.id, session.metadataVersion],
    );

    const update = React.useCallback((intent: SessionContextIntentV1) => {
        setSaving(true);
        fireAndForget((async () => {
            let result: ActionExecuteResult | null = null;
            try {
                result = await memoryDocumentActions.updateSessionContext(target, intent);
            } catch { /* reported below */ }
            setSaving(false);
            if (!result || readMemoryActionOutcome(result) !== 'applied') {
                Modal.alert(t('memoryContext.session.contextTitle'), t('memoryContext.session.refused'));
            }
        })(), { tag: 'SessionContextSection.update' });
    }, [target]);

    const open = React.useCallback((row: SessionContextRow) => {
        const ref = row.entry.ref;
        router.push((row.kind === 'memory'
            ? memoryDocumentHref({ artifactId: ref.artifactId, serverId: ref.serverId ?? serverId })
            : promptCollectionItemHref(row.kind === 'skill' ? 'bundle' : 'doc', ref.artifactId, { serverId: ref.serverId ?? serverId })) as never);
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
    const onCount = visible.reduce((sum, group) => sum + group.rows.filter((row) => row.on).length, 0);

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
                        <AttachExistingMenu
                            testID="session-work-context.addMenu"
                            anchorRef={addAnchorRef}
                            serverId={serverId}
                            searchPlaceholder={t('memoryContext.session.addDocument')}
                            onClose={() => setAdding(false)}
                            onAttach={(ref) => {
                                setAdding(false);
                                update({ kind: 'attach', entry: { id: `session.${randomUUID()}`, ref, enabled: true, placement: 'system_append' } });
                            }}
                            onAttachSkill={(artifactId) => {
                                setAdding(false);
                                update({ kind: 'attach', entry: { id: `session.${randomUUID()}`, ref: { kind: 'bundle', artifactId, serverId }, enabled: true, placement: 'system_append' } });
                            }}
                        />
                    ) : null}
                </View>
            ) : null}
        >
            {layers.project.status === 'unavailable' ? (
                <SurfaceFreshnessLine testID="session-work-context.projectUnavailable" tone="warning" reason={t('memoryContext.session.projectUnavailable')} />
            ) : null}
            {visible.length > 0 ? (
                <Text style={styles.description}>{t('memoryContext.session.contextDescription')}</Text>
            ) : null}
            {visible.length === 0 ? (
                <Item
                    testID="session-work-context.empty"
                    mode="info"
                    showChevron={false}
                    showDivider={false}
                    title={t('memoryContext.session.contextEmpty')}
                    titleLines={3}
                    titleStyle={styles.empty}
                />
            ) : visible.map((group) => (
                <HappierPageSheetGroup
                    key={group.id}
                    header={(
                        <CollectionListGroupLabel
                            testID={`session-work-context.group.${group.id}`}
                            title={group.label}
                            count={group.rows.length > 1 ? group.rows.length : undefined}
                            mark={<Icon name={group.icon} size={16} color={theme.colors.text.secondary} />}
                        />
                    )}
                >
                    {group.rows.map((row) => {
                        const title = row.title ?? (row.kind === 'memory' ? t('memoryContext.memory.title') : t('promptLibrary.untitledPrompt'));
                        const label = row.kind === 'memory'
                            ? (row.layer === 'account' ? t('memoryContext.session.yourMemory')
                                : row.layer === 'project' ? t('memoryContext.session.projectMemory') : title)
                            : title;
                        const subtitle = row.off === 'session' ? t('memoryContext.session.offForSession')
                            : row.off === 'source' ? t('memoryContext.session.offAtSource')
                                : row.off === 'memory' ? t('memoryContext.session.memoryOff')
                                    : row.kind === 'memory' ? t('memoryContext.memory.title')
                                        : row.kind === 'skill' ? t('memoryContext.session.skill') : t('memoryContext.session.document');
                        const inherited = row.layer !== 'session';
                        return (
                            <Item
                                key={`${row.layer}:${row.entry.id}`}
                                testID={`session-work-context.entry.${row.layer}.${row.entry.id}`}
                                title={label}
                                titleStyle={row.on ? undefined : styles.off}
                                subtitle={subtitle}
                                showChevron={false}
                                showDivider={false}
                                onPress={() => open(row)}
                                rightElementOutsidePressable
                                rightElement={(
                                    <View style={styles.controls}>
                                        {inherited ? null : (
                                            <ItemRowActions
                                                title={label}
                                                layoutWidthPx={OVERFLOW_ONLY_WIDTH_PX}
                                                overflowTriggerTestID={`session-work-context.entry.${row.entry.id}.more`}
                                                actions={[
                                                    { id: 'open', title: t('memoryContext.session.open'), icon: 'arrow-square-out', onPress: () => open(row) },
                                                    {
                                                        id: 'remove', title: t('memoryContext.session.remove'), icon: 'trash', destructive: true, disabled: saving,
                                                        onPress: () => update({ kind: 'detach', entryId: row.entry.id }),
                                                    },
                                                ]}
                                            />
                                        )}
                                        <Switch
                                            testID={`session-work-context.entry.${row.entry.id}.switch`}
                                            value={row.on}
                                            disabled={saving || row.off === 'source' || row.off === 'memory'}
                                            accessibilityLabel={label}
                                            onValueChange={(enabled) => update(inherited
                                                ? { kind: 'inherited_enable', entryId: row.entry.id, enabled }
                                                : { kind: 'set_enabled', entryId: row.entry.id, enabled })}
                                        />
                                    </View>
                                )}
                            />
                        );
                    })}
                </HappierPageSheetGroup>
            ))}
        </WorkSection>
    );
});

const stylesheet = StyleSheet.create((theme) => ({
    controls: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
    },
    description: {
        ...Typography.default(),
        ...happierPageTextMetrics('sectionDescription'),
        color: theme.colors.text.secondary,
        paddingHorizontal: HAPPIER_WORK_PANE_METRICS.rowInsetPx,
        paddingBottom: 6,
    },
    off: {
        color: theme.colors.text.tertiary,
    },
    empty: {
        ...Typography.default(),
        color: theme.colors.text.secondary,
    },
}));
