import * as React from 'react';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type {
  HomeSettingEntryV1,
  HomeSettingSecretWriteV1,
} from '@happier-dev/protocol/home/governance';

import type { SettingRef } from '@/components/settings/catalog/settingDeclarations';
import {
  SettingAnchor,
  SettingSection,
} from '@/components/settings/shell/SettingRow';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import {
  ExpandableItem,
  ExpandableItemCaret,
} from '@/components/ui/lists/ExpandableItem';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemLoadStateRows } from '@/components/ui/lists/ItemLoadStateRows';
import { SectionButtonRow } from '@/components/ui/lists/SectionButtonRow';
import { SectionContentRow } from '@/components/ui/lists/SectionContentRow';
import { StatusDot } from '@/components/ui/status/StatusDot';
import { StatusPill } from '@/components/ui/status/StatusPill';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { ITEM_SUBTITLE_TEXT_METRICS } from '@/components/ui/lists/itemDensityMetrics';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import type { HomeSettingsRead } from '@/hooks/home/useHomeSettings';
import { t } from '@/text';

import type { HomeAdministrationContext } from '../governance/homeAdministrationContext';
import { homeGovernanceFailureNotice } from '../governance/homeGovernanceLabels';
import {
  HomeSecretSettingRow,
  KEEP_HOME_SECRET,
  type HomeSecretDraft,
} from '../governance/HomeSecretSettingRow';
import {
  buildHomeSettingWrite,
  type HomeSettingDraftValue,
} from '../governance/homeSettingDraft';
import {
  HomeSettingFieldRow,
  type HomeSettingStage,
} from '../governance/HomeSettingFieldRow';
import {
  HomeSettingRowPills,
  homeSettingRunningState,
} from '../governance/HomeSettingRowState';
import { homeSettingTitle } from '../governance/homeServerSettingsRows';
import {
  homeSettingFieldError,
  homeSettingTextRefusal,
  useHomeSettingsWrite,
} from '../governance/useHomeSettingsWrite';
import {
  homeSignInPlatformFieldTitle,
  homeSignInPlatformIcon,
  homeSignInPlatformKeyNeed,
  homeSignInPlatformSummary,
  homeSignInPlatformTitle,
  selectHomeSignInPlatforms,
  type HomeSignInPlatform,
  type HomeSignInPlatformId,
} from './homeSignInPlatforms';
import { HOME_SIGN_IN_PROVIDERS_SETTINGS } from './homeSignInProvidersSettings';

const ROW_TESTID = 'home-sign-in-platform-setting';
const NO_DRAFTS: Readonly<Record<string, never>> = Object.freeze({});

function declared(key: string): SettingRef | undefined {
  return (
    HOME_SIGN_IN_PROVIDERS_SETTINGS.settings as Readonly<
      Record<string, SettingRef | undefined>
    >
  )[key];
}

/** The platform's own row and every key it renders: a search for any of them opens it. */
function platformAnchors(platform: HomeSignInPlatform): SettingRef[] {
  const own =
    platform.id === 'github'
      ? HOME_SIGN_IN_PROVIDERS_SETTINGS.settings.githubSignIn
      : HOME_SIGN_IN_PROVIDERS_SETTINGS.settings.workos;
  return [
    own,
    ...platformEntries(platform).flatMap((entry) => declared(entry.key) ?? []),
  ];
}

function platformEntries(
  platform: HomeSignInPlatform,
): readonly HomeSettingEntryV1[] {
  return [
    ...platform.primary,
    ...platform.details,
    ...platform.access,
    ...platform.advanced,
  ];
}

/**
 * What a key is called and what the owner should know about it, inside its platform's row (lab
 * `hcSignin-RN/RP`): the row already says "WorkOS", so its fields are "Client ID" and "API key",
 * each with where the value comes from or what happens to it. A missing credential says what it
 * blocks; a value the server is not running with says so first.
 */
function platformRowWords(
  platform: HomeSignInPlatform,
  entry: HomeSettingEntryV1,
): Readonly<{
  title: string;
  hint: string | undefined;
  tone: 'warning' | 'danger' | null;
}> {
  const need = homeSignInPlatformKeyNeed(entry.key);
  const detail = platform.details.includes(entry);
  const title = need
    ? homeSignInPlatformFieldTitle(need)
    : detail
      ? t('homeGovernance.signInProviders.callbackAddress')
      : homeSettingTitle(entry);
  const running = homeSettingRunningState(entry);
  if (running)
    return {
      title,
      hint: running,
      tone: entry.applied?.ignoredReason ? 'danger' : null,
    };
  // A key the deployment fixed says so through the shared note instead.
  if (entry.fixed) return { title, hint: undefined, tone: null };
  if (need) {
    if (platform.state.kind === 'partly_set' && platform.state.need === need)
      return {
        title,
        hint:
          platform.id === 'github'
            ? t('homeGovernance.signInProviders.neededGithub')
            : t('homeGovernance.signInProviders.neededWorkos'),
        tone: 'warning',
      };
    if (entry.secretSet !== undefined)
      return {
        title,
        hint: entry.secretSet
          ? t('homeGovernance.signInProviders.secretHintSet')
          : t('homeGovernance.signInProviders.secretHintUnset'),
        tone: null,
      };
    return {
      title,
      hint:
        platform.id === 'github'
          ? t('homeGovernance.signInProviders.githubClientIdHint')
          : t('homeGovernance.signInProviders.workosClientIdHint'),
      tone: null,
    };
  }
  return {
    title,
    hint: detail
      ? t('homeGovernance.signInProviders.callbackAddressHint')
      : undefined,
    tone: null,
  };
}

function omitKey<V>(
  record: Readonly<Record<string, V>>,
  key: string,
): Readonly<Record<string, V>> {
  if (!(key in record)) return record;
  const next: Record<string, V> = { ...record };
  delete next[key];
  return next;
}

type RowProps = Readonly<{
  platform: HomeSignInPlatform;
  entry: HomeSettingEntryV1;
  staged: HomeSettingDraftValue | undefined;
  secretDraft: HomeSecretDraft | undefined;
  error: string | undefined;
  readOnly: boolean;
  disabled: boolean;
  onStage: HomeSettingStage;
  onSecretChange: (key: string, draft: HomeSecretDraft) => void;
  showDivider?: boolean;
}>;

/**
 * One key of a platform: the shared registry field, or the shared write-only row. Edits are staged
 * for the platform's Save; the restart is said once for the whole row, so only Pending is a pill.
 */
const PlatformSettingRow = React.memo(function PlatformSettingRow(
  props: RowProps,
) {
  const { entry, onSecretChange } = props;
  const { theme } = useUnistyles();
  const testID = `${ROW_TESTID}:${entry.key}`;
  const { title, hint, tone } = platformRowWords(props.platform, entry);
  const leading = tone ? (
    <StatusDot
      color={
        tone === 'danger'
          ? theme.colors.state.danger.foreground
          : theme.colors.state.warning.foreground
      }
    />
  ) : undefined;
  const pills = (
    <HomeSettingRowPills entry={entry} testID={testID} restartPill={false} />
  );
  const onSecret = React.useCallback(
    (draft: HomeSecretDraft) => onSecretChange(entry.key, draft),
    [entry.key, onSecretChange],
  );
  const row =
    entry.secretSet !== undefined ? (
      <HomeSecretSettingRow
        testID={testID}
        entry={entry}
        title={title}
        subtitle={hint}
        subtitleLeading={leading}
        titleAccessory={pills}
        placeholder={t('homeGovernance.signInProviders.secretPlaceholder')}
        draft={props.secretDraft ?? KEEP_HOME_SECRET}
        readOnly={props.readOnly}
        disabled={props.disabled}
        error={props.error ?? null}
        onChange={onSecret}
        showDivider={props.showDivider}
      />
    ) : (
      <HomeSettingFieldRow
        testID={testID}
        entry={entry}
        title={title}
        subtitle={hint}
        subtitleLeading={leading}
        titleAccessory={pills}
        staged={props.staged}
        readOnly={props.readOnly}
        disabled={props.disabled}
        error={props.error ?? null}
        onStage={props.onStage}
        showDivider={props.showDivider}
      />
    );
  const setting = declared(entry.key);
  return setting ? (
    <SettingAnchor setting={setting} showDivider={props.showDivider}>
      {row}
    </SettingAnchor>
  ) : (
    row
  );
});

/**
 * A closed group of a platform's keys inside its row: who may sign in with it, and the rarely changed
 * rest (lab `hcSignin-RG`).
 */
const PlatformKeyDisclosure = React.memo(function PlatformKeyDisclosure(
  props: Readonly<{
    platformId: HomeSignInPlatformId;
    group: 'access' | 'advanced';
    title: string;
    entries: readonly HomeSettingEntryV1[];
    rows: (entries: readonly HomeSettingEntryV1[]) => React.ReactNode;
  }>,
) {
  const [expanded, setExpanded] = React.useState(false);
  const anchors = React.useMemo(
    () => props.entries.flatMap((entry) => declared(entry.key) ?? []),
    [props.entries],
  );
  const testID = `home-sign-in-platform:${props.platformId}.${props.group}`;
  return (
    <SettingAnchor settings={anchors}>
      <ExpandableItem
        testID={testID}
        expanded={expanded}
        onExpandedChange={setExpanded}
        header={(state) => (
          <Item
            testID={`${testID}.header`}
            {...state.headerProps}
            title={props.title}
            detail={t('homeSettings.groupSummary', {
              count: props.entries.length,
            })}
            rightElement={<ExpandableItemCaret expanded={state.expanded} />}
            showChevron={false}
          />
        )}
      >
        {expanded ? props.rows(props.entries) : null}
      </ExpandableItem>
    </SettingAnchor>
  );
});

/**
 * One platform (lab `hcSignin-RN/RP/RS/RL/RI/RG`): closed, its mark, name and one state line; open,
 * what it is for, its credential pair, its advanced keys and one row-level Save. Nothing is written
 * until Save, which sends every staged field and secret of the platform as one write.
 */
const SignInPlatformRow = React.memo(function SignInPlatformRow(
  props: Readonly<{
    platform: HomeSignInPlatform;
    context: HomeAdministrationContext;
    home: HomeSettingsRead;
    readOnly: boolean;
    githubSignInOn: boolean;
    showDivider?: boolean;
  }>,
) {
  const { platform, context, home, readOnly } = props;
  const { theme } = useUnistyles();
  const [expanded, setExpanded] = React.useState(false);
  const [drafts, setDrafts] =
    React.useState<Readonly<Record<string, HomeSettingDraftValue>>>(NO_DRAFTS);
  const [secretDrafts, setSecretDrafts] =
    React.useState<Readonly<Record<string, HomeSecretDraft>>>(NO_DRAFTS);
  const [errors, setErrors] =
    React.useState<Readonly<Record<string, string>>>(NO_DRAFTS);
  const setError = React.useCallback((key: string, message: string | null) => {
    setErrors((current) =>
      message === null ? omitKey(current, key) : { ...current, [key]: message },
    );
  }, []);
  const { writing, write } = useHomeSettingsWrite({
    context,
    home,
    onFieldError: setError,
  });
  const disabled = !context.mutationsAvailable || writing;

  const onStage = React.useCallback<HomeSettingStage>(
    (key, value) => {
      setError(key, null);
      setDrafts((current) =>
        value === null ? omitKey(current, key) : { ...current, [key]: value },
      );
    },
    [setError],
  );
  const onSecretChange = React.useCallback(
    (key: string, draft: HomeSecretDraft) => {
      setError(key, null);
      setSecretDrafts((current) =>
        draft.mode === 'keep'
          ? omitKey(current, key)
          : { ...current, [key]: draft },
      );
    },
    [setError],
  );

  const secrets = React.useMemo(() => {
    const result: Record<string, HomeSettingSecretWriteV1> = {};
    for (const [key, draft] of Object.entries(secretDrafts)) {
      if (draft.mode === 'clear') result[key] = { clear: true };
      else if (draft.mode === 'replace' && draft.text)
        result[key] = { replace: draft.text };
    }
    return result;
  }, [secretDrafts]);
  const dirty =
    Object.keys(drafts).length > 0 || Object.keys(secrets).length > 0;

  const cancel = React.useCallback(() => {
    setDrafts(NO_DRAFTS);
    setSecretDrafts(NO_DRAFTS);
    setErrors(NO_DRAFTS);
  }, []);
  const save = React.useCallback(async () => {
    const entries = home.settings?.entries ?? [];
    let refused = false;
    for (const [key, staged] of Object.entries(drafts)) {
      const entry = entries.find((candidate) => candidate.key === key);
      if (!entry || staged.kind !== 'text') continue;
      const refusal = homeSettingTextRefusal(entry, staged.text);
      if (refusal) {
        setError(key, homeSettingFieldError(entry, refusal));
        refused = true;
      }
    }
    if (refused) return;
    const built = buildHomeSettingWrite(entries, drafts);
    if (!built.ok) {
      for (const key of built.invalidKeys)
        setError(key, t('homeSettings.row.invalid'));
      return;
    }
    if (!built.changed && Object.keys(secrets).length === 0) {
      cancel();
      return;
    }
    const ok = await write({
      key: null,
      values: built.values,
      ...(Object.keys(secrets).length > 0 ? { secrets } : {}),
    });
    if (ok) cancel();
  }, [cancel, drafts, home.settings, secrets, setError, write]);

  const rows = React.useCallback(
    (entries: readonly HomeSettingEntryV1[]) =>
      entries.map((entry, index) => (
        <PlatformSettingRow
          key={entry.key}
          platform={platform}
          entry={entry}
          staged={drafts[entry.key]}
          secretDraft={secretDrafts[entry.key]}
          error={errors[entry.key]}
          readOnly={readOnly}
          disabled={disabled}
          onStage={onStage}
          onSecretChange={onSecretChange}
          showDivider={index < entries.length - 1}
        />
      )),
    [
      disabled,
      drafts,
      errors,
      onSecretChange,
      onStage,
      platform,
      readOnly,
      secretDrafts,
    ],
  );

  const summary = homeSignInPlatformSummary(platform, {
    githubSignInOn: props.githubSignInOn,
  });
  const state = platform.state;
  const leading =
    state.kind === 'pending' ? (
      <StatusPill variant="warning" label={t('homeSettings.row.pending')} />
    ) : state.kind === 'partly_set' || state.kind === 'ignored' ? (
      <StatusDot
        color={
          state.kind === 'ignored'
            ? theme.colors.state.danger.foreground
            : theme.colors.state.warning.foreground
        }
      />
    ) : state.kind === 'locked' ||
      (state.kind === 'ready' && state.partlyLocked) ? (
      <Icon
        name="lock"
        size={ICON_SIZE.xs}
        color={theme.colors.text.secondary}
      />
    ) : undefined;
  const testID = `home-sign-in-platform:${platform.id}`;
  const restartKeys = platformEntries(platform).some(
    (entry) => entry.apply === 'restart' && !entry.fixed,
  );
  // A credential the deployment sets cannot change here, whatever is saved (lab `hcSignin-RL`).
  const footnote = [
    restartKeys ? t('homeGovernance.signInProviders.appliesAfterRestart') : null,
    platform.primary.some((entry) => entry.fixed)
      ? t('homeGovernance.signInProviders.lockedFootnote')
      : null,
  ]
    .filter((line) => line !== null)
    .join(' ');
  const anchors = React.useMemo(() => platformAnchors(platform), [platform]);

  return (
    <SettingAnchor settings={anchors} showDivider={props.showDivider}>
      <ExpandableItem
        testID={testID}
        expanded={expanded}
        onExpandedChange={setExpanded}
        showDivider={props.showDivider}
        header={(headerState) => (
          <Item
            testID={`${testID}.header`}
            {...headerState.headerProps}
            icon={<Icon name={homeSignInPlatformIcon(platform.id)} />}
            title={homeSignInPlatformTitle(platform.id)}
            subtitle={summary}
            subtitleLeading={leading}
            subtitleLines={0}
            rightElement={
              <ExpandableItemCaret expanded={headerState.expanded} />
            }
            showChevron={false}
          />
        )}
      >
        {expanded ? (
          <>
            <SectionContentRow>
              <Text style={styles.purpose}>
                {platform.id === 'github'
                  ? t('homeGovernance.signInProviders.githubPurpose', {
                      home: context.homeName,
                    })
                  : t('homeGovernance.signInProviders.workosPurpose', {
                      home: context.homeName,
                    })}
              </Text>
            </SectionContentRow>
            {rows([...platform.primary, ...platform.details])}
            {platform.access.length > 0 ? (
              <PlatformKeyDisclosure
                platformId={platform.id}
                group="access"
                title={t('homeGovernance.signInProviders.whoCanSignInGithub')}
                entries={platform.access}
                rows={rows}
              />
            ) : null}
            {platform.advanced.length > 0 ? (
              <PlatformKeyDisclosure
                platformId={platform.id}
                group="advanced"
                title={t('homeGovernance.signInProviders.advanced')}
                entries={platform.advanced}
                rows={rows}
              />
            ) : null}
            {readOnly ? null : (
              <SectionContentRow showDivider={false}>
                <SectionButtonRow
                  trailing={
                    <>
                      <RoundButton
                        testID={`${testID}.cancel`}
                        size="small"
                        display="inverted"
                        title={t('common.cancel')}
                        disabled={!dirty || writing}
                        onPress={cancel}
                      />
                      <RoundButton
                        testID={`${testID}.save`}
                        size="small"
                        title={t('common.save')}
                        loading={writing}
                        disabled={!dirty || disabled}
                        onPress={() => {
                          void save();
                        }}
                      />
                    </>
                  }
                >
                  {footnote ? (
                    <Text style={styles.footnote}>{footnote}</Text>
                  ) : null}
                </SectionButtonRow>
              </SectionContentRow>
            )}
          </>
        ) : null}
      </ExpandableItem>
    </SettingAnchor>
  );
});

/**
 * Sign-in platforms (AM-12): the credentials this Home signs in through, edited where the job is,
 * through the one registry writer. Owners edit; admins see the same rows as facts (HCLOG-08).
 */
export const HomeSignInPlatformsSection = React.memo(
  function HomeSignInPlatformsSection(
    props: Readonly<{
      context: HomeAdministrationContext;
      home: HomeSettingsRead;
    }>,
  ) {
    const { context, home } = props;
    const settings = home.settings;
    const platforms = React.useMemo(
      () => (settings ? selectHomeSignInPlatforms(settings) : null),
      [settings],
    );
    const readOnly = !context.projection.capabilities.manageHomeSettings;
    const githubSignInOn =
      context.projection.authenticationOptions.methods.some(
        (method) =>
          method.id === 'github' &&
          method.actions.some(
            (action) => action.id === 'login' && action.enabled,
          ),
      );
    if (!context.projection.capabilities.viewAdministration) return null;
    if (platforms !== null && platforms.length === 0) return null;
    return (
      <SettingSection
        section={HOME_SIGN_IN_PROVIDERS_SETTINGS.sectionRefs.signInPlatforms}
      >
        <ItemGroup
          title={t('homeGovernance.signInProviders.platforms')}
          description={
            readOnly
              ? t('homeGovernance.signInProviders.platformsDescriptionReadOnly', {
                  home: context.homeName,
                })
              : t('homeGovernance.signInProviders.platformsDescription', {
                  home: context.homeName,
                })
          }
        >
          {platforms === null ? (
            home.failure ? (
              <SurfaceStateCard
                testID="home-sign-in-platforms-error"
                kind="error"
                size="line"
                title={t('homeSettings.page.loadFailed')}
                reason={
                  homeGovernanceFailureNotice(home.failure, { effect: 'read' })
                    .body
                }
                action={{
                  testID: 'home-sign-in-platforms-retry',
                  label: t('homeGovernance.retry'),
                  onPress: home.reload,
                }}
              />
            ) : (
              // Both platforms are known rows: they hold their place until the Home answers.
              <ItemLoadStateRows
                testID="home-sign-in-platforms-loading"
                state={{ kind: 'loading' }}
                rows={2}
                accessibilityLabel={t('homeGovernance.signInProviders.platforms')}
              />
            )
          ) : (
            platforms.map((platform, index) => (
              <SignInPlatformRow
                key={platform.id}
                platform={platform}
                context={context}
                home={home}
                readOnly={readOnly}
                githubSignInOn={githubSignInOn}
                showDivider={index < platforms.length - 1}
              />
            ))
          )}
        </ItemGroup>
      </SettingSection>
    );
  },
);

const styles = StyleSheet.create((theme) => ({
  purpose: {
    ...Typography.default('regular'),
    ...ITEM_SUBTITLE_TEXT_METRICS.comfortable,
    color: theme.colors.text.secondary,
  },
  footnote: {
    flexShrink: 1,
    ...Typography.default('regular'),
    ...ITEM_SUBTITLE_TEXT_METRICS.comfortable,
    color: theme.colors.text.secondary,
  },
}));
