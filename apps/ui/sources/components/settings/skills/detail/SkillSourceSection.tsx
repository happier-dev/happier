import * as React from 'react';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { readSkillOutsideReferencesV1 } from '@happier-dev/protocol/prompts/library/skills/skillReferencesV1';
import type { SkillReadResultV1 } from '@happier-dev/protocol/prompts/library/skills/skillReadV1';

import { Switch } from '@/components/ui/forms/Switch';
import { Icon } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Typography } from '@/constants/Typography';
import { useMachine } from '@/sync/store/hooks';
import { t } from '@/text';
import { formatPathRelativeToHome } from '@/utils/sessions/formatPathRelativeToHome';
import type { CapabilitySource } from '@/components/capabilities/facts/CapabilityFacts';
import { SessionBotFace } from '@/components/sessions/bots/face/SessionBotFace';
import type { SkillMaker } from '../skillMaker';

import { SkillOutsideReferencesItem } from '../outsideReferences';
import { skillSource, skillSourceVerification } from '../skillsCollectionModel';
import { contentRefLabel } from '../updates/useSkillsUpdates';
import type { SkillChange, SkillChangeResult } from './useSkillDetail';

function formatTime(ms: number): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
  }).format(ms);
}
function formatDay(ms: number): string {
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
  }).format(ms);
}

/** Where a skill came from, as the Source row says it (sd D "Source and updates"). */
function sourceRow(
  read: SkillReadResultV1,
  machineName: (machineId: string) => string,
  homeDir: string | undefined,
  pluginSource?: Extract<CapabilitySource, { kind: 'plugin' }>,
  registrySourceName?: string,
): Readonly<{
  title: string;
  subtitle?: string;
  icon?: 'github-logo' | 'link' | 'desktop' | 'user-circle' | 'sparkle' | 'puzzle-piece';
  mono?: boolean;
}> | null {
  const provenance = read.provenance;
  const source = skillSource(read, machineName, undefined, registrySourceName);
  const sourceTitle = source?.kind === 'registry' || source?.kind === 'git' ? source.label
    : source?.kind === 'link' ? source.host : undefined;
  switch (provenance.kind) {
    case 'written':
      return {
        title: t('capabilities.skills.maker.createdHere'),
        icon: 'user-circle',
      };
    case 'upload':
      return {
        title: t('capabilities.skillDetail.source.uploadedByYou'),
        subtitle: t('capabilities.skillDetail.source.added', {
          date: formatDay(provenance.importedAt),
        }),
        icon: 'user-circle',
      };
    case 'first_party':
      return {
        title: t('capabilities.skillDetail.source.firstParty'),
        icon: 'sparkle',
      };
    case 'plugin':
      return pluginSource ? {
        title: t('capabilities.skillsFound.fromPlugin', { plugin: pluginSource.pluginName }),
        icon: 'puzzle-piece',
      } : null;
    case 'machine':
      return {
        title: t('capabilities.skillDetail.source.foundOn', {
          machine: machineName(provenance.machineId),
        }),
        subtitle: t('capabilities.skillDetail.source.foundOnBody', {
          path: formatPathRelativeToHome(provenance.path, homeDir),
        }),
        icon: 'desktop',
      };
    case 'wellKnown': {
      return {
        title: sourceTitle ?? provenance.indexUrl,
        subtitle: skillSourceVerification(read),
        icon: 'link',
      };
    }
    case 'registry': {
      const ref = provenance.registry.ref;
      if (ref.kind === 'wellKnown') return sourceRow({ ...read, provenance: ref }, machineName, homeDir, undefined, registrySourceName);
      const title = sourceTitle ?? provenance.registry.sourceUrl;
      if (title === undefined) return null;
      const at =
        ref.kind === 'gitTree'
          ? `${ref.path ? `${ref.path} ` : ''}@${ref.commit.slice(0, 7)}`
          : contentRefLabel(ref);
      return {
        title,
        subtitle: `${at} · ${t('capabilities.skillDetail.source.added', { date: formatDay(provenance.registry.importedAt) })}`,
        icon: 'github-logo',
      };
    }
    case 'link': {
      const ref = provenance.ref;
      if (ref.kind === 'wellKnown') return sourceRow({ ...read, provenance: ref }, machineName, homeDir, undefined, registrySourceName);
      return {
        title: source?.kind === 'registry' ? source.label : provenance.url,
        subtitle:
          ref.kind === 'gitTree' ? `@${ref.commit.slice(0, 7)}` : contentRefLabel(ref) ?? undefined,
        icon: 'link',
      };
    }
  }
}

/**
 * "Source and updates" (sd D): where the skill came from and, for registry and link sources only, its
 * update state with Check now (P4's one checker), "Update automatically" (off by default for others'
 * skills, D19) and "Pin to this version". Creator attribution is separate from source.
 */
export function SkillSourceSection(
  props: Readonly<{
    read: SkillReadResultV1;
    updatePolicy: 'manual' | 'auto' | 'pinned';
    machineName: (machineId: string) => string;
    pluginSource?: Extract<CapabilitySource, { kind: 'plugin' }>;
    registrySourceName?: string;
    maker?: SkillMaker;
    onOpenCreator?: () => void;
    checkNow: () => void;
    checking: boolean;
    checkedAt: number | null;
    checkFailed: boolean;
    checkFailureReason?: string;
    onViewUpdate: () => void;
    update: (change: SkillChange) => Promise<SkillChangeResult>;
    testID: string;
  }>,
) {
  const { theme } = useUnistyles();
  const { read } = props;
  const tracked =
    read.provenance.kind === 'registry' || read.provenance.kind === 'link' || read.provenance.kind === 'wellKnown';
  const foundOn = read.provenance.kind === 'machine' ? read.provenance.machineId : null;
  // The folder is shown the way the machine's person writes it (~/...), from that machine's own home.
  const homeDir = useMachine(foundOn ?? '', foundOn !== null)?.metadata?.homeDir ?? undefined;
  const source = sourceRow(read, props.machineName, homeDir, props.pluginSource, props.registrySourceName);
  // Imported bundles are copies of a folder; a skill written here or shipped with Happier has no outside to miss.
  const importedCopy =
    read.provenance.kind === 'registry' ||
    read.provenance.kind === 'link' ||
    read.provenance.kind === 'wellKnown' ||
    read.provenance.kind === 'upload' ||
    read.provenance.kind === 'machine';
  const outsideReferences = React.useMemo(
    () =>
      importedCopy
        ? readSkillOutsideReferencesV1(
            read.skillMd,
            read.files.map((file) => file.path),
          )
        : [],
    [importedCopy, read.files, read.skillMd],
  );
  const [policy, setPolicy] = React.useState(props.updatePolicy);
  React.useEffect(() => setPolicy(props.updatePolicy), [props.updatePolicy]);
  const setUpdatePolicy = React.useCallback(
    async (next: 'manual' | 'auto' | 'pinned') => {
      const previous = policy;
      setPolicy(next);
      const result = await props.update({ updatePolicy: next });
      if (!result.ok) setPolicy(previous);
    },
    [policy, props],
  );

  if (!source) return null;

  const description =
    // Built-in and plugin skills say who ships them in the source row, once.
    read.provenance.kind === 'plugin' || read.provenance.kind === 'first_party'
      ? undefined
      : !tracked
          ? t('capabilities.skillDetail.source.descriptionOwn')
          : policy === 'pinned'
            ? t('capabilities.skillDetail.source.descriptionPinned')
            : policy === 'auto'
              ? t('capabilities.skillDetail.source.descriptionAuto')
              : t('capabilities.skillDetail.source.descriptionReview');
  const upstream = read.upstream?.state;
  const stateWords =
    upstream === 'update_available'
      ? t('capabilities.skillDetail.source.updateAvailable')
      : upstream === 'removed_from_source'
        ? t('capabilities.skillDetail.source.removedFromSource')
        : upstream === 'current'
          ? t('capabilities.skillDetail.source.upToDate')
          : t('capabilities.skillDetail.source.notChecked');
  const updatesSubtitle = props.checkFailed
    ? props.checkFailureReason || t('capabilities.skillDetail.source.checkFailed')
    : props.checkedAt
      ? `${stateWords} · ${t('capabilities.skillDetail.source.checked', { time: formatTime(props.checkedAt) })}`
      : stateWords;

  return (
    <ItemGroup
      testID={props.testID}
      title={t('capabilities.skillDetail.source.title')}
      description={description}
    >
      <Item
        testID={`${props.testID}:source`}
        title={source.title}
        subtitle={source.subtitle}
        subtitleStyle={
          read.provenance.kind === 'machine' ? styles.mono : undefined
        }
        icon={source.icon ? (
          <Icon
            name={source.icon}
            size={20}
            color={theme.colors.text.secondary}
          />
        ) : undefined
        }
        showChevron={false}
      />
      <SkillOutsideReferencesItem
        references={outsideReferences}
        testID={`${props.testID}:outsideReferences`}
      />
      {props.maker ? (
        <Item
          testID={`${props.testID}:maker`}
          title={t('capabilities.skills.maker.title')}
          subtitle={props.maker.label}
          icon={props.maker.face ? <SessionBotFace facts={props.maker.face} size={20} motion={false} /> : undefined}
          rightElement={props.maker.openSessionId && props.onOpenCreator ? (
            <RoundButton
              testID={`${props.testID}:openCreator`}
              size="small"
              display="secondary"
              title={t('capabilities.skills.maker.openSession')}
              onPress={props.onOpenCreator}
            />
          ) : undefined}
          showChevron={false}
        />
      ) : null}
      {tracked ? (
        <>
          <Item
            testID={`${props.testID}:updates`}
            title={t('capabilities.skillDetail.source.updates')}
            subtitle={updatesSubtitle}
            rightElement={
              upstream === 'update_available' ? (
                <RoundButton
                  testID={`${props.testID}:view`}
                  size="small"
                  display="secondary"
                  title={t('capabilities.skillDetail.source.view')}
                  onPress={props.onViewUpdate}
                />
              ) : (
                <RoundButton
                  testID={`${props.testID}:checkNow`}
                  size="small"
                  display="secondary"
                  title={t('capabilities.skillDetail.source.checkNow')}
                  loading={props.checking}
                  disabled={props.checking}
                  onPress={props.checkNow}
                />
              )
            }
            showChevron={false}
          />
          <Item
            testID={`${props.testID}:auto`}
            title={t('capabilities.skillDetail.source.auto')}
            subtitle={t('capabilities.skillDetail.source.autoBody')}
            rightElement={
              <Switch
                value={policy === 'auto'}
                disabled={policy === 'pinned'}
                onValueChange={(on) => {
                  void setUpdatePolicy(on ? 'auto' : 'manual');
                }}
              />
            }
            showChevron={false}
          />
          <Item
            testID={`${props.testID}:pin`}
            title={t('capabilities.skillDetail.source.pin')}
            subtitle={t('capabilities.skillDetail.source.pinBody')}
            rightElement={
              <Switch
                value={policy === 'pinned'}
                onValueChange={(on) => {
                  void setUpdatePolicy(on ? 'pinned' : 'manual');
                }}
              />
            }
            showChevron={false}
          />
        </>
      ) : null}
    </ItemGroup>
  );
}

const styles = StyleSheet.create(() => ({
  mono: { ...Typography.mono() },
}));
