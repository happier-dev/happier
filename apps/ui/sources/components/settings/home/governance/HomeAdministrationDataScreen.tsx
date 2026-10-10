import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type {
    HomeRetentionDryRunDomainResultV1,
    HomeRetentionDryRunResultV1,
    HomeSettingEntryV1,
    HomeSettingsProjectionV1,
} from '@happier-dev/protocol/home/governance';

import type { SettingRef } from '@/components/settings/catalog/settingDeclarations';
import { SettingAnchor } from '@/components/settings/shell/SettingRow';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { Switch } from '@/components/ui/forms/Switch';
import { AttentionBanner } from '@/components/ui/lists/AttentionBanner';
import { ExpandableItem, ExpandableItemCaret } from '@/components/ui/lists/ExpandableItem';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SegmentedTabBar } from '@/components/ui/navigation/SegmentedTabBar';
import { Text } from '@/components/ui/text/Text';
import { useHomeSettings } from '@/hooks/home/useHomeSettings';
import { Modal } from '@/modal';
import type { HomeDomainFailure } from '@/sync/api/home/homeServerActionTransport';
import {
    readHomeSettingsInvalidFailure,
    runHomeRetentionDryRun,
    setHomeSettings,
} from '@/sync/ops/home/homeGovernanceOperations';
import { t } from '@/text';
import { formatWithCachedDateTimeFormatter } from '@/utils/datetime/cachedIntlFormatters';

import { HomeBackupsSection } from '../runtime/HomeRuntimeSections';
import { HomeAdministrationSection } from './HomeAdministrationSection';
import type { HomeAdministrationContext } from './homeAdministrationContext';
import { HOME_DATA_SETTINGS } from './homeDataSettings';
import { humanizeIdentifier } from './homeFeatureLabels';
import { homeGovernanceFailureNotice } from './homeGovernanceLabels';
import {
    buildHomeRetentionWrite,
    homeRetentionDomainDays,
    homeRetentionDomainDeletes,
    isHomeRetentionDomainWritable,
    selectHomeRetentionSettings,
    type HomeRetentionChoice,
    type HomeRetentionDomain,
} from './homeRetentionSettings';
import { HomeDeploymentFixedNote } from './HomeDeploymentFixedNote';
import { isHomeSettingWritable } from './homeSettingDeclaration';

type WriteValues = (values: Readonly<Record<string, unknown>>) => Promise<boolean>;

type DryRunState =
    | Readonly<{ kind: 'idle' }>
    | Readonly<{ kind: 'running'; last: HomeRetentionDryRunResultV1 | null }>
    | Readonly<{ kind: 'answered'; result: HomeRetentionDryRunResultV1 }>
    | Readonly<{ kind: 'busy'; last: HomeRetentionDryRunResultV1 | null }>
    | Readonly<{ kind: 'refused'; failure: HomeDomainFailure; last: HomeRetentionDryRunResultV1 | null }>;

type DomainError = 'daysRequired' | 'daysInvalid';

const IDLE: DryRunState = Object.freeze({ kind: 'idle' as const });

function lastDryRun(state: DryRunState): HomeRetentionDryRunResultV1 | null {
    if (state.kind === 'answered') return state.result;
    if (state.kind === 'idle') return null;
    return state.last;
}

function domainSetting(id: string): SettingRef | undefined {
    return (HOME_DATA_SETTINGS.settings as Readonly<Record<string, SettingRef | undefined>>)[id];
}

function domainTitle(domain: HomeRetentionDomain): string {
    return domain.metadata ? t(domain.metadata.titleKey) : humanizeIdentifier(domain.id);
}

/** What the domain's current rule does, in words; a rule no one changed says it is the default. */
function domainEffect(domain: HomeRetentionDomain): string {
    const days = homeRetentionDomainDays(domain);
    const effect = !homeRetentionDomainDeletes(domain) || days === null
        ? t('server.retention.keepForever')
        : domain.deleteMode === 'delete_inactive'
            ? t('server.retention.deleteInactiveSessionsDays', { count: days })
            : t('server.retention.deleteOlderThanDays', { count: days });
    return domain.mode.source === 'default' && (domain.days === null || domain.days.source === 'default')
        ? t('homeGovernance.data.defaultEffect', { effect })
        : effect;
}

function formatCount(value: number): string {
    return value.toLocaleString();
}

function dryRunLine(result: HomeRetentionDryRunDomainResultV1 | undefined): string | null {
    if (!result) return null;
    if (result.wouldDelete === 0 && result.stopReason === 'exhausted') return t('homeGovernance.data.nothingToDelete');
    const counts = t('homeGovernance.data.wouldDelete', {
        count: formatCount(result.wouldDelete),
        examined: formatCount(result.candidatesExamined),
    });
    switch (result.stopReason) {
        case 'exhausted':
            return counts;
        case 'time_budget':
            return `${counts} · ${t('homeGovernance.data.stopTimeBudget')}`;
        case 'row_budget':
            return `${counts} · ${t('homeGovernance.data.stopRowBudget')}`;
        case 'candidate_budget':
            return `${counts} · ${t('homeGovernance.data.stopCandidateBudget')}`;
        case 'stalled':
            return `${counts} · ${t('homeGovernance.data.stopStalled')}`;
    }
}

/** A Home switch of the retention family: the global switch and the dry-run flag. */
const RetentionSwitchRow = React.memo(function RetentionSwitchRow(props: Readonly<{
    testID: string;
    setting: SettingRef;
    title: string;
    description?: string;
    entry: HomeSettingEntryV1 | null;
    readOnly: boolean;
    disabled: boolean;
    onWrite: WriteValues;
    showDivider?: boolean;
}>) {
    const { entry, onWrite } = props;
    if (!entry) return null;
    const on = entry.value === true;
    const subtitle = props.description;
    const writable = !props.readOnly && isHomeSettingWritable(entry);
    return (
        <SettingAnchor setting={props.setting} showDivider={props.showDivider}>
            <Item
                testID={props.testID}
                title={props.title}
                subtitle={subtitle}
                subtitleLines={0}
                subtitleAccessory={entry.fixed ? <HomeDeploymentFixedNote keys={[entry.key]} testID={props.testID} /> : undefined}
                showChevron={false}
                showDivider={props.showDivider}
                detail={writable ? undefined : on ? t('common.on') : t('common.off')}
                mode="info"
                rightElement={writable ? (
                    <Switch
                        testID={`${props.testID}.switch`}
                        accessibilityLabel={props.title}
                        value={on}
                        disabled={props.disabled}
                        onValueChange={(next) => { void onWrite({ [entry.key]: entry.source === 'home' && entry.declaration?.default === next ? null : next }); }}
                    />
                ) : undefined}
            />
        </SettingAnchor>
    );
});

/**
 * One retention domain: Keep | Delete after, with the days inline and the rule in words. Choosing
 * "Delete after" writes once the days are known, mode and days together.
 */
const RetentionDomainRow = React.memo(function RetentionDomainRow(props: Readonly<{
    domain: HomeRetentionDomain;
    result: HomeRetentionDryRunDomainResultV1 | undefined;
    readOnly: boolean;
    disabled: boolean;
    serverError: DomainError | null;
    onWrite: WriteValues;
    showDivider?: boolean;
}>) {
    const { domain, onWrite } = props;
    const deletes = homeRetentionDomainDeletes(domain);
    const storedDays = homeRetentionDomainDays(domain);
    const [mode, setMode] = React.useState<'keep' | 'delete' | undefined>(undefined);
    const [daysText, setDaysText] = React.useState<string | undefined>(undefined);
    const [error, setError] = React.useState<DomainError | null>(null);
    React.useEffect(() => {
        setMode(undefined);
        setDaysText(undefined);
        setError(null);
    }, [domain]);

    const title = domainTitle(domain);
    const expires = domain.metadata?.expiresAutomatically === true;
    // One domain, one lock line: the mode key when the deployment fixed it, else the days key.
    const fixedEntry = domain.mode.fixed ? domain.mode : domain.days?.fixed ? domain.days : null;
    const subtitle = [
        expires ? t('homeGovernance.data.expiresAutomatically') : domainEffect(domain),
        domain.metadata?.runsWhenDeletionOff ? t('homeGovernance.data.alwaysRuns') : null,
        dryRunLine(props.result),
    ].filter(Boolean).join('\n');
    const testID = `home-retention:${domain.id}`;
    const selected = mode ?? (deletes ? 'delete' : 'keep');
    const shownError = error ?? props.serverError;

    const submit = React.useCallback((choice: HomeRetentionChoice) => {
        const write = buildHomeRetentionWrite(domain, choice);
        if (!write.ok) {
            setError(write.error);
            return;
        }
        setError(null);
        if (!write.changed) {
            setMode(undefined);
            setDaysText(undefined);
            return;
        }
        void onWrite(write.values);
    }, [domain, onWrite]);

    const selectMode = React.useCallback((next: 'keep' | 'delete') => {
        setMode(next);
        setError(null);
        if (next === 'keep') {
            submit({ mode: 'keep' });
            return;
        }
        // With days already known the rule is complete; otherwise it waits for them.
        const text = daysText ?? (storedDays === null ? '' : String(storedDays));
        if (text.trim()) submit({ mode: 'delete', daysText: text });
    }, [daysText, storedDays, submit]);

    const commitDays = React.useCallback(() => {
        if (selected !== 'delete' || daysText === undefined) return;
        submit({ mode: 'delete', daysText });
    }, [daysText, selected, submit]);

    const writable = !props.readOnly && !expires && domain.deleteMode !== null && isHomeRetentionDomainWritable(domain);
    const item = (
        <Item
            testID={testID}
            title={title}
            subtitle={subtitle}
            subtitleLines={0}
            subtitleAccessory={fixedEntry ? <HomeDeploymentFixedNote keys={[fixedEntry.key]} testID={testID} /> : undefined}
            showChevron={false}
            showDivider={props.showDivider}
            mode="info"
            accessoryLayout="adaptive"
            rightElement={writable ? (
                <View style={styles.inlineControls}>
                    <SegmentedTabBar<'keep' | 'delete'>
                        role="radiogroup"
                        tabs={[
                            { id: 'keep', label: t('homeGovernance.data.keep') },
                            { id: 'delete', label: t('homeGovernance.data.deleteAfter') },
                        ]}
                        activeTabId={selected}
                        onSelectTab={selectMode}
                        slidingThumb
                        segmentSizing="content"
                        disabled={props.disabled}
                        accessibilityLabel={title}
                        testIDPrefix={`${testID}.mode`}
                    />
                    {selected === 'delete' ? (
                        <>
                            <FieldTextInput
                                testID={`${testID}.days`}
                                accessibilityLabel={t('homeGovernance.data.daysFor', { domain: title })}
                                value={daysText ?? (storedDays === null ? '' : String(storedDays))}
                                editable={!props.disabled}
                                keyboardType="number-pad"
                                autoFocus={mode === 'delete' && storedDays === null}
                                error={shownError ? t(`homeGovernance.data.${shownError}`) : null}
                                onChangeText={setDaysText}
                                onBlur={commitDays}
                                onSubmitEditing={commitDays}
                                style={styles.daysField}
                            />
                            <Text style={styles.unit}>{t('homeGovernance.data.days')}</Text>
                        </>
                    ) : null}
                </View>
            ) : undefined}
        />
    );
    const setting = domainSetting(domain.id);
    return setting ? <SettingAnchor setting={setting} showDivider={props.showDivider}>{item}</SettingAnchor> : item;
});

/** The Home's own records: closed until opened, searched for, or a dry run reports on them. */
const SystemRecordsDisclosure = React.memo(function SystemRecordsDisclosure(props: Readonly<{
    domains: readonly HomeRetentionDomain[];
    dryRun: HomeRetentionDryRunResultV1 | null;
    readOnly: boolean;
    disabled: boolean;
    errors: Readonly<Record<string, DomainError>>;
    onWrite: WriteValues;
    showDivider?: boolean;
}>) {
    const declared = React.useMemo(() => props.domains.flatMap((domain) => domainSetting(domain.id) ?? []), [props.domains]);
    const [expanded, setExpanded] = React.useState(false);
    React.useEffect(() => {
        if (props.dryRun) setExpanded(true);
    }, [props.dryRun]);
    const count = props.domains.length;
    return (
        <SettingAnchor settings={declared}><ExpandableItem
            testID="home-retention-system"
            expanded={expanded}
            onExpandedChange={setExpanded}
            showDivider={props.showDivider}
            header={(state) => (
                <Item
                    testID="home-retention-system.header"
                    {...state.headerProps}
                    title={t('homeGovernance.data.systemRecords')}
                    subtitle={count === 1
                        ? t('homeGovernance.data.systemRecordsSummary_one')
                        : t('homeGovernance.data.systemRecordsSummary_other', { count })}
                    rightElement={<ExpandableItemCaret expanded={state.expanded} />}
                    showChevron={false}
                />
            )}
        >
            {expanded ? props.domains.map((domain) => (
                <RetentionDomainRow
                    key={domain.id}
                    domain={domain}
                    result={props.dryRun?.byDomain[domain.id]}
                    readOnly={props.readOnly}
                    disabled={props.disabled}
                    serverError={props.errors[domain.id] ?? null}
                    onWrite={props.onWrite}
                />
            )) : null}
        </ExpandableItem></SettingAnchor>
    );
});

/** "Try the current rules": one sweep with deletion forced off; its answer is shown, never kept. */
const DryRunRow = React.memo(function DryRunRow(props: Readonly<{
    state: DryRunState;
    disabled: boolean;
    onRun: () => void;
    showDivider?: boolean;
}>) {
    const { state } = props;
    const last = lastDryRun(state);
    const subtitle = state.kind === 'busy'
        ? t('homeGovernance.data.sweepInProgress')
        : state.kind === 'refused'
            ? homeGovernanceFailureNotice(state.failure).body
            : last
                ? t('homeGovernance.data.ranAt', {
                    time: formatWithCachedDateTimeFormatter(new Date(last.ranAt), undefined, { timeStyle: 'short' }),
                })
                : t('homeGovernance.data.tryRulesDescription');
    return (
        <SettingAnchor setting={HOME_DATA_SETTINGS.settings.dryRun} showDivider={props.showDivider}>
            <Item
                testID="home-retention-dry-run"
                title={t('homeGovernance.data.tryRules')}
                subtitle={subtitle}
                subtitleLines={0}
                accessibilityLiveRegion="polite"
                showChevron={false}
                showDivider={props.showDivider}
                mode="info"
                rightElement={(
                    <RoundButton
                        testID="home-retention-dry-run.run"
                        size="small"
                        display="secondary"
                        title={last ? t('homeGovernance.data.runAgain') : t('homeGovernance.data.runDryRun')}
                        loading={state.kind === 'running'}
                        disabled={props.disabled || state.kind === 'running'}
                        onPress={props.onRun}
                    />
                )}
            />
        </SettingAnchor>
    );
});

const DataPage = React.memo(function DataPage(props: Readonly<{ context: HomeAdministrationContext }>) {
    const { context } = props;
    const { capabilities } = context.projection;
    const canView = capabilities.viewAdministration;
    const isOwner = capabilities.manageHomeSettings;
    const home = useHomeSettings(context.scope, canView);
    const [saving, setSaving] = React.useState(false);
    const [errors, setErrors] = React.useState<Readonly<Record<string, DomainError>>>({});
    const [dryRun, setDryRun] = React.useState<DryRunState>(IDLE);

    const wasPendingRef = React.useRef(context.approvalPending);
    const { reload } = home;
    React.useEffect(() => {
        if (wasPendingRef.current && !context.approvalPending) reload();
        wasPendingRef.current = context.approvalPending;
    }, [context.approvalPending, reload]);

    const settings: HomeSettingsProjectionV1 | null = home.settings;
    const retention = React.useMemo(() => (settings ? selectHomeRetentionSettings(settings) : null), [settings]);
    const disabled = !context.mutationsAvailable || saving;

    const write = React.useCallback<WriteValues>(async (values) => {
        if (!settings || !retention) return false;
        setSaving(true);
        try {
            const outcome = await setHomeSettings({ scope: context.scope, expectedRevision: settings.revision, values });
            if (outcome.kind === 'succeeded') {
                setErrors({});
                home.adoptSettings(outcome.value);
                return true;
            }
            if (outcome.kind === 'approval_pending') {
                context.requestApproval?.(outcome.artifactId);
                return false;
            }
            if (outcome.failure.code === 'home_settings_revision_conflict') {
                await Modal.alertAsync(t('homeGovernance.data.conflictTitle'), t('homeGovernance.data.conflictBody'));
                home.reload();
                return false;
            }
            const invalid = readHomeSettingsInvalidFailure(outcome.failure);
            const domain = invalid
                ? [...retention.user, ...retention.system].find((candidate) => candidate.mode.key === invalid.key || candidate.days?.key === invalid.key)
                : undefined;
            if (invalid && domain) {
                setErrors({ [domain.id]: invalid.reason === 'required' ? 'daysRequired' : 'daysInvalid' });
                return false;
            }
            const notice = homeGovernanceFailureNotice(outcome.failure);
            await Modal.alertAsync(notice.title, notice.body);
            return false;
        } finally {
            setSaving(false);
        }
    }, [context, home, retention, settings]);

    const runDryRun = React.useCallback(async () => {
        setDryRun((current) => ({ kind: 'running', last: lastDryRun(current) }));
        const outcome = await runHomeRetentionDryRun({ scope: context.scope });
        setDryRun((current) => {
            const last = lastDryRun(current);
            if (outcome.kind === 'succeeded') return { kind: 'answered', result: outcome.value };
            if (outcome.failure.code === 'retention_sweep_in_progress') return { kind: 'busy', last };
            return { kind: 'refused', failure: outcome.failure, last };
        });
    }, [context.scope]);
    const handleRunDryRun = React.useCallback(() => { void runDryRun(); }, [runDryRun]);

    if (!canView) {
        return (
            <ItemGroup description={t('homeGovernance.forbiddenBody')}>
                <Item testID="home-data-forbidden" title={t('homeGovernance.forbiddenTitle')} mode="info" showChevron={false} />
            </ItemGroup>
        );
    }
    if (!retention) {
        if (home.failure) {
            return (
                <ItemGroup description={t('homeGovernance.data.loadFailed')}>
                    <Item testID="home-data-retry" title={t('homeGovernance.retry')} onPress={home.reload} showChevron={false} />
                </ItemGroup>
            );
        }
        return (
            <ItemGroup>
                <Item testID="home-data-loading" title={t('homeGovernance.loading')} loading mode="info" showChevron={false} />
            </ItemGroup>
        );
    }

    const readOnly = !isOwner;
    const results = lastDryRun(dryRun);
    return (
        <>
            {readOnly ? (
                <AttentionBanner
                    testID="home-data-admin-read-only"
                    tone="neutral"
                    title={t('homeGovernance.data.adminTitle')}
                    description={t('homeGovernance.data.adminBody')}
                />
            ) : null}

            <ItemGroup title={t('homeGovernance.data.deletion')} description={t('homeGovernance.data.deletionDescription')}>
                <RetentionSwitchRow
                    testID="home-retention-enabled"
                    setting={HOME_DATA_SETTINGS.settings.automaticDeletion}
                    title={t('homeGovernance.data.deletion')}
                    entry={retention.enabled}
                    readOnly={readOnly}
                    disabled={disabled}
                    onWrite={write}
                />
                <RetentionSwitchRow
                    testID="home-retention-dry-run-mode"
                    setting={HOME_DATA_SETTINGS.settings.dryRunMode}
                    title={t('homeGovernance.data.dryRunMode')}
                    description={t('homeGovernance.data.dryRunModeDescription')}
                    entry={retention.dryRun}
                    readOnly={readOnly}
                    disabled={disabled}
                    onWrite={write}
                />
                {isOwner ? (
                    <DryRunRow state={dryRun} disabled={!context.mutationsAvailable} onRun={handleRunDryRun} />
                ) : null}
                {retention.user.map((domain) => (
                    <RetentionDomainRow
                        key={domain.id}
                        domain={domain}
                        result={results?.byDomain[domain.id]}
                        readOnly={readOnly}
                        disabled={disabled}
                        serverError={errors[domain.id] ?? null}
                        onWrite={write}
                    />
                ))}
                {retention.system.length > 0 ? (
                    <SystemRecordsDisclosure
                        domains={retention.system}
                        dryRun={results}
                        readOnly={readOnly}
                        disabled={disabled}
                        errors={errors}
                        onWrite={write}
                    />
                ) : null}
            </ItemGroup>

            <HomeBackupsSection context={context} />
        </>
    );
});

/**
 * What one Home keeps and for how long (plan §3.6, lab `hcData-*`): the global switch and dry-run
 * flag, a dry run of the current rules with its counts under each row, the records people make, and
 * the Home's own records in a closed "System records" disclosure. Owners change; admins read.
 * Backups (U8) are their own section, executor-selected (`HomeBackupsSection`).
 */
export const HomeAdministrationDataScreen = React.memo(function HomeAdministrationDataScreen(
    props: Readonly<{ serverId: string }>,
) {
    return (
        <HomeAdministrationSection
            serverId={props.serverId}
            title={t('homeGovernance.data.title')}
            description={t('homeGovernance.pages.data')}
        >
            {(context) => <DataPage context={context} />}
        </HomeAdministrationSection>
    );
});

const styles = StyleSheet.create((theme) => ({
    inlineControls: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        flexShrink: 1,
    },
    daysField: {
        width: 72,
    },
    unit: {
        color: theme.colors.text.secondary,
    },
}));
