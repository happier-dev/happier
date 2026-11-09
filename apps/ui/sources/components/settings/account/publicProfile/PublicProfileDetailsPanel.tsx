import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import {
  PublicProfileHttpsUrlV1Schema,
  type PublicProfilePolicyV1,
} from '@happier-dev/protocol/account/publicProfile';
import type { PublicProfileMetadataSelectionV1 } from '@happier-dev/protocol/account/publicProfileIntents';
import type { ScmCredentialFreeRepositorySelectorV1 } from '@happier-dev/protocol/scm/repositoryClone';

import { useProjectSourceAddress } from '@/components/projects/sources/useProjectSourceAddress';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { StringListField } from '@/components/ui/forms/StringListField';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SegmentedChoiceItem } from '@/components/ui/lists/SegmentedChoiceItem';
import { Text } from '@/components/ui/text/Text';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { t } from '@/text';
import { publicProfileLinkLabel } from './publicProfilePresentation';
import {
  PUBLIC_PROFILE_PERIODS,
  type PublicProfilePeriod,
  type PublicProfileVisitorTheme,
} from './publicProfileDraft';

type Selection = ScmCredentialFreeRepositorySelectorV1;
const PERIOD_KEYS = {
  '30days': 'period30',
  '90days': 'period90',
  year: 'periodYear',
} as const satisfies Record<PublicProfilePeriod, string>;
const THEMES = [
  'auto',
  'light',
  'dark',
] as const satisfies readonly PublicProfileVisitorTheme[];
const THEME_KEYS = {
  auto: 'themeAuto',
  light: 'themeLight',
  dark: 'themeDark',
} as const;

function isPublicLink(text: string): boolean {
  return PublicProfileHttpsUrlV1Schema.safeParse(text.trim()).success;
}

/**
 * Details on the owner's page: the words, links, photo and repositories about the person, the page's
 * one period and the theme visitors' pages use. Each is a member of the one private draft; nothing is
 * public until Publish or Apply, and an item whose Public data switch is off says so instead of
 * pretending it will appear. Repositories are read through the reachable Machine's hosting owner:
 * only one it reports public can be added.
 */
export function PublicProfileDetailsPanel(
  props: Readonly<{
    scope: ServerAccountScope;
    policy: PublicProfilePolicyV1;
    metadata: PublicProfileMetadataSelectionV1;
    onMetadataChange: (next: PublicProfileMetadataSelectionV1) => void;
    period: PublicProfilePeriod;
    onPeriodChange: (period: PublicProfilePeriod) => void;
    theme: PublicProfileVisitorTheme;
    /** Why the theme cannot change here (an applied picture keeps its reviewed theme). */
    themeUnavailableReason: string | null;
    onThemeChange: (theme: PublicProfileVisitorTheme) => void;
    /** The account has a photo visitors could see. */
    hasAccountPhoto: boolean;
  }>,
): React.ReactElement {
  const { metadata } = props;
  const latest = React.useRef(props);
  latest.current = props;
  const change = React.useCallback(
    (
      edit: (
        current: PublicProfileMetadataSelectionV1,
      ) => PublicProfileMetadataSelectionV1,
    ) => {
      latest.current.onMetadataChange(edit(latest.current.metadata));
    },
    [],
  );
  // One line per section names whichever of its items Public data keeps private (never one per row).
  const notShared = (fields: readonly ('bio' | 'links' | 'avatar' | 'projects')[]) => {
    const off = fields.filter((field) => !props.policy.fields[field]).map((field) => t(`publicIdentity.publicData.fields.${field}`));
    return off.length === 0 ? undefined : off.length === 1 ? t('publicIdentity.details.notShared', { item: off[0]! })
      : t('publicIdentity.details.notSharedMany', { items: off.join(', ') });
  };

  // The typed links are kept as written; only complete https addresses reach the draft.
  const [linkTexts, setLinkTexts] = React.useState<string[]>(
    () => metadata.links?.map((link) => link.url) ?? [],
  );
  const writeLinks = (texts: string[]) => {
    setLinkTexts(texts);
    const links = texts
      .map((text) => text.trim())
      .filter(isPublicLink)
      .map((url) => ({ label: publicProfileLinkLabel(url), url }));
    change(({ links: _links, ...rest }) =>
      links.length ? { ...rest, links } : rest,
    );
  };

  const projects = metadata.projectSelections ?? [];
  const [address, setAddress] = React.useState('');
  const [privateRefusal, setPrivateRefusal] = React.useState(false);
  const repository = useProjectSourceAddress(
    props.scope,
    (selector: Selection) => {
      if (selector.repository.visibility !== 'public') {
        setPrivateRefusal(true);
        return;
      }
      setAddress('');
      change((current) => {
        const existing = current.projectSelections ?? [];
        if (
          existing.some(
            (row) =>
              row.repository.nameWithOwner ===
              selector.repository.nameWithOwner,
          )
        )
          return current;
        return { ...current, projectSelections: [...existing, selector] };
      });
    },
  );
  const resolving =
    repository.resolution.kind === 'resolving' ||
    repository.resolution.kind === 'waiting_for_machines';
  const refusal = privateRefusal
    ? t('publicIdentity.details.repositoryPrivate')
    : repository.refusal && repository.refusal !== 'projects.sources.loading'
      ? t(repository.refusal)
      : null;

  return (
    <View testID="public-profile-details">
      <ItemGroup title={t('publicIdentity.details.aboutTitle')} description={notShared(['bio', 'links', 'avatar'])}>
        <Item
          title={t('publicIdentity.publicData.fields.bio')}
          showChevron={false}
          accessoryLayout="stacked"
          rightElement={
            <FieldTextInput
              testID="public-profile-details-bio"
              value={metadata.bio ?? ''}
              multiline
              placeholder={t('publicIdentity.details.bioPlaceholder')}
              accessibilityLabel={t('publicIdentity.publicData.fields.bio')}
              onChangeText={(text) =>
                change(({ bio: _bio, ...rest }) =>
                  text.trim() ? { ...rest, bio: text } : rest,
                )
              }
            />
          }
        />
        <Item
          title={t('publicIdentity.publicData.fields.links')}
          showChevron={false}
          accessoryLayout="stacked"
          rightElement={
            <StringListField
              testID="public-profile-details-links"
              values={linkTexts}
              onChange={writeLinks}
              itemLabel={(position) =>
                t('publicIdentity.details.link', { position })
              }
              removeLabel={(position) =>
                t('publicIdentity.details.removeLink', { position })
              }
              addLabel={t('publicIdentity.details.addLink')}
              itemPlaceholder="https://"
              itemError={(index) => {
                const text = linkTexts[index]?.trim() ?? '';
                return text && !isPublicLink(text)
                  ? t('publicIdentity.details.linkInvalid')
                  : null;
              }}
            />
          }
        />
        <SegmentedChoiceItem<'account' | 'planet'>
          testIDPrefix="public-profile-details-photo"
          // A narrow panel: the reason and descriptions wrap rather than end mid-word.
          subtitleLines={0}
          title={t('publicIdentity.publicData.fields.avatar')}
          value={
            metadata.avatar?.kind ??
            (props.hasAccountPhoto ? 'account' : 'planet')
          }
          onChange={(kind) =>
            change((current) => ({ ...current, avatar: { kind } }))
          }
          options={[
            {
              id: 'account',
              label: t('publicIdentity.details.photoAccount'),
              ...(props.hasAccountPhoto
                ? {}
                : {
                    disabled: true,
                    unavailableReason: t(
                      'publicIdentity.details.photoAccountUnavailable',
                    ),
                  }),
            },
            { id: 'planet', label: t('publicIdentity.details.photoPlanet') },
          ]}
        />
      </ItemGroup>

      <ItemGroup title={t('publicIdentity.publicData.fields.projects')} description={notShared(['projects']) ?? t('publicIdentity.publicData.details.projects')}>
        {projects.map((selection) => (
          <Item
            key={selection.repository.nameWithOwner}
            testID={`public-profile-details-project-${selection.repository.nameWithOwner}`}
            title={selection.repository.nameWithOwner}
            subtitle={selection.provider.displayName}
            showChevron={false}
            rightElement={
              <IconButton
                iconName="x"
                variant="plain"
                accessibilityLabel={t(
                  'publicIdentity.details.removeRepository',
                  { name: selection.repository.nameWithOwner },
                )}
                tooltip={t('publicIdentity.details.removeRepository', {
                  name: selection.repository.nameWithOwner,
                })}
                onPress={() =>
                  change((current) => {
                    const rest = (current.projectSelections ?? []).filter(
                      (row) =>
                        row.repository.nameWithOwner !==
                        selection.repository.nameWithOwner,
                    );
                    const { projectSelections: _projects, ...others } = current;
                    return rest.length
                      ? { ...others, projectSelections: rest }
                      : others;
                  })
                }
              />
            }
          />
        ))}
        <Item
          title={t('publicIdentity.details.addRepository')}
          showChevron={false}
          accessoryLayout="stacked"
          rightElement={
            <View style={styles.addRepository}>
              <FieldTextInput
                testID="public-profile-details-repository"
                value={address}
                onChangeText={(text) => {
                  setAddress(text);
                  setPrivateRefusal(false);
                }}
                placeholder={t('publicIdentity.details.repositoryPlaceholder')}
                accessibilityLabel={t('publicIdentity.details.addRepository')}
                autoCapitalize="none"
                monospace
                error={refusal}
                onSubmitEditing={() => {
                  if (address.trim()) void repository.resolve(address);
                }}
                style={styles.addressField}
              />
              <RoundButton
                testID="public-profile-details-repository-add"
                size="small"
                display="secondary"
                title={t('publicIdentity.details.add')}
                loading={resolving}
                disabled={!address.trim() || resolving}
                onPress={() => {
                  void repository.resolve(address);
                }}
              />
            </View>
          }
        />
      </ItemGroup>

      <ItemGroup title={t('publicIdentity.details.pageTitle')}>
        <SegmentedChoiceItem<PublicProfilePeriod>
          testIDPrefix="public-profile-details-period"
          subtitleLines={0}
          title={t('publicIdentity.profile.period')}
          subtitle={t('publicIdentity.details.periodDescription')}
          value={props.period}
          onChange={props.onPeriodChange}
          options={PUBLIC_PROFILE_PERIODS.map((period) => ({
            id: period,
            label: t(`publicIdentity.details.${PERIOD_KEYS[period]}`),
          }))}
        />
        <SegmentedChoiceItem<PublicProfileVisitorTheme>
          testIDPrefix="public-profile-details-theme"
          subtitleLines={0}
          title={t('publicIdentity.details.theme')}
          subtitle={
            props.themeUnavailableReason ??
            t('publicIdentity.details.themeDescription')
          }
          value={props.theme}
          disabled={props.themeUnavailableReason !== null}
          onChange={props.onThemeChange}
          options={THEMES.map((theme) => ({
            id: theme,
            label: t(`publicIdentity.details.${THEME_KEYS[theme]}`),
          }))}
        />
      </ItemGroup>
      <Text variant="meta" style={styles.footer}>
        {t('publicIdentity.details.footer')}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  addRepository: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: theme.space.s8,
  },
  addressField: { flexGrow: 1, flexShrink: 1, minWidth: 0 },
  footer: {
    color: theme.colors.text.secondary,
    paddingHorizontal: theme.space.s16,
    paddingBottom: theme.space.s12,
  },
}));
