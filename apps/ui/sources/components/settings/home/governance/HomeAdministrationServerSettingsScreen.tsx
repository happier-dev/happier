import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type {
    HomeSettingEntryV1,
    HomeSettingSecretWriteV1,
    HomeSettingsProjectionV1,
} from '@happier-dev/protocol/home/governance';

import type { SettingRef } from '@/components/settings/catalog/settingDeclarations';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { SettingAnchor } from '@/components/settings/shell/SettingRow';
import {
    HomeRestartNowBanner,
    useHomeServerRelease,
} from '@/components/settings/home/runtime/HomeRuntimeSections';
import { useHomeRuntimeExecutor } from '@/components/settings/home/runtime/homeRuntimeExecutor';
import { CompactSearchField } from '@/components/ui/forms/CompactSearchField';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { AttentionBanner } from '@/components/ui/lists/AttentionBanner';
import { ExpandableItem, ExpandableItemCaret } from '@/components/ui/lists/ExpandableItem';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SectionContentRow } from '@/components/ui/lists/SectionContentRow';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { SelectionListFilterChip } from '@/components/ui/selectionList/SelectionListFilterChips';
import type { SelectionListFilter } from '@/components/ui/selectionList/_types';
import { useHomeSettings } from '@/hooks/home/useHomeSettings';
import { t } from '@/text';

import { homeSignInPlatformForKeys, homeSignInPlatformHref } from '../signInProviders/homeSignInPlatforms';
import { HomeAdministrationSection } from './HomeAdministrationSection';
import type { HomeAdministrationContext } from './homeAdministrationContext';
import { homeGovernanceFailureNotice } from './homeGovernanceLabels';
import { HomeSecretSettingRow, KEEP_HOME_SECRET, type HomeSecretDraft } from './HomeSecretSettingRow';
import { buildHomeSettingWrite, type HomeSettingDraftValue } from './homeSettingDraft';
import { HomeSettingFieldRow, homeSettingDisplayValue, type HomeSettingStage } from './HomeSettingFieldRow';
import { HOME_SERVER_SETTINGS } from './homeServerSettings';
import {
    homeServerSettingGroupTitle,
    homeSettingIgnoredReasonLabel,
} from './homeServerSettingLabels';
import { HomeSettingRowPills, homePendingRestartSummary, homeSettingRunningState, homeSettingValueWords } from './HomeSettingRowState';
import {
    homeSettingBoundsLine,
    homeSettingFieldError,
    homeSettingTextRefusal,
    useHomeSettingsWrite,
} from './useHomeSettingsWrite';
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

/**
 * The row's facts on one line: its bounds, the key as a chip and the default. A deployment-fixed
 * key is said by the shared fixed note instead.
 */
function rowFacts(entry: HomeSettingEntryV1): HomeSettingFactSegment[] {
    const segments: HomeSettingFactSegment[] = [];
    const bounds = homeSettingBoundsLine(entry);
    if (bounds) segments.push(bounds);
    segments.push({ envKey: entry.key });
    if (entry.secretSet !== undefined) {
        segments.push(t('homeSettings.row.storedEncrypted'));
    } else if (entry.source === 'default') {
        const fallback = homeSettingValueWords(entry, entry.declaration?.default);
        if (fallback) segments.push(t('homeSettings.row.defaultValue', { value: fallback }));
    }
    return segments;
}

function RowFacts(props: Readonly<{ entry: HomeSettingEntryV1; testID: string }>) {
    const { entry } = props;
    if (entry.fixed) return <HomeDeploymentFixedNote keys={[entry.key]} testID={props.testID} />;
    return <HomeSettingFactsLine segments={rowFacts(entry)} testID={`${props.testID}.facts`} />;
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
    const pills = <HomeSettingRowPills entry={entry} testID={testID} />;
    const onSecretChange = React.useCallback((draft: HomeSecretDraft) => handlers.onSecretChange(entry.key, draft), [entry.key, handlers]);
    const onSecretCommit = React.useCallback(() => handlers.onSecretCommit(entry.key), [entry.key, handlers]);
    const row = entry.secretSet !== undefined ? (
        <HomeSecretSettingRow
            testID={testID}
            entry={entry}
            title={title}
            subtitle={homeSettingRunningState(entry)}
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
            subtitle={homeSettingRunningState(entry)}
            subtitleAccessory={<RowFacts entry={entry} testID={testID} />}
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
                    rightElement={<ExpandableItemCaret expanded={state.expanded} />}
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
    const router = useRouter();
    const home = useHomeSettings(context.scope, canView);
    const release = useHomeServerRelease(context.scope.serverId, canView);
    const executor = useHomeRuntimeExecutor(context.scope.serverId, release.flavor);
    const [query, setQuery] = React.useState('');
    const [changedOnly, setChangedOnly] = React.useState(false);
    const [drafts, setDrafts] = React.useState<Readonly<Record<string, HomeSettingDraftValue>>>({});
    const [secretDrafts, setSecretDrafts] = React.useState<Readonly<Record<string, HomeSecretDraft>>>({});
    const [errors, setErrors] = React.useState<Readonly<Record<string, string>>>(NO_ERRORS);
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
    const setError = React.useCallback((key: string, message: string | null) => {
        setErrors((current) => (message === null ? omitKey(current, key) : { ...current, [key]: message }));
    }, []);

    const { writing, write } = useHomeSettingsWrite({ context, home, onFieldError: setError });
    const disabled = !context.mutationsAvailable || writing;

    /** Writes one key's staged edit (a control's value at once, a field's text when it is left). */
    const commitKey = React.useCallback(async (key: string, staged: HomeSettingDraftValue) => {
        const current = settingsRef.current;
        const entry = current?.entries.find((candidate) => candidate.key === key);
        if (!current || !entry) return;
        if (staged.kind === 'text') {
            const refusal = homeSettingTextRefusal(entry, staged.text);
            if (refusal) {
                setError(key, homeSettingFieldError(entry, refusal));
                return;
            }
        }
        const built = buildHomeSettingWrite(current.entries, { [key]: staged });
        if (!built.ok) {
            setError(key, homeSettingFieldError(entry, 'invalid'));
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
            setSecretDrafts((current) => (draft.mode === 'keep' ? omitKey(current, key) : { ...current, [key]: draft }));
        },
        onSecretCommit: (key) => {
            const draft = secretDraftsRef.current[key];
            if (!draft || draft.mode === 'keep' || (draft.mode === 'replace' && !draft.text)) return;
            const secret: HomeSettingSecretWriteV1 = draft.mode === 'clear' ? { clear: true } : { replace: draft.text };
            void write({ key, values: {}, secrets: { [key]: secret } }).then((ok) => {
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

    // A sign-in platform key lives on Sign-in providers (AM-12); everything else is found here.
    const fixIgnored = (key: string) => {
        const platform = homeSignInPlatformForKeys([key]);
        if (platform) router.push(homeSignInPlatformHref(context.scope.serverId, platform) as never);
        else setQuery(key);
    };
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
                <SurfaceStateCard
                    testID="home-server-settings-error"
                    kind="error"
                    title={t('homeSettings.page.loadFailed')}
                    reason={homeGovernanceFailureNotice(home.failure, { effect: 'read' }).body}
                    action={{ testID: 'home-server-settings-retry', label: t('homeGovernance.retry'), onPress: reload }}
                />
            );
        }
        return (
            <ItemGroup>
                <Item testID="home-server-settings-loading" title={t('homeGovernance.loading')} loading mode="info" showChevron={false} />
            </ItemGroup>
        );
    }

    const pendingSummary = homePendingRestartSummary(layout.pending);
    const firstIgnored = layout.ignored[0];
    const searching = query.trim().length > 0 || changedOnly;
    const empty = shown.primary.length === 0 && shown.more.length === 0 && shown.readOnly.length === 0;
    const rowsProps = { drafts, secretDrafts, errors, readOnly, disabled, handlers } as const;
    // The one filter chip (funnel, value, popover), as in every other filtered list.
    const changedFilter: SelectionListFilter = {
        id: 'changed',
        testID: 'home-server-settings-changed',
        label: t('homeSettings.page.filterLabel'),
        icon: <Icon name="funnel-simple" size={ICON_SIZE.xs} color={theme.colors.text.secondary} />,
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
                    action={{ label: t('homeSettings.banner.fix'), onPress: () => fixIgnored(firstIgnored.key) }}
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
