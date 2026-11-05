import * as React from 'react';
import { createContext, useContext, useMemo, useState, type ReactElement, type ReactNode } from 'react';
import { Platform, View } from 'react-native';

import {
  buildHappierCapabilityCollectionAnatomy,
  type HappierCapabilityCollectionAnatomyInput,
} from '../presentation/capabilities/capabilityCollectionAnatomy.js';
import {
  HappierCapabilityFacts,
  buildHappierCapabilityFacts,
  buildHappierCapabilityHeaderFacts,
  type HappierCapabilityCost,
  type HappierCapabilityFactGlyph,
  type HappierCapabilityFactsInput,
  type HappierCapabilityFactsLabels,
  type HappierCapabilityFactsTextProps,
  type HappierCapabilitySource,
  type HappierCapabilityTrust,
} from '../presentation/capabilities/capabilityFacts.js';
import {
  doesHappierCapabilityStatusSpeak,
  resolveHappierCapabilityBlockingNotice,
  type HappierCapabilityFixKind,
  type HappierCapabilityStatus,
  type HappierCapabilityStatusKind,
  type HappierCapabilityStatusLabels,
  type HappierCapabilityStatusPlacement,
} from '../presentation/capabilities/capabilityStatus.js';
import {
  HappierCapabilityStatusChip,
  type HappierCapabilityStatusFixProps,
  type HappierCapabilityStatusPillProps,
} from '../presentation/capabilities/CapabilityStatusChip.js';
import {
  HappierWhereItsOnControl,
  type HappierWhereItsOnControlLabels,
  type HappierWhereItsOnHost,
  type HappierWhereItsOnIntent,
  type HappierWhereItsOnRuleState,
} from '../presentation/capabilities/WhereItsOnControl.js';
import type {
  HappierReachPlace,
  HappierWhereItsOnClauseParams,
  HappierWhereItsOnItemKind,
  HappierWhereItsOnNames,
  HappierWhereItsOnProjectionRow,
} from '../presentation/capabilities/whereItsOn.js';
import { HappierDisclosure } from '../presentation/collection/Disclosure.js';
import { HappierDisclosureChevron } from '../presentation/collection/DisclosureChevron.js';
import { HAPPIER_INSTANT_DISCLOSURE_MOTION } from '../presentation/collection/collectionMotion.js';
import { HappierText } from '../presentation/text/Text.js';
import { useHappierUiAccessibility, useOptionalHappierUiTypography } from '../environment/context.js';
import { HAPPIER_SPACE_STEPS } from '../environment/spacing.js';
import { resolveHappierTextStepStyle } from '../presentation/layout/pageText.js';
import { resolveHappierTypeScale } from '../presentation/text/typeScale.js';
import { useOptionalPluginUiPresentationHost } from '../presentationHost/context.js';
import { Button, IconButton } from './Button.js';
import type { CollectionAnatomy } from './Collection.js';
import { Badge, Banner } from './Foundation.js';
import { Select } from './Form.js';
import { Item, ItemGroup } from './List.js';
import { Menu } from './Overlay.js';
import { SettingRow } from './Setting.js';
import { Icon, type IconName } from './Icon.js';
import { PageHeader } from './PageHeader.js';
import {
  usePluginTheme,
  usePluginTranslation,
  type PluginTranslate,
} from './PluginUiProvider.js';
import { Text } from './Text.js';

/**
 * Capability kit for plugins that manage installable things (skills, servers, agents, extensions): the same
 * status words and blocking order, facts line, detail header, blocking notice and list-row anatomy Happier's own
 * Skills, MCP and Agents pages use, from one shared owner. The author passes data and handlers; the words come
 * from Happier's defaults or the plugin's translation bundle (`happier.plugin-ui.capability.*`).
 */

export type CapabilityStatusKind = HappierCapabilityStatusKind;
export type CapabilityFixKind = HappierCapabilityFixKind;
export type CapabilityStatus = HappierCapabilityStatus;
export type CapabilityStatusPlacement = HappierCapabilityStatusPlacement;
export type CapabilitySource = HappierCapabilitySource;
export type CapabilityTrust = HappierCapabilityTrust;
export type CapabilityCost = HappierCapabilityCost;
export type CapabilityFactsInput = HappierCapabilityFactsInput;


const KEY = 'happier.plugin-ui.capability';

function statusLabels(
  translate: PluginTranslate,
): HappierCapabilityStatusLabels {
  return {
    status: (kind, machine) => {
      switch (kind) {
        case 'error':
          return machine
            ? translate(`${KEY}.status.errorOn`, `Stopped on ${machine}`, { machine })
            : translate(`${KEY}.status.error`, 'Couldn’t start');
        case 'cantrun':
          return machine
            ? translate(
                `${KEY}.status.cantrunOn`,
                `Can’t run on ${machine}`,
                { machine },
              )
            : translate(`${KEY}.status.cantrun`, 'Can’t run');
        case 'masked':
          return machine
            ? translate(`${KEY}.status.maskedOn`, `${machine}’s copy wins`, { machine })
            : translate(`${KEY}.status.masked`, 'Another copy wins');
        case 'signin':
          return translate(`${KEY}.status.signin`, 'Needs sign-in');
        case 'more_access':
          return translate(`${KEY}.status.moreAccess`, 'Needs more access');
        case 'key':
          return translate(`${KEY}.status.key`, 'Needs a key');
        case 'expired':
          return translate(`${KEY}.status.expired`, 'Sign-in expired');
        case 'revoked':
          return translate(`${KEY}.status.revoked`, 'Access revoked');
        case 'offline':
          return translate(`${KEY}.status.offline`, 'Offline');
        case 'signing':
          return translate(`${KEY}.status.signing`, 'Signing in…');
        case 'update':
          return translate(`${KEY}.status.update`, 'Update available');
        case 'modified':
          return translate(`${KEY}.status.modified`, 'Modified');
        case 'pinned':
          return translate(`${KEY}.status.pinned`, 'Pinned');
        case 'off':
          return translate(`${KEY}.status.off`, 'Off');
        case 'unused':
          return translate(`${KEY}.status.unused`, 'Not used recently');
        case 'connected':
          return translate(`${KEY}.status.connected`, 'Connected');
      }
    },
    fix: (kind) => {
      switch (kind) {
        case 'sign_in':
          return translate(`${KEY}.fix.signIn`, 'Sign in');
        case 'reconnect':
          return translate(`${KEY}.fix.reconnect`, 'Reconnect');
        case 'add_key':
          return translate(`${KEY}.fix.addKey`, 'Add a key');
        case 'how_to_fix':
          return translate(`${KEY}.fix.howToFix`, 'How to fix');
        case 'try_again':
          return translate(`${KEY}.fix.tryAgain`, 'Try again');
        case 'review_update':
          return translate(`${KEY}.fix.reviewUpdate`, 'Review update');
        case 'compare':
          return translate(`${KEY}.fix.compare`, 'Compare');
        case 'turn_on':
          return translate(`${KEY}.fix.turnOn`, 'Turn on');
        case 'grant_access':
          return translate(`${KEY}.fix.grantAccess`, 'Grant access');
      }
    },
  };
}

function factsLabels(translate: PluginTranslate): HappierCapabilityFactsLabels {
  return {
    you: () => translate(`${KEY}.facts.you`, 'You'),
    happier: () => translate(`${KEY}.facts.happier`, 'Happier'),
    trust: (trust) =>
      trust === 'runs_scripts'
        ? translate(`${KEY}.facts.runsScripts`, 'Runs scripts')
        : trust === 'has_files'
          ? translate(`${KEY}.facts.hasFiles`, 'Has files')
          : translate(`${KEY}.facts.textOnly`, 'Text only'),
    toolCount: (count, shown) =>
      count === 1
        ? translate(`${KEY}.facts.tool`, `${shown} tool`, { count: shown })
        : translate(`${KEY}.facts.tools`, `${shown} tools`, { count: shown }),
    tokensPerTurn: (shown) =>
      translate(`${KEY}.facts.tokensPerTurn`, `${shown} tokens a turn`, {
        count: shown,
      }),
    tokensWhenUsed: (shown) =>
      translate(`${KEY}.facts.tokensWhenUsed`, `${shown} tokens`, {
        count: shown,
      }),
  };
}

/** The public icon vocabulary's nearest glyph for each fact. */
const GLYPH_ICON: Readonly<Record<HappierCapabilityFactGlyph, IconName>> = {
  you: 'settings',
  git: 'change-open',
  machine: 'desktop',
  link: 'globe',
  text_only: 'file',
  has_files: 'file',
  runs_scripts: 'terminal',
};

function StatusPill(props: HappierCapabilityStatusPillProps): ReactElement {
  const label =
    props.detail === undefined
      ? props.label
      : `${props.label} · ${props.detail}`;
  if (props.chrome === 'plain')
    return (
      <Text variant="meta" tone={props.variant === 'neutral' ? 'secondary' : props.variant}
        {...(props.placement === 'catalog' ? {} : { numberOfLines: 1 })}>
        {label}
      </Text>
    );
  return (
    <Badge
      tone={props.variant}
      variant={props.variant === 'neutral' ? 'outlined' : 'tinted'}
    >
      {label}
    </Badge>
  );
}

function StatusFix(props: HappierCapabilityStatusFixProps): ReactElement {
  return (
    <Button
      variant="secondary"
      size="small"
      title={props.title}
      onPress={props.onPress}
      {...(props.testID === undefined ? {} : { testID: props.testID })}
    />
  );
}

function StatusReason(props: Readonly<{ children: string }>): ReactElement {
  return (
    <Text variant="meta" tone="secondary">
      {props.children}
    </Text>
  );
}

export type CapabilityStatusChipProps = Readonly<{
  status: CapabilityStatus;
  /** `row` (default) for lists; `header` for a detail header, where `off` and `connected` also speak. */
  placement?: CapabilityStatusPlacement;
  /** Draw the status's one fix (its `fix.onPress`) beside it; in a list the row's own action usually holds it. */
  showFix?: boolean;
  testID?: string;
}>;

/** A capability's status where it speaks; healthy statuses draw nothing. */
export function CapabilityStatusChip(
  props: CapabilityStatusChipProps,
): ReactElement | null {
  const translate = usePluginTranslation();
  return (
    <HappierCapabilityStatusChip
      {...props}
      labels={statusLabels(translate)}
      Pill={StatusPill}
      Fix={StatusFix}
      Reason={StatusReason}
    />
  );
}

function FactsText(props: HappierCapabilityFactsTextProps): ReactElement {
  return (
    <Text
      variant={props.mono === true ? 'code' : 'meta'}
      tone={props.strong === true ? 'secondary' : 'muted'}
      {...(props.numberOfLines === undefined
        ? {}
        : { numberOfLines: props.numberOfLines })}
    >
      {props.children}
    </Text>
  );
}

export type CapabilityFactsProps = CapabilityFactsInput &
  Readonly<{ testID?: string }>;

/** Source · trust · cost on one quiet line that truncates at its end ("Runs scripts" carries weight). */
export function CapabilityFacts({
  testID,
  ...input
}: CapabilityFactsProps): ReactElement | null {
  const translate = usePluginTranslation();
  return (
    <HappierCapabilityFacts
      facts={buildHappierCapabilityFacts(input, factsLabels(translate))}
      Text={FactsText}
      renderGlyph={(glyph) => (
        <Icon name={GLYPH_ICON[glyph]} size="small" tone="muted" />
      )}
      {...(testID === undefined ? {} : { testID })}
    />
  );
}

export type CapabilityDetailHeaderProps = Readonly<{
  title: string;
  /** What it is for, from its own text; stops at two lines. */
  purpose?: string;
  /** Its identity mark (an `Image` or `BrandMark`); omit for kinds without one. */
  mark?: ReactNode;
  facts: CapabilityFactsInput;
  status?: CapabilityStatus | null;
  /** An identifier after the facts, drawn in mono (a registry id). */
  mono?: string;
  /** At most one primary page action plus a menu of rare operations. */
  actions?: ReactNode;
  testID: string;
}>;

/**
 * A capability's detail header: its mark, name and purpose, the facts that distinguish it on the meta line,
 * and a header-placement status only when it says something.
 */
export function CapabilityDetailHeader(
  props: CapabilityDetailHeaderProps,
): ReactElement {
  const translate = usePluginTranslation();
  const facts = buildHappierCapabilityHeaderFacts(
    props.facts,
    factsLabels(translate),
  );
  const meta = [
    ...facts.map((fact) => ({
      key: fact.key,
      text: fact.text,
      ...(fact.glyph === undefined ? {} : { icon: GLYPH_ICON[fact.glyph] }),
    })),
    ...(props.mono ? [{ key: 'mono', text: props.mono }] : []),
  ];
  const status = props.status ?? null;
  return (
    <PageHeader
      title={props.title}
      {...(props.purpose === undefined ? {} : { description: props.purpose })}
      {...(props.mark === undefined ? {} : { leading: props.mark })}
      meta={meta}
      {...(status !== null && doesHappierCapabilityStatusSpeak(status, 'header')
        ? {
            details: (
              <CapabilityStatusChip
                status={status}
                placement="header"
                testID={`${props.testID}.status`}
              />
            ),
          }
        : {})}
      {...(props.actions === undefined ? {} : { actions: props.actions })}
      testID={props.testID}
    />
  );
}

export type CapabilityBlockingBannerProps = Readonly<{
  status: CapabilityStatus;
  /** What stopped working ("Linear is signed out"). */
  title: string;
  /** What that means for the person's sessions. */
  body: string;
  testID?: string;
}>;

/** The one notice a blocked capability page leads with, with its fix; nothing for a status that does not block. */
export function CapabilityBlockingBanner(
  props: CapabilityBlockingBannerProps,
): ReactElement | null {
  const translate = usePluginTranslation();
  const notice = resolveHappierCapabilityBlockingNotice(
    props.status,
    statusLabels(translate),
  );
  if (notice === null) return null;
  return (
    <Banner
      tone={notice.tone}
      title={props.title}
      description={props.body}
      {...(notice.action === null
        ? {}
        : {
            action: (
              <Button
                variant={
                  notice.action.display === 'secondary'
                    ? 'secondary'
                    : 'primary'
                }
                size="small"
                title={notice.action.label}
                onPress={notice.action.onPress}
              />
            ),
          })}
      testID={props.testID ?? 'capability.banner'}
    />
  );
}

export type CapabilityCollectionAnatomyInput<Item> =
  HappierCapabilityCollectionAnatomyInput<Item>;

const COLLECTION_PARTS = {
  facts: (facts: CapabilityFactsInput) => <CapabilityFacts {...facts} />,
  status: (status: CapabilityStatus, testID: string) => (
    <CapabilityStatusChip status={status} testID={testID} />
  ),
  summary: (summary: string) => (
    <Text variant="meta" tone="secondary" numberOfLines={1}>
      {summary}
    </Text>
  ),
} as const;

/**
 * The capability row anatomy for `Collection`: name with where it is on at the title line's end, description,
 * then the facts line, which a speaking status takes.
 */
export function capabilityCollectionAnatomy<Item>(
  input: CapabilityCollectionAnatomyInput<Item>,
): CollectionAnatomy<Item> {
  return buildHappierCapabilityCollectionAnatomy(input, COLLECTION_PARTS);
}

/** A place an item can be on: every machine, one machine, or one project on every machine. */
export type WhereItsOnPlace = Exclude<HappierReachPlace, Readonly<{ t: 'workspace' }>>;
/** One rule beside Everywhere: a place (or every machine for one Agent), turned on or off there. */
export type WhereItsOnRule = Readonly<{ place: WhereItsOnPlace; agentId?: string; on: boolean }>;
/** The person's choice; the plugin applies it to its own rules and saves them. */
export type WhereItsOnIntent = HappierWhereItsOnIntent;
export type WhereItsOnIntentResult = Readonly<{ ok: true }> | Readonly<{ ok: false; message: string }>;

export type WhereItsOnControlProps = Readonly<{
  /** What the item is, for the words ("Never gets this skill"). */
  kind: HappierWhereItsOnItemKind;
  /** Everywhere on or off, before the rules beside it. */
  everywhere: 'on' | 'off';
  rules: readonly WhereItsOnRule[];
  /** What "Add an exception" offers, by name; `online` is the plugin's own reachability (null: not known). */
  places: Readonly<{
    agents: readonly Readonly<{ id: string; name: string }>[];
    machines: readonly Readonly<{ id: string; name: string; online: boolean | null }>[];
    projects?: readonly Readonly<{ key: string; name: string; machineCount: number }>[];
  }>;
  /**
   * Where it is available right now, per machine. Omitted: no consequence line. Null: still resolving (the line
   * keeps its slot).
   */
  availability?: readonly HappierWhereItsOnProjectionRow[] | null;
  /** The person's choice. Return `{ ok: false, message }` to show the change failed with Try again. */
  onIntent: (intent: WhereItsOnIntent) => Promise<WhereItsOnIntentResult> | WhereItsOnIntentResult | void;
  /** `section` (default): a detail page's section. `pick`: the compact form in an add flow. */
  presentation?: 'section' | 'pick';
  /** While the plugin's rules load, the sentence keeps its slot and nothing can change. */
  loading?: boolean;
  /** Why the viewer cannot change it; keeps the sentence and drops the controls. */
  readOnlyReason?: string;
  testID: string;
}>;

function clause(params: HappierWhereItsOnClauseParams): Readonly<{ agent: string; at: string }> {
  const place = params.place === undefined ? '' : `${params.placeKind === 'machine' ? 'on' : 'in'} ${params.place}`;
  return { agent: params.agent ?? '', at: place };
}
const joinWords = (...parts: readonly (string | undefined)[]) => parts.filter((part) => part).join(' ');

function joinEnglish(parts: readonly string[]): string {
  if (parts.length <= 1) return parts[0] ?? '';
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

function whereItsOnLabels(translate: PluginTranslate): HappierWhereItsOnControlLabels {
  const k = `${KEY}.where`;
  const joinList = (parts: readonly string[]) => translate(`${k}.joinList`, joinEnglish(parts), { list: joinEnglish(parts) });
  return {
    joinList,
    where: {
      onEverywhere: () => translate(`${k}.onEverywhere`, 'On everywhere'),
      everywhere: () => translate(`${k}.everywhere`, 'Everywhere'),
      off: () => translate(`${k}.off`, 'Off'),
      only: (params) => {
        const { agent, at } = clause(params);
        return translate(`${k}.only`, joinWords('Only', agent && `for ${agent}`, at), { agent, place: at });
      },
      on: (params) => {
        const { agent, at } = clause(params);
        return translate(`${k}.on`, agent ? joinWords('on for', agent, at) : joinWords('on', at), { agent, place: at });
      },
      except: (params) => {
        const { agent, at } = clause(params);
        return translate(`${k}.except`, joinWords('except', agent, at), { agent, place: at });
      },
      exceptions: (count) => translate(`${k}.exceptions`, count === 1 ? '1 exception' : `${count} exceptions`, { count }),
      more: (count) => translate(`${k}.more`, `${count} more`, { count }),
      effect: {
        everywhereOn: () => translate(`${k}.effect.everywhereOn`, 'Every machine and agent, and the ones you add later'),
        everywhereOff: () => translate(`${k}.effect.everywhereOff`, 'Off unless a rule below turns it on'),
        agentNever: (kind) =>
          translate(`${k}.effect.agentNever`, kind === 'skill' ? 'Never gets this skill, wherever it’s on' : 'Never gets this server, wherever it’s on', { kind }),
        agentEverywhereOn: () => translate(`${k}.effect.agentEverywhereOn`, 'Gets it even where the rest is off'),
        machineOn: () => translate(`${k}.effect.machineOn`, 'Every agent on this machine'),
        machineOff: () => translate(`${k}.effect.machineOff`, 'No agent on this machine'),
        projectOn: () => translate(`${k}.effect.projectOn`, 'In this project, on every machine'),
        projectOff: () => translate(`${k}.effect.projectOff`, 'Not in this project, on any machine'),
        folderOn: () => translate(`${k}.effect.folderOn`, 'In this folder on this machine'),
        folderOff: () => translate(`${k}.effect.folderOff`, 'Not in this folder'),
        agentAtOn: ({ agent, place, placeKind }) =>
          translate(`${k}.effect.agentAtOn`, `${agent} gets it ${placeKind === 'machine' ? 'on' : 'in'} ${place}`, { agent, place }),
        agentAtOff: ({ agent, place, placeKind }) =>
          translate(`${k}.effect.agentAtOff`, `${agent} doesn’t get it ${placeKind === 'machine' ? 'on' : 'in'} ${place}`, { agent, place }),
      },
      available: ({ agents, machines, projects }) =>
        translate(`${k}.available`, `Available to ${agents} on ${machines}${projects ? `, only in ${projects}` : ''}`, {
          agents,
          machines,
          projects: projects ?? '',
        }),
      availableNowhere: () => translate(`${k}.availableNowhere`, 'Not available anywhere yet'),
      offlineNote: (machine) => translate(`${k}.offlineNote`, `${machine} is offline. It gets this when it’s back.`, { machine }),
      offlineNoteMany: (count) => translate(`${k}.offlineNoteMany`, `${count} offline machines get it when they’re back.`, { count }),
      cantTake: (agent, kind) =>
        translate(`${k}.cantTake`, kind === 'skill' ? `${agent} can’t load skills.` : `${agent} can’t use MCP servers.`, { agent, kind }),
      moreMachines: (count) => translate(`${k}.moreMachines`, count === 1 ? '1 more machine' : `${count} more machines`, { count }),
    },
    control: {
      title: () => translate(`${k}.title`, 'Where it’s on'),
      description: () => translate(`${k}.description`, 'Set it once and every machine follows. The most specific rule wins.'),
      on: () => translate(`${k}.turnOn`, 'On'),
      off: () => translate(`${k}.turnOff`, 'Off'),
      turnedOnIn: () => translate(`${k}.turnedOnIn`, 'Turned on in'),
      except: () => translate(`${k}.exceptGroup`, 'Except'),
      nowhereYet: () => translate(`${k}.nowhereYet`, 'Nowhere yet. Add a project, a machine or an agent.'),
      addException: () => translate(`${k}.addException`, 'Add an exception'),
      addPlace: () => translate(`${k}.addPlace`, 'Add a place'),
      menuAgent: () => translate(`${k}.menuAgent`, 'An agent'),
      menuAgentEverywhere: () => translate(`${k}.menuAgentEverywhere`, 'An agent, everywhere'),
      menuMachine: () => translate(`${k}.menuMachine`, 'A machine'),
      menuProject: () => translate(`${k}.menuProject`, 'A project'),
      menuProjectEverywhere: () => translate(`${k}.menuProjectEverywhere`, 'A project, on every machine'),
      offline: () => translate(`${k}.offline`, 'offline'),
      unknown: () => translate(`${k}.unknown`, 'unknown'),
      machineCount: (count) => translate(`${k}.machineCount`, count === 1 ? '1 machine' : `${count} machines`, { count }),
      allAgents: () => translate(`${k}.allAgents`, 'All agents'),
      agentOnly: (agent) => translate(`${k}.agentOnly`, `${agent} only`, { agent }),
      whichAgents: (place) => translate(`${k}.whichAgents`, `Which agents in ${place}`, { place }),
      remove: (target) => translate(`${k}.remove`, `Remove the rule for ${target}`, { target }),
      staysOff: (agents) => translate(`${k}.staysOff`, `${agents} stays off here`, { agents }),
      change: () => translate(`${k}.change`, 'Change'),
      changeFailed: () => translate(`${k}.changeFailed`, 'Couldn’t save that change.'),
      tryAgain: () => translate(`${KEY}.fix.tryAgain`, 'Try again'),
    },
  };
}

/** The names and list words the slot components read (the slots stay stable module components). */
const WhereWordsContext = createContext<Readonly<{ names: HappierWhereItsOnNames; joinList: (parts: readonly string[]) => string }> | null>(null);

const PLACE_ICON: Readonly<Record<'desktop' | 'folder', IconName>> = { desktop: 'desktop', folder: 'file' };
const ICON_SIZE = { xs: 'small', sm: 'small', md: 'medium' } as const;

function WhereDisclosure(props: React.ComponentProps<HappierWhereItsOnHost['Disclosure']>): ReactElement {
  const host = useOptionalPluginUiPresentationHost();
  const theme = usePluginTheme();
  const { reducedMotion } = useHappierUiAccessibility();
  return (
    <HappierDisclosure
      testID={props.testID}
      expanded={props.expanded}
      onExpandedChange={props.onExpandedChange}
      showDivider={props.showDivider ?? false}
      motion={host?.disclosureMotion ?? HAPPIER_INSTANT_DISCLOSURE_MOTION}
      reducedMotion={reducedMotion || host?.disclosureMotion === undefined}
      separatorStyle={{ backgroundColor: theme.colors.border }}
      header={(state) => (
        <Item
          testID={props.rowTestID}
          onPress={state.headerProps.onPress}
          accessibilityRole="button"
          accessibilityExpanded={state.expanded}
          showDivider={false}
          accessory={
            props.changeLabel !== undefined && !state.expanded ? (
              <Text variant="label" tone="accent">
                {props.changeLabel}
              </Text>
            ) : (
              <HappierDisclosureChevron expanded={state.expanded} color={theme.colors.secondaryText} reducedMotion={reducedMotion} />
            )
          }
        >
          {props.title}
        </Item>
      )}
    >
      {props.children}
    </HappierDisclosure>
  );
}

function WhereAddMenu(props: React.ComponentProps<HappierWhereItsOnHost['AddMenu']>): ReactElement {
  const [open, setOpen] = useState(false);
  return (
    <Menu
      testID={props.testID}
      open={open}
      onOpenChange={setOpen}
      trigger={props.title}
      triggerAccessibilityLabel={props.title}
      triggerAppearance="control"
      triggerIcon="add"
      showGroupLabels
      groups={props.groups.map((group) => ({
        id: group.title,
        accessibilityLabel: group.title,
        items: group.items.map((item) => ({
          id: item.id,
          label: item.title,
          ...(item.mark?.kind === 'icon' ? { icon: PLACE_ICON[item.mark.name] } : {}),
          ...(item.trailing ? { subtitle: item.trailing.text } : {}),
        })),
      }))}
      onSelect={(id) => {
        setOpen(false);
        props.onSelect(id);
      }}
    />
  );
}

function WhereText(props: React.ComponentProps<HappierWhereItsOnHost['Text']>): ReactElement {
  const typography = useOptionalHappierUiTypography();
  return (
    <HappierText
      variant={props.variant}
      tone={props.tone === 'primary' ? 'neutral' : props.tone === 'secondary' ? 'secondary' : 'muted'}
      {...(props.testID === undefined ? {} : { testID: props.testID })}
      {...(props.hidden ? { accessibilityElementsHidden: true, importantForAccessibility: 'no' as const } : {})}
      {...(props.tabular ? { tabularNumbers: true } : {})}
      style={[
        props.emphasis === 'semiBold'
          ? resolveHappierTextStepStyle(resolveHappierTypeScale(props.variant, Platform.OS, 'semiBold'), typography)
          : null,
        props.style ?? null,
      ]}
    >
      {props.children}
    </HappierText>
  );
}

function WhereAgentNames(props: React.ComponentProps<HappierWhereItsOnHost['AgentNames']>): ReactElement {
  const words = useContext(WhereWordsContext);
  const names = words ? words.joinList(words.names.agentNames(props.agentIds)) : props.agentIds.join(', ');
  return <WhereText variant="body" tone="secondary" testID={props.testID}>{names}</WhereText>;
}

/** The public components each slot draws with; the composition stays with the shared owner. */
const PUBLIC_WHERE_SLOTS: HappierWhereItsOnHost = {
  Section: ({ testID, title, description, children }) => (
    <ItemGroup testID={testID} title={title} {...(description === undefined ? {} : { description })}>
      {children}
    </ItemGroup>
  ),
  Disclosure: WhereDisclosure,
  Everywhere: ({ testID, title, subtitle, options, value, disabled, onChange }) => (
    <SettingRow
      testID={testID}
      title={title}
      hint={subtitle}
      layout="adaptive"
      disabled={disabled}
      control={
        <Select
          testID={`${testID}:choice`}
          label={title}
          presentation="segmented"
          options={options.map((option) => ({ value: option.id, label: option.label }))}
          value={value}
          disabled={disabled}
          onChange={(next) => onChange(next === 'on' ? 'on' : 'off')}
        />
      }
    />
  ),
  RuleList: ({ children }) => <>{children}</>,
  GroupLabel: ({ title }) => (
    <View style={WHERE_GROUP_LABEL}>
      <Text variant="meta" tone="secondary">
        {title}
      </Text>
    </View>
  ),
  Rule: ({ testID, title, subtitle, mark, wideControls, controls, note }) => (
    <Item
      testID={testID}
      title={title}
      subtitle={subtitle}
      icon={mark}
      showDivider={false}
      {...(controls === undefined ? {} : { accessory: controls, accessoryOutsidePressable: true, accessoryWraps: wideControls })}
    >
      {note}
    </Item>
  ),
  RemoveButton: ({ testID, accessibilityLabel, onPress }) => (
    <IconButton testID={testID} accessibilityLabel={accessibilityLabel} icon={<Icon name="close" size="small" tone="secondary" />} onPress={onPress} />
  ),
  AddMenu: WhereAddMenu,
  AgentSelect: ({ testID, accessibilityLabel, items, selectedId, onSelect }) => (
    <Select
      testID={testID}
      label={accessibilityLabel}
      presentation="field"
      options={items.map((item) => ({ value: item.id, label: item.title }))}
      value={selectedId}
      onChange={(next) => onSelect(String(next))}
    />
  ),
  ConsequenceRow: ({ testID, children }) => (
    <Item testID={testID} showDivider={false}>
      {children}
    </Item>
  ),
  ErrorLine: ({ testID, title, diagnostic, actionLabel, onAction }) => (
    <Banner
      testID={testID}
      tone="danger"
      title={title}
      description={diagnostic}
      action={<Button variant="secondary" size="small" title={actionLabel} onPress={onAction} />}
    />
  ),
  Text: WhereText,
  PlaceGlyph: ({ name, size }) => <Icon name={PLACE_ICON[name]} size={ICON_SIZE[size]} tone="secondary" />,
  AgentMark: () => null,
  AgentNames: WhereAgentNames,
  hasAgentMark: () => false,
};

const WHERE_GROUP_LABEL = {
  paddingHorizontal: HAPPIER_SPACE_STEPS.s16,
  paddingTop: HAPPIER_SPACE_STEPS.s12,
  paddingBottom: HAPPIER_SPACE_STEPS.s4,
} as const;

/**
 * "Where it's on" for a plugin's own installable things: the same sentence, Everywhere On | Off, rules and add menu
 * Happier's Skills and MCP pages use. The plugin passes where its item is on, already computed, and receives the
 * person's choice as an intent, which it applies to its own rules; no rule engine is needed or published.
 */
export function WhereItsOnControl(props: WhereItsOnControlProps): ReactElement {
  const translate = usePluginTranslation();
  const labels = useMemo(() => whereItsOnLabels(translate), [translate]);
  const { places } = props;
  const names = useMemo<HappierWhereItsOnNames>(() => {
    const agentName = (id: string) => places.agents.find((agent) => agent.id === id)?.name ?? id;
    return {
      agentName,
      agentNames: (ids) => [...new Set(ids.map(agentName))],
      machineName: (id) => places.machines.find((machine) => machine.id === id)?.name ?? id,
      projectName: (key) => places.projects?.find((project) => project.key === key)?.name ?? key,
      folderLabel: (_machineId, root) => root,
    };
  }, [places]);
  const controlPlaces = useMemo(
    () => ({
      agentIds: places.agents.map((agent) => agent.id),
      machines: places.machines.map((machine) => ({ machineId: machine.id, name: machine.name, online: machine.online })),
      projects: (places.projects ?? []).map((project) => ({
        projectKey: project.key,
        name: project.name,
        machineCount: project.machineCount,
      })),
    }),
    [places],
  );
  const state = useMemo(
    () => ({
      everywhere: props.everywhere,
      rules: props.rules.map(
        (rule): HappierWhereItsOnRuleState => ({
          place: rule.place,
          ...(rule.agentId === undefined ? {} : { agentId: rule.agentId }),
          on: rule.on,
        }),
      ),
    }),
    [props.everywhere, props.rules],
  );
  const { onIntent } = props;
  const handleIntent = useMemo(
    () =>
      async (intent: HappierWhereItsOnIntent): Promise<WhereItsOnIntentResult> => {
        const result: WhereItsOnIntentResult | void = await onIntent(intent);
        return result === undefined ? { ok: true } : result;
      },
    [onIntent],
  );
  const words = useMemo(() => ({ names, joinList: labels.joinList }), [names, labels]);
  return (
    <WhereWordsContext.Provider value={words}>
      <HappierWhereItsOnControl
        kind={props.kind}
        state={state}
        status={props.loading ? 'loading' : 'ready'}
        {...(props.availability === undefined ? {} : { projection: props.availability })}
        places={controlPlaces}
        onIntent={handleIntent}
        presentation={props.presentation ?? 'section'}
        {...(props.readOnlyReason === undefined ? {} : { readOnlyReason: props.readOnlyReason })}
        testID={props.testID}
        names={names}
        labels={labels}
        host={PUBLIC_WHERE_SLOTS}
      />
    </WhereWordsContext.Provider>
  );
}
