import * as React from 'react';
import { View } from 'react-native';
import { useNavigation, useRouter } from '@/components/appShell/workspace/destinationRoute';
import { StyleSheet } from 'react-native-unistyles';
import type { FeatureDecision, FeatureId } from '@happier-dev/protocol';
import type {
    HomeSettingEntryV1,
    HomeSettingIgnoredReasonV1,
    HomeSettingsProjectionV1,
} from '@happier-dev/protocol/home/governance';

import { SETTING_ANCHOR_QUERY_PARAM, type SettingRef } from '@/components/settings/catalog/settingDeclarations';
import { SettingAnchor } from '@/components/settings/shell/SettingRow';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Switch } from '@/components/ui/forms/Switch';
import { Icon } from '@/components/ui/icons/Icon';
import { AttentionBanner } from '@/components/ui/lists/AttentionBanner';
import { ExpandableItem, ExpandableItemCaret } from '@/components/ui/lists/ExpandableItem';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SectionContentRow } from '@/components/ui/lists/SectionContentRow';
import { useHomeSettings } from '@/hooks/home/useHomeSettings';
import { Modal } from '@/modal';
import { readHomeSettingsInvalidFailure, setHomeSettings } from '@/sync/ops/home/homeGovernanceOperations';
import { t } from '@/text';
import { useUnsavedDraftNavigationGuard } from '@/utils/navigation/useUnsavedDraftNavigationGuard';

import { HomeConsequenceNotice } from './HomeConsequenceNotice';
import { HomeDeploymentFixedNote } from './HomeDeploymentFixedNote';
import { HomeAdministrationSection } from './HomeAdministrationSection';
import type { HomeAdministrationContext } from './homeAdministrationContext';
import {
    homeFeatureDescription,
    homeFeatureFamilyTitle,
    homeFeatureSettingDescriptionKey,
    homeFeatureSettingTitleKey,
    homeFeatureTitle,
} from './homeFeatureLabels';
import {
    HOME_OTHER_FEATURE_FAMILY,
    homeFeatureDependentsTurningOff,
    homeFeaturePendingRestartValue,
    isHomeFeatureShownOn,
    isHomeFeatureToggleable,
    selectHomeFeatureRows,
    type HomeFeatureFamily,
    type HomeFeatureSwitchRow,
} from './homeFeatureRows';
import { HOME_FEATURE_SETTINGS } from './homeFeatureSettings';
import { homeGovernanceFailureNotice } from './homeGovernanceLabels';
import { buildHomeSettingWrite, type HomeSettingDraft, type HomeSettingDraftValue } from './homeSettingDraft';
import { HomeSettingFieldRow, type HomeSettingStage } from './HomeSettingFieldRow';

type StageValue = HomeSettingStage;

const NO_DEPENDENTS: readonly FeatureId[] = Object.freeze([]);

const FEATURE_ROW_TESTID = 'home-feature';

function featureSetting(featureId: FeatureId): SettingRef | undefined {
    return (HOME_FEATURE_SETTINGS.settings as Readonly<Record<string, SettingRef | undefined>>)[featureId];
}

function ignoredReasonLabel(reason: HomeSettingIgnoredReasonV1): string {
    switch (reason) {
        case 'invalid_type':
            return t('homeGovernance.features.ignoredInvalidType');
        case 'out_of_bounds':
            return t('homeGovernance.features.ignoredOutOfBounds');
        case 'secret_unreadable':
            return t('homeGovernance.features.ignoredSecretUnreadable');
    }
}

/**
 * The row's state in words, after its description: one message per state. A switch read only at
 * start whose saved value is not running yet says what it will be after the restart, because the
 * Home's decision still describes the running value.
 */
function stateLine(row: HomeFeatureSwitchRow, staged: boolean | undefined): string | null {
    const restart = row.entry?.apply === 'restart' && !row.entry.fixed;
    if (staged !== undefined && staged !== isHomeFeatureShownOn(row)) {
        // A staged change speaks for itself; a switch read only at start says when it lands.
        if (!restart) return null;
        return staged ? t('homeGovernance.features.onAfterRestart') : t('homeGovernance.features.offAfterRestart');
    }
    const pending = homeFeaturePendingRestartValue(row);
    if (pending !== null) {
        return pending ? t('homeGovernance.features.onAfterRestart') : t('homeGovernance.features.offAfterRestart');
    }
    switch (row.state.kind) {
        case 'fixed':
            // Said by the row's `HomeDeploymentFixedNote`, with the key as a code chip.
            return null;
        case 'notInBuild':
            return t('homeGovernance.features.notInBuild');
        case 'needs':
            return t('homeGovernance.features.needs', { feature: homeFeatureTitle(row.state.dependencyId) });
        case 'offHome':
            return t('homeGovernance.features.offHome');
        case 'unavailable':
            return row.state.switchable ? t('homeGovernance.features.unavailable') : t('homeGovernance.features.unavailableByDeployment');
        case 'noHomeSwitch':
            return row.state.on ? t('homeGovernance.features.noHomeSwitchOn') : t('homeGovernance.features.noHomeSwitchOff');
        case 'on':
        case 'off':
            return null;
    }
}

/** A limit's registry bounds as words: "1–2048", "1024 or more", "Up to 10". */
function boundsLine(entry: HomeSettingEntryV1): string | null {
    const bounds = entry.declaration?.bounds;
    if (!bounds) return null;
    const min = bounds.min;
    const max = bounds.max;
    if (min !== undefined && max !== undefined) return t('homeGovernance.features.rangeBetween', { min, max });
    if (min !== undefined) return t('homeGovernance.features.rangeAtLeast', { min });
    if (max !== undefined) return t('homeGovernance.features.rangeAtMost', { max });
    return null;
}

/**
 * The features that follow a parent the owner staged off, named inline under its row (lab
 * `hcFeatures-D`): nothing is written until Save. For a switch read only at start they follow at
 * the next start.
 */
const FeatureDependentsNotice = React.memo(function FeatureDependentsNotice(props: Readonly<{
    testID: string;
    featureId: FeatureId;
    dependents: readonly FeatureId[];
    afterRestart: boolean;
    showDivider?: boolean;
}>) {
    const feature = homeFeatureTitle(props.featureId);
    const count = props.dependents.length;
    const title = props.afterRestart
        ? (count === 1
            ? t('homeGovernance.features.dependentsAfterRestartTitle_one', { feature })
            : t('homeGovernance.features.dependentsAfterRestartTitle_other', { feature, count }))
        : (count === 1
            ? t('homeGovernance.features.dependentsTitle_one', { feature })
            : t('homeGovernance.features.dependentsTitle_other', { feature, count }));
    return (
        <HomeConsequenceNotice
            testID={props.testID}
            title={title}
            lines={props.dependents.map((id) => t('homeGovernance.features.dependentNeeds', { feature: homeFeatureTitle(id), parent: feature }))}
            showDivider={props.showDivider}
        />
    );
});

/**
 * One feature switch. A deployment-fixed key and a feature this build leaves out show their state in
 * words with no control; a feature waiting on another names it and opens that row. Flipping the
 * switch stages the value; turning a parent off names the enabled features that follow it.
 */
const FeatureSwitchRow = React.memo(function FeatureSwitchRow(props: Readonly<{
    row: HomeFeatureSwitchRow;
    staged: boolean | undefined;
    decisionsById: ReadonlyMap<FeatureId, FeatureDecision>;
    readOnly: boolean;
    disabled: boolean;
    onStage: StageValue;
    onOpenFeature: (featureId: FeatureId) => void;
    showDivider?: boolean;
}>) {
    const { row, staged, decisionsById, onStage, onOpenFeature } = props;
    const title = homeFeatureTitle(row.featureId);
    const description = homeFeatureDescription(row.featureId);
    const line = stateLine(row, staged);
    const restart = row.entry?.apply === 'restart' && !row.entry.fixed;
    const ignoredReason = row.entry?.applied?.ignoredReason;
    const subtitle = [
        description,
        restart ? t('homeGovernance.features.appliesAfterRestart') : null,
        line,
        ignoredReason ? t('homeGovernance.features.ignoredAtLastStart', { reason: ignoredReasonLabel(ignoredReason) }) : null,
    ].filter(Boolean).join('\n');
    const testID = `${FEATURE_ROW_TESTID}:${row.featureId}`;
    const current = isHomeFeatureShownOn(row);
    const on = staged ?? current;
    const entryKey = row.entry?.key ?? null;
    const handleToggle = React.useCallback((next: boolean) => {
        if (!entryKey) return;
        onStage(entryKey, next === current ? null : { kind: 'value', value: next });
    }, [current, entryKey, onStage]);
    const dependencyId = row.state.kind === 'needs' ? row.state.dependencyId : null;
    const openDependency = React.useCallback(() => {
        if (dependencyId) onOpenFeature(dependencyId);
    }, [dependencyId, onOpenFeature]);
    const dependents = React.useMemo(
        () => (current && staged === false ? homeFeatureDependentsTurningOff(row.featureId, decisionsById) : NO_DEPENDENTS),
        [current, decisionsById, row.featureId, staged],
    );
    const showNotice = dependents.length > 0;

    // Every row without a live control says why in its state line and who can change it.
    const locked = row.state.kind === 'fixed' || row.state.kind === 'notInBuild' || row.state.kind === 'noHomeSwitch'
        || (row.state.kind === 'unavailable' && !row.state.switchable) || props.readOnly;
    const item = locked ? (
        <Item
            testID={testID}
            title={title}
            subtitle={subtitle}
            subtitleLines={0}
            subtitleAccessory={row.state.kind === 'fixed' ? <HomeDeploymentFixedNote keys={[row.state.key]} testID={testID} /> : undefined}
            detail={row.state.kind === 'notInBuild' ? undefined : (row.state.kind === 'fixed' || row.state.kind === 'noHomeSwitch' ? row.state.on : on) ? t('common.on') : t('common.off')}
            mode="info"
            showChevron={false}
            showDivider={props.showDivider}
        />
    ) : (
        <Item
            testID={testID}
            showDivider={showNotice || props.showDivider}
            title={title}
            subtitle={subtitle}
            subtitleLines={0}
            showChevron={false}
            // A feature waiting on another opens that feature's row.
            {...(dependencyId ? { onPress: openDependency, accessibilityHint: line ?? undefined } : { mode: 'info' as const })}
            rightElement={(
                <Switch
                    testID={`${testID}.switch`}
                    accessibilityLabel={title}
                    value={on}
                    disabled={props.disabled || !isHomeFeatureToggleable(row)}
                    onValueChange={handleToggle}
                />
            )}
        />
    );
    const setting = featureSetting(row.featureId);
    const anchored = setting ? <SettingAnchor setting={setting} showDivider={showNotice || props.showDivider}>{item}</SettingAnchor> : item;
    if (!showNotice) return anchored;
    return (
        <>
            {anchored}
            <FeatureDependentsNotice
                testID={`${testID}.dependents`}
                featureId={row.featureId}
                dependents={dependents}
                afterRestart={restart}
                showDivider={props.showDivider}
            />
        </>
    );
});

/**
 * A feature's limit or mode, rendered from its declaration by the shared registry field row. Every
 * change is staged and commits with the page's Save.
 */
const FeatureLimitRow = React.memo(function FeatureLimitRow(props: Readonly<{
    entry: HomeSettingEntryV1;
    staged: HomeSettingDraftValue | undefined;
    readOnly: boolean;
    disabled: boolean;
    error: boolean;
    onStage: StageValue;
    showDivider?: boolean;
}>) {
    const { entry } = props;
    const titleKey = homeFeatureSettingTitleKey(entry.key);
    const descriptionKey = homeFeatureSettingDescriptionKey(entry.key);
    // A key this app has no label for is not shown rather than named after its env key.
    if (!titleKey) return null;
    const subtitle = [
        descriptionKey ? t(descriptionKey) : null,
        boundsLine(entry),
        entry.apply === 'restart' ? t('homeGovernance.features.appliesAfterRestart') : null,
    ].filter(Boolean).join('\n') || undefined;
    return (
        <HomeSettingFieldRow
            testID={`home-feature-limit:${entry.key}`}
            entry={entry}
            title={t(titleKey)}
            subtitle={subtitle}
            staged={props.staged}
            readOnly={props.readOnly}
            disabled={props.disabled}
            error={props.error ? t('homeGovernance.features.limitInvalid') : null}
            onStage={props.onStage}
            showDivider={props.showDivider}
        />
    );
});

/** One Advanced family: collapsed until opened, or until search or a dependency link asks for a row in it. */
const FeatureFamilyDisclosure = React.memo(function FeatureFamilyDisclosure(props: Readonly<{
    family: HomeFeatureFamily;
    openRequest: number;
    draft: HomeSettingDraft;
    decisionsById: ReadonlyMap<FeatureId, FeatureDecision>;
    readOnly: boolean;
    disabled: boolean;
    invalidKeys: ReadonlySet<string>;
    onStage: StageValue;
    onOpenFeature: (featureId: FeatureId) => void;
    showDivider?: boolean;
}>) {
    const { family, draft } = props;
    const declared = React.useMemo(
        () => family.switches.flatMap((row) => featureSetting(row.featureId) ?? []),
        [family.switches],
    );
    const [expanded, setExpanded] = React.useState(false);
    React.useEffect(() => {
        if (props.openRequest > 0) setExpanded(true);
    }, [props.openRequest]);
    const count = family.switches.length;
    const title = family.id === HOME_OTHER_FEATURE_FAMILY ? t('homeGovernance.features.other') : homeFeatureFamilyTitle(family.id);
    return (
        <SettingAnchor settings={declared}><ExpandableItem
            testID={`home-feature-family:${family.id}`}
            expanded={expanded}
            onExpandedChange={setExpanded}
            showDivider={props.showDivider}
            header={(state) => (
                <Item
                    testID={`home-feature-family:${family.id}.header`}
                    {...state.headerProps}
                    title={title}
                    subtitle={count === 1 ? t('homeGovernance.features.familyCount_one') : t('homeGovernance.features.familyCount_other', { count })}
                    rightElement={<ExpandableItemCaret expanded={state.expanded} />}
                    showChevron={false}
                />
            )}
        >
            {expanded ? (
                <>
                    {family.switches.map((row) => (
                        <FeatureSwitchRow
                            key={row.featureId}
                            row={row}
                            staged={stagedSwitch(draft, row)}
                            decisionsById={props.decisionsById}
                            readOnly={props.readOnly}
                            disabled={props.disabled}
                            onStage={props.onStage}
                            onOpenFeature={props.onOpenFeature}
                        />
                    ))}
                    {family.limits.map((entry) => (
                        <FeatureLimitRow
                            key={entry.key}
                            entry={entry}
                            staged={draft[entry.key]}
                            readOnly={props.readOnly}
                            disabled={props.disabled}
                            error={props.invalidKeys.has(entry.key)}
                            onStage={props.onStage}
                        />
                    ))}
                </>
            ) : null}
        </ExpandableItem></SettingAnchor>
    );
});

function stagedSwitch(draft: HomeSettingDraft, row: HomeFeatureSwitchRow): boolean | undefined {
    const staged = row.entry ? draft[row.entry.key] : undefined;
    return staged?.kind === 'value' && typeof staged.value === 'boolean' ? staged.value : undefined;
}

const EMPTY_DRAFT: HomeSettingDraft = Object.freeze({});
const NO_INVALID_KEYS: ReadonlySet<string> = new Set();

const FeaturesPage = React.memo(function FeaturesPage(props: Readonly<{ context: HomeAdministrationContext }>) {
    const { context } = props;
    const router = useRouter();
    const navigation = useNavigation();
    const { capabilities } = context.projection;
    const canView = capabilities.viewAdministration;
    const readOnly = !capabilities.manageHomeSettings;
    const home = useHomeSettings(context.scope, canView);
    const [draft, setDraft] = React.useState<HomeSettingDraft>(EMPTY_DRAFT);
    const [invalidKeys, setInvalidKeys] = React.useState<ReadonlySet<string>>(NO_INVALID_KEYS);
    const [saving, setSaving] = React.useState(false);
    // Which Advanced family a dependency link asked to open, and how many times.
    const [openRequests, setOpenRequests] = React.useState<Readonly<Record<string, number>>>({});

    const wasPendingRef = React.useRef(context.approvalPending);
    const { reload } = home;
    React.useEffect(() => {
        if (wasPendingRef.current && !context.approvalPending) reload();
        wasPendingRef.current = context.approvalPending;
    }, [context.approvalPending, reload]);

    const settings: HomeSettingsProjectionV1 | null = home.settings;
    const rows = React.useMemo(() => (settings ? selectHomeFeatureRows(settings) : null), [settings]);
    const write = React.useMemo(() => buildHomeSettingWrite(settings?.entries ?? [], draft), [settings, draft]);
    const unsaved = write.ok ? write.changed : true;
    const disabled = !context.mutationsAvailable || saving;

    const stage = React.useCallback<StageValue>((key, value) => {
        setDraft((current) => {
            if (value === null) {
                if (!(key in current)) return current;
                const next: Record<string, HomeSettingDraftValue> = { ...current };
                delete next[key];
                return next;
            }
            return { ...current, [key]: value };
        });
        setInvalidKeys((current) => (current.has(key) ? new Set([...current].filter((candidate) => candidate !== key)) : current));
    }, []);

    const discard = React.useCallback(() => {
        setDraft(EMPTY_DRAFT);
        setInvalidKeys(NO_INVALID_KEYS);
    }, []);
    useUnsavedDraftNavigationGuard({
        navigation,
        isDirty: !readOnly && unsaved,
        onDiscard: discard,
        tag: 'HomeAdministrationFeaturesScreen.beforeRemove',
    });

    // Every staged change commits here, in one write against the revision the page read.
    const save = React.useCallback(async () => {
        if (!settings) return;
        if (!write.ok) {
            setInvalidKeys(new Set(write.invalidKeys));
            return;
        }
        if (!write.changed) return;
        setSaving(true);
        try {
            const outcome = await setHomeSettings({ scope: context.scope, expectedRevision: settings.revision, values: write.values });
            if (outcome.kind === 'succeeded') {
                home.adoptSettings(outcome.value);
                setDraft(EMPTY_DRAFT);
                setInvalidKeys(NO_INVALID_KEYS);
                return;
            }
            if (outcome.kind === 'approval_pending') {
                context.requestApproval?.(outcome.artifactId);
                return;
            }
            if (outcome.failure.code === 'home_settings_revision_conflict') {
                // The staged edits stay; the rest of the page re-bases on what the Home now holds.
                await Modal.alertAsync(t('homeGovernance.features.conflictTitle'), t('homeGovernance.features.conflictBody'));
                home.reload();
                return;
            }
            const invalid = readHomeSettingsInvalidFailure(outcome.failure);
            if (invalid) {
                setInvalidKeys(new Set([invalid.key]));
                return;
            }
            const notice = homeGovernanceFailureNotice(outcome.failure);
            await Modal.alertAsync(notice.title, notice.body);
        } finally {
            setSaving(false);
        }
    }, [context, home, settings, write]);

    const openFeature = React.useCallback((featureId: FeatureId) => {
        const family = rows?.familyByFeature.get(featureId);
        if (family) setOpenRequests((current) => ({ ...current, [family]: (current[family] ?? 0) + 1 }));
        const setting = featureSetting(featureId);
        if (setting) router.setParams({ [SETTING_ANCHOR_QUERY_PARAM]: setting.anchor });
    }, [router, rows]);

    if (!canView) {
        return (
            <ItemGroup description={t('homeGovernance.forbiddenBody')}>
                <Item testID="home-features-forbidden" title={t('homeGovernance.forbiddenTitle')} mode="info" showChevron={false} />
            </ItemGroup>
        );
    }
    if (!rows) {
        if (home.failure) {
            return (
                <ItemGroup description={t('homeGovernance.features.loadFailed')}>
                    <Item testID="home-features-retry" title={t('homeGovernance.retry')} onPress={home.reload} showChevron={false} />
                </ItemGroup>
            );
        }
        return (
            <ItemGroup>
                <Item testID="home-features-loading" title={t('homeGovernance.loading')} loading mode="info" showChevron={false} />
            </ItemGroup>
        );
    }

    return (
        <>
            {readOnly ? (
                <AttentionBanner
                    testID="home-features-admin-read-only"
                    tone="neutral"
                    title={t('homeGovernance.features.adminTitle')}
                    description={t('homeGovernance.features.adminBody')}
                />
            ) : null}

            <ItemGroup title={t('homeGovernance.features.common')}>
                {rows.common.map((row) => (
                    <FeatureSwitchRow
                        key={row.featureId}
                        row={row}
                        staged={stagedSwitch(draft, row)}
                        decisionsById={rows.decisionsById}
                        readOnly={readOnly}
                        disabled={disabled}
                        onStage={stage}
                        onOpenFeature={openFeature}
                    />
                ))}
            </ItemGroup>

            {rows.advanced.length > 0 ? (
                <ItemGroup
                    title={t('homeGovernance.features.advanced')}
                    description={t('homeGovernance.features.advancedDescription', { count: rows.advancedCount })}
                >
                    {rows.advanced.map((family) => (
                        <FeatureFamilyDisclosure
                            key={family.id}
                            family={family}
                            openRequest={openRequests[family.id] ?? 0}
                            draft={draft}
                            decisionsById={rows.decisionsById}
                            readOnly={readOnly}
                            disabled={disabled}
                            invalidKeys={invalidKeys}
                            onStage={stage}
                            onOpenFeature={openFeature}
                        />
                    ))}
                </ItemGroup>
            ) : null}

            {!readOnly ? (
                <ItemGroup surface="none">
                    <SectionContentRow>
                        <View style={styles.formActions}>
                            <RoundButton
                                testID="home-features-discard"
                                size="small"
                                display="inverted"
                                title={t('common.discard')}
                                disabled={!unsaved || saving}
                                onPress={discard}
                            />
                            <RoundButton
                                testID="home-features-save"
                                size="small"
                                title={t('common.save')}
                                loading={saving}
                                disabled={!unsaved || disabled}
                                onPress={() => { void save(); }}
                            />
                        </View>
                    </SectionContentRow>
                </ItemGroup>
            ) : null}

            <ItemGroup>
                <Item
                    testID="home-features-device-link"
                    icon={<Icon name="flask" />}
                    title={t('homeGovernance.features.deviceTitle')}
                    subtitle={t('homeGovernance.features.deviceBody')}
                    onPress={() => router.push('/settings/features')}
                />
            </ItemGroup>
        </>
    );
});

/**
 * What one Home offers (plan §3.8, lab `hcFeatures-*`): the Common ten, then every other server
 * feature grouped by family with its limits, each row saying why it is on or off from the Home's own
 * feature decisions. Owners stage changes and commit them with Save (Discard reverts); admins read.
 * Features that only change this device stay on the device Features page, which this page links to.
 */
export const HomeAdministrationFeaturesScreen = React.memo(function HomeAdministrationFeaturesScreen(
    props: Readonly<{ serverId: string }>,
) {
    return (
        <HomeAdministrationSection
            serverId={props.serverId}
            title={t('homeGovernance.features.title')}
            description={t('homeGovernance.pages.features')}
        >
            {(context) => <FeaturesPage context={context} />}
        </HomeAdministrationSection>
    );
});

const styles = StyleSheet.create(() => ({
    formActions: {
        flexDirection: 'row',
        justifyContent: 'flex-end',
        gap: 8,
    },
}));
