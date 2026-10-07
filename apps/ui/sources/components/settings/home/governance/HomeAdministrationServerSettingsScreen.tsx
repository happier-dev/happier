import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { validateServerConfigText } from '@happier-dev/protocol/serverConfig/serverConfigCodec';
import type { ServerConfigEntryInput } from '@happier-dev/protocol/serverConfig/serverConfigEntry';
import type {
    HomeSettingEntryV1,
    HomeSettingSecretWriteV1,
    HomeSettingsProjectionV1,
} from '@happier-dev/protocol/home/governance';

import type { SettingRef } from '@/components/settings/catalog/settingDeclarations';
import { SettingAnchor } from '@/components/settings/shell/SettingRow';
import {
    HomeRestartNowBanner,
    useHomeServerRelease,
} from '@/components/settings/home/runtime/HomeRuntimeSections';
import { useHomeRuntimeExecutor } from '@/components/settings/home/runtime/homeRuntimeExecutor';
import { CompactSearchField } from '@/components/ui/forms/CompactSearchField';
import { Icon } from '@/components/ui/icons/Icon';
import { AttentionBanner } from '@/components/ui/lists/AttentionBanner';
import { ExpandableItem } from '@/components/ui/lists/ExpandableItem';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SectionContentRow } from '@/components/ui/lists/SectionContentRow';
import { StatusPill } from '@/components/ui/status/StatusPill';
import { SelectionListFilterChip } from '@/components/ui/selectionList/SelectionListFilterChips';
import type { SelectionListFilter } from '@/components/ui/selectionList/_types';
import { useHomeSettings } from '@/hooks/home/useHomeSettings';
import { Modal } from '@/modal';
import { readHomeSettingsInvalidFailure, setHomeSettings } from '@/sync/ops/home/homeGovernanceOperations';
import { t } from '@/text';

import { HomeAdministrationSection } from './HomeAdministrationSection';
import type { HomeAdministrationContext } from './homeAdministrationContext';
import { homeGovernanceFailureNotice } from './homeGovernanceLabels';
import { HomeSecretSettingRow, KEEP_HOME_SECRET, type HomeSecretDraft } from './HomeSecretSettingRow';
import { homeSettingRegistryEntry } from './homeSettingDeclaration';
import { buildHomeSettingWrite, type HomeSettingDraftValue } from './homeSettingDraft';
import { HomeSettingFieldRow, homeSettingDisplayValue, type HomeSettingStage } from './HomeSettingFieldRow';
import { HOME_SERVER_SETTINGS } from './homeServerSettings';
import {
    homeServerSettingGroupTitle,
    homeServerSettingUnit,
    homeSettingChoiceLabel,
    homeSettingIgnoredReasonLabel,
    homeSettingKnownChoiceLabel,
} from './homeServerSettingLabels';
import { HomeDeploymentFixedNote } from './HomeDeploymentFixedNote';
import { HomeSettingFactsLine, type HomeSettingFactSegment } from './HomeSettingKeyChip';
import {
    filterHomeServerSettings,
    homeSettingTitle,
    selectHomeServerSettings,
    type HomeServerSettingsGroup,
} from './homeServerSettingsRows';

const ROW_TESTID = 'home-server-setting';
const NO_ERRORS: Readonly<Record<string, string>> = Object.freeze({});

function declaredSetting(key: string): SettingRef | undefined {
    return (HOME_SERVER_SETTINGS.settings as Readonly<Record<string, SettingRef | undefined>>)[key];
}

/** A setting's registry bounds as words: "0–65535", "1 or more", "Up to 10". */
function boundsLine(entry: HomeSettingEntryV1): string | null {
    const bounds = entry.declaration?.bounds;
    if (!bounds) return null;
    const { min, max } = bounds;
    if (min !== undefined && max !== undefined) return t('homeGovernance.features.rangeBetween', { min, max });
    if (min !== undefined) return t('homeGovernance.features.rangeAtLeast', { min });
    if (max !== undefined) return t('homeGovernance.features.rangeAtMost', { max });
    return null;
}

/** A value as the page says it: a known choice by its label, a list joined, with its unit. */
function valueWords(entry: HomeSettingEntryV1, value: unknown): string | null {
    if (value === null || value === undefined || value === '') return null;
    if (Array.isArray(value)) return value.join(', ');
    if (typeof value === 'boolean') return value ? t('homeSettings.choices.enabled') : t('homeSettings.choices.disabled');
    // Only an enum's values and the few shared words ("default") are labels; anything else is data.
    if (typeof value === 'string') {
        return entry.declaration?.type === 'enum' ? homeSettingChoiceLabel(value) : (homeSettingKnownChoiceLabel(value) ?? value);
    }
    const unit = homeServerSettingUnit(entry.key, entry.declaration?.type);
    return unit ? `${String(value)} ${unit}` : String(value);
}

/**
 * The row's facts on one line: its bounds, the key as a chip and the default. A deployment-fixed
 * key is said by the shared fixed note instead.
 */
function rowFacts(entry: HomeSettingEntryV1): HomeSettingFactSegment[] {
    const segments: HomeSettingFactSegment[] = [];
    const bounds = boundsLine(entry);
    if (bounds) segments.push(bounds);
    segments.push({ envKey: entry.key });
    if (entry.secretSet !== undefined) {
        segments.push(t('homeSettings.row.storedEncrypted'));
    } else if (entry.source === 'default') {
        const fallback = valueWords(entry, entry.declaration?.default);
        if (fallback) segments.push(t('homeSettings.row.defaultValue', { value: fallback }));
    }
    return segments;
}

/** What the running server does with a restart key, when it differs from the stored value. */
function rowState(entry: HomeSettingEntryV1): string | undefined {
    const applied = entry.applied;
    if (applied?.ignoredReason) {
        const running = valueWords(entry, applied.value);
        const ignored = t('homeSettings.row.ignored', { reason: homeSettingIgnoredReasonLabel(applied.ignoredReason) });
        return running ? `${ignored} · ${t('homeSettings.row.runningOn', { value: running })}` : ignored;
    }
    if (applied?.pending) {
        const running = valueWords(entry, applied.value);
        return running ? t('homeSettings.row.runningWith', { value: running }) : t('homeSettings.row.runningWithout');
    }
    return undefined;
}

function RowFacts(props: Readonly<{ entry: HomeSettingEntryV1; testID: string }>) {
    const { entry } = props;
    if (entry.fixed) return <HomeDeploymentFixedNote keys={[entry.key]} testID={props.testID} />;
    return <HomeSettingFactsLine segments={rowFacts(entry)} testID={`${props.testID}.facts`} />;
}

const RowPills = React.memo(function RowPills(props: Readonly<{ entry: HomeSettingEntryV1; testID: string }>) {
    const { entry } = props;
    const restart = entry.apply === 'restart' && !entry.fixed;
    const pending = entry.applied?.pending === true;
    if (!restart && !pending) return null;
    return (
        <View style={styles.pills}>
            {restart ? <StatusPill variant="neutral" hideDot label={t('homeSettings.row.appliesAfterRestart')} /> : null}
            {pending ? <StatusPill testID={`${props.testID}.pending`} variant="warning" label={t('homeSettings.row.pending')} /> : null}
        </View>
    );
});

/** Why a typed value was refused, in the field: its bounds when it has them. */
function fieldError(entry: HomeSettingEntryV1, reason: 'out_of_bounds' | 'invalid'): string {
    const bounds = boundsLine(entry);
    return reason === 'out_of_bounds' && bounds ? t('homeSettings.row.outOfBounds', { bounds }) : t('homeSettings.row.invalid');
}

/** The typed text's own refusal reason from the registry codec, or `null` when it parses. */
function textRefusal(entry: HomeSettingEntryV1, text: string): 'out_of_bounds' | 'invalid' | null {
    const registryEntry: ServerConfigEntryInput | null = homeSettingRegistryEntry(entry);
    if (!registryEntry || !text.trim()) return null;
    const parsed = validateServerConfigText(registryEntry, text.trim());
    if (parsed.ok) return null;
    return parsed.reason === 'out_of_bounds' ? 'out_of_bounds' : 'invalid';
}

type RowHandlers = Readonly<{
    onStage: HomeSettingStage;
    onCommit: (key: string) => void;
    onSecretChange: (key: string, draft: HomeSecretDraft) => void;
    onSecretCommit: (key: string) => void;
}>;

/** One editable setting: the shared registry field row, or the shared write-only row for a secret. */
const ServerSettingRow = React.memo(function ServerSettingRow(props: Readonly<{
    entry: HomeSettingEntryV1;
    staged: HomeSettingDraftValue | undefined;
    secretDraft: HomeSecretDraft | undefined;
    error: string | undefined;
    readOnly: boolean;
    disabled: boolean;
    handlers: RowHandlers;
    showDivider?: boolean;
}>) {
    const { entry, handlers } = props;
    const testID = `${ROW_TESTID}:${entry.key}`;
    const title = homeSettingTitle(entry);
    const pills = <RowPills entry={entry} testID={testID} />;
    const onSecretChange = React.useCallback((draft: HomeSecretDraft) => handlers.onSecretChange(entry.key, draft), [entry.key, handlers]);
    const onSecretCommit = React.useCallback(() => handlers.onSecretCommit(entry.key), [entry.key, handlers]);
    const row = entry.secretSet !== undefined ? (
        <HomeSecretSettingRow
            testID={testID}
            entry={entry}
            title={title}
            subtitle={rowState(entry)}
            subtitleAccessory={<RowFacts entry={entry} testID={testID} />}
            setWhenEmpty
            titleAccessory={pills}
            draft={props.secretDraft ?? KEEP_HOME_SECRET}
            readOnly={props.readOnly}
            disabled={props.disabled}
            error={props.error ?? null}
            onChange={onSecretChange}
            onCommit={onSecretCommit}
            showDivider={props.showDivider}
        />
    ) : (
        <HomeSettingFieldRow
            testID={testID}
            entry={entry}
            title={title}
            subtitle={rowState(entry)}
            subtitleAccessory={<RowFacts entry={entry} testID={testID} />}
            unit={homeServerSettingUnit(entry.key, entry.declaration?.type) ?? undefined}
            titleAccessory={pills}
            staged={props.staged}
            readOnly={props.readOnly}
            disabled={props.disabled}
            error={props.error ?? null}
            onStage={handlers.onStage}
            onCommit={handlers.onCommit}
            showDivider={props.showDivider}
        />
    );
    const setting = declaredSetting(entry.key);
    return setting ? <SettingAnchor setting={setting} showDivider={props.showDivider}>{row}</SettingAnchor> : row;
});

/** A read-only (bootstrap) key: its value or presence, the key and why only the deployment sets it. */
const ReadOnlySettingRow = React.memo(function ReadOnlySettingRow(props: Readonly<{ entry: HomeSettingEntryV1; showDivider?: boolean }>) {
    const { entry } = props;
    const reasonCode = entry.declaration?.readOnlyReason;
    const reason = reasonCode ? t(`homeSettings.readOnly.${reasonCode}`) : t('homeSettings.readOnly.other');
    const secret = entry.secretSet !== undefined;
    const detail = secret
        ? (entry.secretSet ? t('homeSettings.readOnly.set') : t('homeSettings.row.notSet'))
        : (homeSettingDisplayValue(entry) ?? t('homeSettings.row.notSet'));
    const row = (
        <Item
            testID={`${ROW_TESTID}:${entry.key}`}
            title={homeSettingTitle(entry)}
            subtitleAccessory={<HomeSettingFactsLine segments={[{ envKey: entry.key }, reason]} testID={`${ROW_TESTID}:${entry.key}.facts`} />}
            detail={detail}
            mode="info"
            showChevron={false}
            showDivider={props.showDivider}
        />
    );
    const setting = declaredSetting(entry.key);
    return setting ? <SettingAnchor setting={setting} showDivider={props.showDivider}>{row}</SettingAnchor> : row;
});

type GroupRowsProps = Readonly<{
    group: HomeServerSettingsGroup;
    drafts: Readonly<Record<string, HomeSettingDraftValue>>;
    secretDrafts: Readonly<Record<string, HomeSecretDraft>>;
    errors: Readonly<Record<string, string>>;
    readOnly: boolean;
    disabled: boolean;
    handlers: RowHandlers;
}>;

function GroupRows(props: GroupRowsProps) {
    const { group } = props;
    return (
        <>
            {group.entries.map((entry, index) => (
                <ServerSettingRow
                    key={entry.key}
                    entry={entry}
                    staged={props.drafts[entry.key]}
                    secretDraft={props.secretDrafts[entry.key]}
                    error={props.errors[entry.key]}
                    readOnly={props.readOnly}
                    disabled={props.disabled}
                    handlers={props.handlers}
                    showDivider={index < group.entries.length - 1}
                />
            ))}
        </>
    );
}

/** One closed group under "More": opened by the owner, a search, or a reveal request. */
const MoreGroupDisclosure = React.memo(function MoreGroupDisclosure(props: GroupRowsProps & Readonly<{
    forceOpen: boolean;
    showDivider?: boolean;
}>) {
    const { theme } = useUnistyles();
    const { group } = props;
    const declared = React.useMemo(
        () => group.entries.flatMap((entry) => declaredSetting(entry.key) ?? []),
        [group.entries],
    );
    const [expanded, setExpanded] = React.useState(false);
    const open = expanded || props.forceOpen;
    const count = group.entries.length;
    const changed = group.entries.filter((entry) => entry.source === 'home').length;
    return (
        <SettingAnchor settings={declared}><ExpandableItem
            testID={`home-server-settings-more:${group.id}`}
            expanded={open}
            onExpandedChange={setExpanded}
            showDivider={props.showDivider}
            header={(state) => (
                <Item
                    testID={`home-server-settings-more:${group.id}.header`}
                    {...state.headerProps}
                    title={homeServerSettingGroupTitle(group.id)}
                    subtitle={changed > 0 ? t('homeSettings.groupSummaryChanged', { count, changed }) : t('homeSettings.groupSummary', { count })}
                    rightElement={<Icon name={state.expanded ? 'caret-down' : 'caret-right'} size={16} color={theme.colors.text.secondary} />}
                    showChevron={false}
                />
            )}
        >
            {open ? <GroupRows {...props} /> : null}
        </ExpandableItem></SettingAnchor>
    );
});

function omitKey<V>(record: Readonly<Record<string, V>>, key: string): Readonly<Record<string, V>> {
    if (!(key in record)) return record;
    const next: Record<string, V> = { ...record };
    delete next[key];
    return next;
}

const ServerSettingsPage = React.memo(function ServerSettingsPage(props: Readonly<{ context: HomeAdministrationContext }>) {
    const { context } = props;
    const { capabilities } = context.projection;
    const canView = capabilities.viewAdministration;
    const readOnly = !capabilities.manageHomeSettings;
    const { theme } = useUnistyles();
    const home = useHomeSettings(context.scope, canView);
    const release = useHomeServerRelease(context.scope.serverId, canView);
    const executor = useHomeRuntimeExecutor(context.scope.serverId, release.flavor);
    const [query, setQuery] = React.useState('');
    const [changedOnly, setChangedOnly] = React.useState(false);
    const [drafts, setDrafts] = React.useState<Readonly<Record<string, HomeSettingDraftValue>>>({});
    const [secretDrafts, setSecretDrafts] = React.useState<Readonly<Record<string, HomeSecretDraft>>>({});
    const [errors, setErrors] = React.useState<Readonly<Record<string, string>>>(NO_ERRORS);
    const [writing, setWriting] = React.useState(false);
    const [discarding, setDiscarding] = React.useState(false);

    const settings: HomeSettingsProjectionV1 | null = home.settings;
    const settingsRef = React.useRef(settings);
    settingsRef.current = settings;
    const draftsRef = React.useRef(drafts);
    draftsRef.current = drafts;
    const secretDraftsRef = React.useRef(secretDrafts);
    secretDraftsRef.current = secretDrafts;

    const layout = React.useMemo(() => (settings ? selectHomeServerSettings(settings) : null), [settings]);
    const shown = React.useMemo(
        () => (layout ? filterHomeServerSettings(layout, { query, changedOnly }) : null),
        [layout, query, changedOnly],
    );
    const disabled = !context.mutationsAvailable || writing;

    const setError = React.useCallback((key: string, message: string | null) => {
        setErrors((current) => (message === null ? omitKey(current, key) : { ...current, [key]: message }));
    }, []);

    /** One write against the revision the page read; the Home's answer replaces the page's projection. */
    const write = React.useCallback(async (params: Readonly<{
        key: string | null;
        values: Readonly<Record<string, unknown>>;
        secrets?: Readonly<Record<string, HomeSettingSecretWriteV1>>;
        discardPendingRestart?: true;
    }>): Promise<boolean> => {
        const current = settingsRef.current;
        if (!current) return false;
        setWriting(true);
        try {
            const outcome = await setHomeSettings({
                scope: context.scope,
                expectedRevision: current.revision,
                values: params.values,
                ...(params.secrets ? { secrets: params.secrets } : {}),
                ...(params.discardPendingRestart ? { discardPendingRestart: true as const } : {}),
            });
            if (outcome.kind === 'succeeded') {
                home.adoptSettings(outcome.value);
                if (params.key) setError(params.key, null);
                return true;
            }
            if (outcome.kind === 'approval_pending') {
                context.requestApproval?.(outcome.artifactId);
                return false;
            }
            if (outcome.failure.code === 'home_settings_revision_conflict') {
                await Modal.alertAsync(t('homeSettings.page.conflictTitle'), t('homeSettings.page.conflictBody'));
                home.reload();
                return false;
            }
            const invalid = readHomeSettingsInvalidFailure(outcome.failure);
            if (invalid) {
                const entry = current.entries.find((candidate) => candidate.key === invalid.key);
                setError(invalid.key, entry ? fieldError(entry, invalid.reason === 'out_of_bounds' ? 'out_of_bounds' : 'invalid') : t('homeSettings.row.invalid'));
                return false;
            }
            const notice = homeGovernanceFailureNotice(outcome.failure);
            await Modal.alertAsync(notice.title, notice.body);
            return false;
        } finally {
            setWriting(false);
        }
    }, [context, home, setError]);

    /** Writes one key's staged edit (a control's value at once, a field's text when it is left). */
    const commitKey = React.useCallback(async (key: string, staged: HomeSettingDraftValue) => {
        const current = settingsRef.current;
        const entry = current?.entries.find((candidate) => candidate.key === key);
        if (!current || !entry) return;
        if (staged.kind === 'text') {
            const refusal = textRefusal(entry, staged.text);
            if (refusal) {
                setError(key, fieldError(entry, refusal));
                return;
            }
        }
        const built = buildHomeSettingWrite(current.entries, { [key]: staged });
        if (!built.ok) {
            setError(key, fieldError(entry, 'invalid'));
            return;
        }
        if (!built.changed) {
            setDrafts((existing) => omitKey(existing, key));
            setError(key, null);
            return;
        }
        if (await write({ key, values: built.values })) setDrafts((existing) => omitKey(existing, key));
    }, [setError, write]);

    const handlers = React.useMemo<RowHandlers>(() => ({
        onStage: (key, value) => {
            setError(key, null);
            if (value === null) {
                setDrafts((current) => omitKey(current, key));
                return;
            }
            if (value.kind === 'value') {
                void commitKey(key, value);
                return;
            }
            setDrafts((current) => ({ ...current, [key]: value }));
        },
        onCommit: (key) => {
            const staged = draftsRef.current[key];
            if (staged) void commitKey(key, staged);
        },
        onSecretChange: (key, draft) => {
            setError(key, null);
            if (draft.mode === 'clear') {
                setSecretDrafts((current) => omitKey(current, key));
                void write({ key, values: {}, secrets: { [key]: { clear: true } } });
                return;
            }
            setSecretDrafts((current) => (draft.mode === 'keep' ? omitKey(current, key) : { ...current, [key]: draft }));
        },
        onSecretCommit: (key) => {
            const draft = secretDraftsRef.current[key];
            if (draft?.mode !== 'replace' || !draft.text) return;
            void write({ key, values: {}, secrets: { [key]: { replace: draft.text } } }).then((ok) => {
                if (ok) setSecretDrafts((current) => omitKey(current, key));
            });
        },
    }), [commitKey, setError, write]);

    const discard = React.useCallback(async () => {
        setDiscarding(true);
        try {
            await write({ key: null, values: {}, discardPendingRestart: true });
        } finally {
            setDiscarding(false);
        }
    }, [write]);

    const { reload } = home;
    if (!canView) {
        return (
            <ItemGroup description={t('homeGovernance.forbiddenBody')}>
                <Item testID="home-server-settings-forbidden" title={t('homeGovernance.forbiddenTitle')} mode="info" showChevron={false} />
            </ItemGroup>
        );
    }
    if (!layout || !shown) {
        if (home.failure) {
            return (
                <ItemGroup description={t('homeSettings.page.loadFailed')}>
                    <Item testID="home-server-settings-retry" title={t('homeGovernance.retry')} onPress={reload} showChevron={false} />
                </ItemGroup>
            );
        }
        return (
            <ItemGroup>
                <Item testID="home-server-settings-loading" title={t('homeGovernance.loading')} loading mode="info" showChevron={false} />
            </ItemGroup>
        );
    }

    const pendingNames = layout.pending.slice(0, 3).map(homeSettingTitle);
    const extra = layout.pending.length - pendingNames.length;
    const pendingSummary = t('homeSettings.banner.pendingNames', {
        names: extra > 0 ? [...pendingNames, t('homeSettings.banner.andMore', { count: extra })].join(', ') : pendingNames.join(', '),
    });
    const firstIgnored = layout.ignored[0];
    const searching = query.trim().length > 0 || changedOnly;
    const empty = shown.primary.length === 0 && shown.more.length === 0 && shown.readOnly.length === 0;
    const rowsProps = { drafts, secretDrafts, errors, readOnly, disabled, handlers } as const;
    // The one filter chip (funnel, value, popover), as in every other filtered list.
    const changedFilter: SelectionListFilter = {
        id: 'changed',
        testID: 'home-server-settings-changed',
        label: t('homeSettings.page.filterLabel'),
        icon: <Icon name="funnel-simple" size={14} color={theme.colors.text.secondary} />,
        valueLabel: changedOnly
            ? t('homeSettings.page.filterChanged', { count: layout.changedCount })
            : t('homeSettings.page.filterAll'),
        options: [
            { id: 'all', label: t('homeSettings.page.filterAll') },
            { id: 'changed', label: t('homeSettings.page.filterChanged', { count: layout.changedCount }) },
        ],
        selectedId: changedOnly ? 'changed' : 'all',
        onChange: (id) => setChangedOnly(id === 'changed'),
    };

    return (
        <>
            {readOnly ? (
                <AttentionBanner
                    testID="home-server-settings-admin-read-only"
                    tone="neutral"
                    title={t('homeSettings.page.adminTitle')}
                    description={t('homeSettings.page.adminBody')}
                />
            ) : null}
            {firstIgnored?.applied?.ignoredReason ? (
                <AttentionBanner
                    testID="home-server-settings-ignored"
                    title={layout.ignored.length === 1
                        ? t('homeSettings.banner.ignoredTitle')
                        : t('homeSettings.banner.ignoredTitleMany', { count: layout.ignored.length })}
                    description={t('homeSettings.banner.ignoredBody', {
                        setting: homeSettingTitle(firstIgnored),
                        reason: homeSettingIgnoredReasonLabel(firstIgnored.applied.ignoredReason),
                    })}
                    action={{ label: t('homeSettings.banner.fix'), onPress: () => setQuery(firstIgnored.key) }}
                />
            ) : null}
            <HomeRestartNowBanner
                context={context}
                executor={executor}
                pendingCount={layout.pending.length}
                pendingSummary={pendingSummary}
                discard={{ onPress: () => { void discard(); }, loading: discarding }}
                onRestarted={reload}
            />

            <ItemGroup surface="none">
                <SectionContentRow showDivider={false}>
                    <View style={styles.toolbar}>
                        <CompactSearchField
                            testID="home-server-settings-search"
                            value={query}
                            onChangeText={setQuery}
                            placeholder={t('homeSettings.page.searchPlaceholder')}
                            style={styles.search}
                        />
                        <SelectionListFilterChip filter={changedFilter} />
                    </View>
                </SectionContentRow>
            </ItemGroup>

            {empty ? (
                <ItemGroup>
                    <Item
                        testID="home-server-settings-empty"
                        title={changedOnly && !query.trim() ? t('homeSettings.page.noChanges') : t('homeSettings.page.noMatches')}
                        mode="info"
                        showChevron={false}
                    />
                </ItemGroup>
            ) : null}

            {shown.primary.map((group) => (
                <ItemGroup key={group.id} title={homeServerSettingGroupTitle(group.id)}>
                    <GroupRows group={group} {...rowsProps} />
                </ItemGroup>
            ))}

            {shown.more.length > 0 ? (
                <ItemGroup title={t('homeSettings.page.more')}>
                    {shown.more.map((group, index) => (
                        <MoreGroupDisclosure
                            key={group.id}
                            group={group}
                            forceOpen={searching}
                            showDivider={index < shown.more.length - 1}
                            {...rowsProps}
                        />
                    ))}
                </ItemGroup>
            ) : null}

            {shown.readOnly.length > 0 ? (
                <ItemGroup
                    title={t('homeSettings.page.readOnlyTitle')}
                    description={t('homeSettings.page.readOnlyDescription')}
                >
                    {shown.readOnly.map((entry, index) => (
                        <ReadOnlySettingRow key={entry.key} entry={entry} showDivider={index < shown.readOnly.length - 1} />
                    ))}
                </ItemGroup>
            ) : null}

            <ItemGroup surface="none" description={t('homeSettings.page.note')}>{null}</ItemGroup>
        </>
    );
});

/**
 * Server settings (plan §3.10, §3.14 r3; lab `hcServer-*`): every registry key no other console
 * page edits, rendered from its declaration. Live keys apply when a control changes or a field is
 * left; restart keys are stored and marked "Applies after restart", pending until the server
 * restarts (Restart now where this device can, U8's executor rule) or Discard returns them to the
 * running values. Read-only keys close the page with the reason only the deployment sets them.
 */
export const HomeAdministrationServerSettingsScreen = React.memo(function HomeAdministrationServerSettingsScreen(
    props: Readonly<{ serverId: string }>,
) {
    return (
        <HomeAdministrationSection
            serverId={props.serverId}
            title={t('homeSettings.page.title')}
            description={t('homeSettings.page.description')}
        >
            {(context) => <ServerSettingsPage context={context} />}
        </HomeAdministrationSection>
    );
});

const styles = StyleSheet.create(() => ({
    pills: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        flexShrink: 1,
    },
    toolbar: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
    },
    search: {
        flexGrow: 1,
        flexShrink: 1,
    },
}));
