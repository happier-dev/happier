import * as React from 'react';
import { formatHappierCapabilityCount } from '@happier-dev/plugin-ui/presentation';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { ReachRulesChangeV1 } from '@happier-dev/protocol/reach/reachRulesChangeV1';
import type { ReachRulesV1 } from '@happier-dev/protocol/reach/reachRuleV1';
import type { SkillInstallPreviewV1 } from '@happier-dev/protocol/prompts/library/skills/skillActionSchemasV1';

import {
  CapabilityFacts,
  type CapabilityFactsProps,
  type CapabilityTrust,
} from '@/components/capabilities/facts/CapabilityFacts';
import { CapabilityAddDetailAction } from '@/components/capabilities/add/CapabilityAddModal';
import { CapabilityListingSections, type CapabilityListingFacts } from '@/components/capabilities/add/CapabilityListingSections';
import { CapabilityRow } from '@/components/capabilities/row/CapabilityRow';
import {
  useDraftReachRules,
  WhereItsOnControl,
} from '@/components/capabilities/where/WhereItsOnControl';
import { Icon, ICON_SIZE, type IconName } from '@/components/ui/icons/Icon';
import { BareSectionContent } from '@/components/ui/lists/BareSectionContent';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SectionContentRow } from '@/components/ui/lists/SectionContentRow';
import { SkeletonRows } from '@/components/ui/lists/SkeletonRows';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import {
  projectReachOnMachines,
  type ReachMachine,
} from '@/sync/domains/capabilities/reach/useReachProjection';
import { t } from '@/text';

import {
  remainingOutsideReferences,
  SkillAlsoAddsNote,
  SkillOutsideReferencesItem,
} from '../outsideReferences';
import { SkillInstructionsSection } from '../detail/SkillInstructionsSection';
import { SkillMark } from '../SkillKindGlyph';
import { useSkillPlaces } from '../useSkillPlaces';
import { heldSkillRowProps } from './SkillPreviewRows';

/** What a skill's details say it installs (lab sa A2 "What it installs"), whichever way it was found. */
export type SkillAddDetailInstalls = Readonly<{
  trust: CapabilityTrust;
  /** Files beside SKILL.md that run (`0o755`). */
  scripts: number;
  /** Every file, SKILL.md included. */
  files: readonly Readonly<{ path: string; size: number }>[];
  cost: Readonly<{ bodyTokens: number; descriptionTokens: number }>;
  /** Where it comes from ("anthropics/skills" · "Found on skills.sh · pinned to 4f2a1c9 …"). */
  source?: Readonly<{ icon: IconName; title: string; subtitle: string }>;
}>;

/**
 * The details of a skill being added (lab sa A2), the same for Browse, a link and an upload: the name with its
 * purpose and facts; Where it's on (pick, Everywhere until the person narrows it); what it installs, with the
 * sibling skills it refers to; what happens next; its files. The caller owns the read, the footer and the Add.
 */
type SkillAddDetailProps = Readonly<{
    title: string;
    purpose: string | null;
    facts: CapabilityFactsProps;
    /** A problem or a failed read, under the facts. */
    notice?: React.ReactNode;
    installs: SkillAddDetailInstalls | null;
    /** The skill is still being read: What it installs keeps its place. */
    reading?: boolean;
    outsideReferences: readonly string[];
    /** The sibling rows (`useSkillSiblingChoice`), inside What it installs. */
    siblings?: React.ReactNode;
    onWhereChange: (where: ReachRulesChangeV1 | undefined) => void;
    initialWhere?: ReachRulesChangeV1;
    /** Membership and reach of an already held Skill come from its native library row. */
    savedRules?: ReachRulesV1;
    /** A listed skill's Versions and Source and licence, closing its details (lab store `h:kPdf`). */
    listing?: CapabilityListingFacts;
    /** The SKILL.md text of a found skill (a link or an upload): shown read-only as Its instructions (lab `k:upload`). */
    instructions?: string;
    testID: string;
  }>;

export type SkillAddDetailPlaces = Pick<ReturnType<typeof useSkillPlaces>,
  'machines' | 'workspaceRefs' | 'agentIds' | 'placeMachines' | 'projects' | 'agentTakes'>;

export function SkillAddDetailBody(props: SkillAddDetailProps) {
  const places = useSkillPlaces();
  return <SkillAddDetailView {...props} places={places} />;
}

/** The skill detail's presentation over the admitted places supplied by its read owner. */
export function SkillAddDetailView(props: SkillAddDetailProps & Readonly<{ places: SkillAddDetailPlaces }>) {
  const { theme } = useUnistyles();
  const { places } = props;
  const draftReach = useDraftReachRules('skill', props.initialWhere);
  const rules = props.savedRules ?? draftReach.rules;
  const { onWhereChange } = props;
  React.useEffect(() => {
    if (props.savedRules === undefined) onWhereChange(draftReach.where);
  }, [draftReach.where, onWhereChange, props.savedRules]);
  const projection = React.useMemo(
    () =>
      projectReachOnMachines(
        rules,
        places.machines as readonly ReachMachine[],
        undefined,
        places.workspaceRefs,
      ),
    [rules, places.machines, places.workspaceRefs],
  );
  const installs = props.installs;
  const trust = installs?.trust;
  return (
    <View>
      <ItemGroup surface="none">
        <BareSectionContent>
          <View style={styles.head}>
            {/* Identity first, as every Add family's details open (lab `m:skill`, `k:link`, `k:upload`): the skill mark, then its name. */}
            <View style={styles.titleRow}>
              <SkillMark size={28} />
              <Text
                variant="title"
                emphasis="semiBold"
                style={[styles.titleText, { color: theme.colors.text.primary }]}
                testID={`${props.testID}.title`}
                // The item's name heads its details (a listing pane moves focus here).
                accessibilityRole="header"
              >
                {props.title}
              </Text>
            </View>
            <CapabilityFacts {...props.facts} />
            {props.purpose ? (
              <Text
                variant="reading"
                style={{ color: theme.colors.text.secondary, marginTop: theme.space.s4 }}
              >
                {props.purpose}
              </Text>
            ) : null}
            {props.notice ?? null}
            {/* Browse's one action, right under what it adds (lab `m:skill`); found results keep their batch footer. */}
            <CapabilityAddDetailAction />
          </View>
        </BareSectionContent>
      </ItemGroup>
      <WhereItsOnControl
        testID={`${props.testID}.where`}
        kind="skill"
        presentation="pick"
        rules={rules}
        {...(props.savedRules === undefined ? {} : { readOnlyReason: t('capabilities.skillsFound.inLibrary') })}
        status="ready"
        projection={projection}
        places={{
          agentIds: places.agentIds,
          machines: places.placeMachines,
          projects: places.projects,
        }}
        agentTakes={places.agentTakes}
        onChange={draftReach.onChange}
      />
      {installs === null && props.reading === true ? (
        // Still reading the skill: What it installs holds its place, so the details don't arrive and then jump.
        <ItemGroup title={t('capabilities.skillAdd.detail.installsTitle')}>
          <SkeletonRows rows={3} />
        </ItemGroup>
      ) : null}
      {installs ? (
        // One sheet per section, as Where it's on beside it and the MCP details are (lab `m:skill`).
        <ItemGroup title={t('capabilities.skillAdd.detail.installsTitle')}>
          <Item
            icon={
              <Icon
                name={
                  trust === 'runs_scripts'
                    ? 'terminal'
                    : trust === 'has_files'
                      ? 'folder'
                      : 'file-text'
                }
                size={ICON_SIZE.md}
                color={theme.colors.text.secondary}
              />
            }
            title={
              trust === 'runs_scripts'
                ? t('capabilities.facts.runsScripts')
                : trust === 'has_files'
                  ? t('capabilities.facts.hasFiles')
                  : t('capabilities.facts.textOnly')
            }
            subtitle={
              trust === 'runs_scripts'
                ? t('capabilities.skillAdd.detail.runsScriptsBody', {
                    count: installs.scripts,
                  })
                : trust === 'has_files'
                  ? t('capabilities.skillAdd.detail.hasFilesBody', {
                      count: Math.max(0, installs.files.length - 1),
                    })
                  : t('capabilities.skillAdd.detail.textOnlyBody')
            }
          />
          <SkillOutsideReferencesItem
            references={props.outsideReferences}
            testID={`${props.testID}.outsideReferences`}
          />
          <Item
            icon={
              <Icon
                name="chat-circle"
                size={ICON_SIZE.md}
                color={theme.colors.text.secondary}
              />
            }
            title={t('capabilities.skillAdd.detail.tokensWhenUsed', {
              count: formatHappierCapabilityCount(installs.cost.bodyTokens),
            })}
            subtitle={t('capabilities.skillAdd.detail.alwaysOnBody', {
              count: String(installs.cost.descriptionTokens),
            })}
          />
          {installs.source ? (
            <Item
              icon={
                <Icon
                  name={installs.source.icon}
                  size={ICON_SIZE.md}
                  color={theme.colors.text.secondary}
                />
              }
              title={installs.source.title}
              subtitle={installs.source.subtitle}
            />
          ) : null}
          {props.siblings ?? null}
        </ItemGroup>
      ) : null}
      {props.instructions !== undefined ? (
        <SkillInstructionsSection
          testID={`${props.testID}.instructions`}
          skillId={props.title}
          skillMd={props.instructions}
          readOnly={NO_NOTE}
          onSave={neverSaves}
          onDirtyChange={noDirty}
          readTheirs={noTheirs}
          adoptTheirs={noAdopt}
        />
      ) : null}
      <ItemGroup title={t('capabilities.skillAdd.detail.nextTitle')}>
        <SectionContentRow>
          <View style={styles.steps}>
            {[
              t('capabilities.skillAdd.detail.next1'),
              t('capabilities.skillAdd.detail.next2'),
              t('capabilities.skillAdd.detail.next3'),
            ].map((line, index) => (
              <Text
                key={line}
                variant="body"
                style={{ color: theme.colors.text.primary }}
              >{`${index + 1}. ${line}`}</Text>
            ))}
          </View>
        </SectionContentRow>
      </ItemGroup>
      {installs && installs.files.length > (props.instructions !== undefined ? 1 : 0) ? (
        <ItemGroup
          title={t('capabilities.skillAdd.detail.filesTitle', {
            count: installs.files.length,
          })}
          density="compact"
        >
          {installs.files.map((file) => (
            <Item
              key={file.path}
              title={file.path}
              titleStyle={styles.mono}
              detail={
                file.size >= 1024
                  ? `${(file.size / 1024).toFixed(1)} KB`
                  : `${file.size} B`
              }
            />
          ))}
        </ItemGroup>
      ) : null}
      {props.listing ? <CapabilityListingSections testID={`${props.testID}.listing`} facts={props.listing} /> : null}
    </View>
  );
}

const NO_NOTE = {};
const neverSaves = async () => ({ ok: true as const, revision: '' });
const noTheirs = async () => null;
const noAdopt = async () => {};
const noDirty = () => {};

/**
 * The sibling skills a skill's instructions refer to, from the install preview: added with it unless unticked (held
 * ones are already in the library and open instead). Returns what the Add sends and what stays outside.
 */
export function useSkillSiblingChoice(
  input: Readonly<{
    primary: Pick<
      SkillInstallPreviewV1,
      'path' | 'outsideReferences' | 'siblingSkills'
    > | null;
    siblings: readonly SkillInstallPreviewV1[];
    /** The references to report when no preview answered (a registry read before its dry run). */
    outsideReferences: readonly string[];
    /** The same open task's per-item sibling choice, restored when its detail remounts. */
    initialSelectPaths?: readonly string[];
    onOpenHeld: (skillId: string) => void;
    testID: string;
  }>,
): Readonly<{
  selectPaths: readonly string[] | undefined;
  stillOutside: readonly string[];
  rows: React.ReactNode;
}> {
  const { primary, siblings } = input;
  const initialUnticked = () => new Set(input.initialSelectPaths === undefined ? []
    : siblings.filter(sibling => !input.initialSelectPaths!.includes(sibling.path)).map(sibling => sibling.path));
  const [unticked, setUnticked] = React.useState<ReadonlySet<string>>(
    initialUnticked,
  );
  const siblingKey = siblings.map((sibling) => sibling.path).join('\n');
  React.useEffect(() => {
    const next = initialUnticked();
    setUnticked(previous => previous.size === next.size && [...previous].every(path => next.has(path)) ? previous : next);
  }, [primary?.path, siblingKey, input.initialSelectPaths]);
  const held = React.useMemo(
    () =>
      new Set(
        siblings
          .filter((item) => item.inLibrary !== undefined)
          .map((item) => item.path),
      ),
    [siblings],
  );
  const kept = React.useMemo(
    () =>
      new Set(
        siblings
          .map((item) => item.path)
          .filter((path) => !unticked.has(path) && !held.has(path)),
      ),
    [held, siblings, unticked],
  );
  const stillOutside = React.useMemo(
    () =>
      primary && siblings.length > 0
        ? remainingOutsideReferences(
            {
              path: primary.path,
              outsideReferences: [...input.outsideReferences],
              siblingSkills: primary.siblingSkills,
            },
            kept,
            held,
          )
        : input.outsideReferences,
    [held, input.outsideReferences, kept, primary, siblings.length],
  );
  const rows = siblings.map((sibling) => {
    const testID = `${input.testID}.sibling.${sibling.name}`;
    const facts: CapabilityFactsProps = {
      presentation: 'row',
      trust: sibling.trust,
      cost: { tokensWhenUsed: sibling.cost.bodyTokens },
    };
    return sibling.inLibrary !== undefined ? (
      <CapabilityRow
        key={sibling.path}
        testID={testID}
        title={sibling.name}
        description={sibling.description}
        facts={facts}
        {...heldSkillRowProps(sibling.inLibrary, input.onOpenHeld, testID)}
      />
    ) : (
      <CapabilityRow
        key={sibling.path}
        testID={testID}
        title={sibling.name}
        description={sibling.description}
        facts={facts}
        checked={kept.has(sibling.path)}
        note={
          kept.has(sibling.path) ? (
            <SkillAlsoAddsNote
              name={sibling.name}
              testID={`${testID}.alsoAdds`}
            />
          ) : undefined
        }
        onPress={() =>
          setUnticked((previous) => {
            const next = new Set(previous);
            if (!next.delete(sibling.path)) next.add(sibling.path);
            return next;
          })
        }
      />
    );
  });
  const selectPaths = React.useMemo(
    () =>
      primary && siblings.length > 0 ? [primary.path, ...kept] : undefined,
    [kept, primary, siblings.length],
  );
  return { selectPaths, stillOutside, rows: siblings.length > 0 ? rows : null };
}

const styles = StyleSheet.create((theme) => ({
  head: { gap: theme.space.s8 },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s12 },
  titleText: { flexShrink: 1 },
  steps: { gap: theme.space.s8, paddingTop: theme.space.s4 },
  mono: { ...Typography.mono() },
}));
