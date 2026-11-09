import * as React from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import { HAPPIER_SPACE_STEPS } from '../../environment/spacing.js';
import type { HappierPortableStyle } from '../portableTypes.js';
import { useHappierPageSection } from '../layout/PageSection.js';
import {
  describeHappierReach,
  describeHappierReachRule,
  foldHappierMachineNames,
  happierWhereItsOnAgentNames,
  sayHappierWhereItsOn,
  type HappierReachGrouped,
  type HappierReachPlace,
  type HappierReachRule,
  type HappierReachWrite,
  type HappierWhereItsOnItemKind,
  type HappierWhereItsOnLabels,
  type HappierWhereItsOnNames,
  type HappierWhereItsOnProjectionRow,
  type HappierWhereItsOnSentence,
} from './whereItsOn.js';

/**
 * One stated rule beside Everywhere: a place, optionally narrowed to one Agent, turned on or off there. `key` is the
 * rule's identity when the caller has one (it names the row's test ids); otherwise it is derived from the place.
 */
export type HappierWhereItsOnRuleState = Readonly<{
  key?: string;
  place: HappierReachPlace;
  agentId?: string | undefined;
  on: boolean;
}>;

/**
 * Where an item is on, already computed by whoever owns its rules: Everywhere On | Off, and the rules stated beside
 * it. `sentence` is the caller's when its rule engine prunes redundant rules; without one, every stated rule reads.
 */
export type HappierWhereItsOnState = Readonly<{
  everywhere: 'on' | 'off';
  rules: readonly HappierWhereItsOnRuleState[];
  sentence?: HappierWhereItsOnSentence;
}>;

/**
 * The person's choice, which the caller applies to its own rules: turn Everywhere on or off, add a place (or an
 * Agent everywhere) as on or off, remove a rule, or narrow a place turned on to one Agent (`to` absent: all Agents).
 */
export type HappierWhereItsOnIntent =
  | Readonly<{ kind: 'everywhere'; state: 'on' | 'off' }>
  | Readonly<{ kind: 'add'; place: HappierReachPlace; agentId?: string; state: 'on' | 'off' }>
  | Readonly<{ kind: 'remove'; place: HappierReachPlace; agentId?: string }>
  | Readonly<{ kind: 'narrow'; place: HappierReachPlace; from?: string; to?: string }>;

/** An intent as reach writes, for a caller whose rule engine applies writes (one write per changed rule). */
export function happierWhereItsOnIntentWrites(intent: HappierWhereItsOnIntent): readonly HappierReachWrite[] {
  const agent = (agentId: string | undefined) => (agentId === undefined ? {} : { agentId });
  switch (intent.kind) {
    case 'everywhere':
      return [{ place: { t: 'allMachines' }, state: intent.state }];
    case 'add':
      return [{ place: intent.place, ...agent(intent.agentId), state: intent.state }];
    case 'remove':
      return [{ place: intent.place, ...agent(intent.agentId), state: 'inherit' }];
    case 'narrow':
      return [
        { place: intent.place, ...agent(intent.from), state: 'inherit' },
        { place: intent.place, ...agent(intent.to), state: 'on' },
      ];
  }
}

function placeKey(place: HappierReachPlace): string {
  switch (place.t) {
    case 'allMachines':
      return 'all';
    case 'machine':
      return `machine:${place.machineId}`;
    case 'project':
      return `project:${place.projectKey}`;
    case 'workspace':
      return `workspace:${place.machineId}:${place.workspaceRoot}`;
  }
}
const ruleKey = (rule: HappierWhereItsOnRuleState) =>
  rule.key ?? `${placeKey(rule.place)}|${rule.agentId ?? '*'}`;

/** The state as rules the sentence words read (they read place, Agent and on/off only). */
function stateRules(state: HappierWhereItsOnState): readonly HappierReachRule[] {
  return [
    { id: 'everywhere', target: { t: 'allMachines' }, enabled: state.everywhere === 'on', createdAt: 0, updatedAt: 0 },
    ...state.rules.map((rule): HappierReachRule => ({
      id: ruleKey(rule),
      target: rule.place,
      ...(rule.agentId !== undefined ? { agentId: rule.agentId } : {}),
      enabled: rule.on,
      createdAt: 0,
      updatedAt: 0,
    })),
  ];
}

/** Without an engine every stated rule reads: a plain partition by Agent and on/off. */
function statedGroups(rules: readonly HappierReachRule[]): HappierReachGrouped {
  const base = rules.find((rule) => rule.target.t === 'allMachines' && rule.agentId === undefined);
  const split = (items: readonly HappierReachRule[]) => ({
    turnedOnIn: items.filter((rule) => rule.target.t !== 'allMachines' && rule.enabled),
    except: items.filter((rule) => rule.target.t !== 'allMachines' && !rule.enabled),
  });
  const agentIds = [...new Set(rules.flatMap((rule) => (rule.agentId === undefined ? [] : [rule.agentId])))];
  return {
    base: base ? (base.enabled ? 'on' : 'off') : 'none',
    ...split(rules.filter((rule) => rule.agentId === undefined)),
    agents: agentIds.map((agentId) => {
      const items = rules.filter((rule) => rule.agentId === agentId);
      const everywhere = items.find((rule) => rule.target.t === 'allMachines');
      return { agentId, everywhere: everywhere ? (everywhere.enabled ? 'on' : 'off') : null, ...split(items) };
    }),
  };
}

const samePlace = (left: HappierReachPlace, right: HappierReachPlace) => placeKey(left) === placeKey(right);

export type HappierWhereItsOnChangeResult =
  | Readonly<{ ok: true }>
  | Readonly<{ ok: false; message: string }>;

export type HappierWhereItsOnPlaces = Readonly<{
  agentIds: readonly string[];
  machines: readonly Readonly<{
    machineId: string;
    name: string;
    online: boolean | null;
  }>[];
  projects: readonly Readonly<{
    projectKey: string;
    name: string;
    machineCount: number;
  }>[];
}>;

/** The control's own words, beside the sentence words (`HappierWhereItsOnLabels`). */
export type HappierWhereItsOnControlLabels = HappierWhereItsOnLabels &
  Readonly<{
    control: Readonly<{
      title: () => string;
      description: () => string;
      on: () => string;
      off: () => string;
      turnedOnIn: () => string;
      except: () => string;
      nowhereYet: () => string;
      addException: () => string;
      addPlace: () => string;
      menuAgent: () => string;
      menuAgentEverywhere: () => string;
      menuMachine: () => string;
      menuProject: () => string;
      menuProjectEverywhere: () => string;
      /** A machine whose reachability is known to be offline. */
      offline: () => string;
      /** A machine whose reachability is not known yet. */
      unknown: () => string;
      machineCount: (count: number) => string;
      allAgents: () => string;
      agentOnly: (agent: string) => string;
      whichAgents: (place: string) => string;
      remove: (target: string) => string;
      staysOff: (agents: string) => string;
      change: () => string;
      changeFailed: () => string;
      /** The consequence line while the machines' Agents are not known yet. */
      checking: () => string;
      tryAgain: () => string;
    }>;
  }>;

type TextTone = 'primary' | 'secondary' | 'tertiary';
export type HappierWhereItsOnTextProps = Readonly<{
  variant: 'label' | 'body' | 'meta';
  tone: TextTone;
  emphasis?: 'semiBold';
  tabular?: boolean;
  /** Decorative (a separator dot). */
  hidden?: boolean;
  style?: Pick<HappierPortableStyle, 'flexShrink' | 'paddingHorizontal' | 'paddingBottom' | 'whiteSpace'>;
  testID?: string;
  children?: React.ReactNode;
}>;

/** A choice in an add or Agent menu; its mark is an Agent's identity or a place glyph. */
export type HappierWhereItsOnMenuItem = Readonly<{
  id: string;
  title: string;
  testID: string;
  mark?:
    | Readonly<{ kind: 'agent'; agentId: string }>
    | Readonly<{ kind: 'icon'; name: 'desktop' | 'folder' }>;
  /** Quiet meta after the title ("offline", "2 machines"). */
  trailing?: Readonly<{ text: string; tabular?: boolean }>;
  checked?: boolean;
}>;

/**
 * The primitives the control draws with. Happier binds its own settings primitives; the public adapter binds the
 * public plugin components. The composition (what is shown, in which order, what each control writes) stays here.
 */
export type HappierWhereItsOnHost = Readonly<{
  /** A page section: title, an optional description above one sheet. */
  Section: React.ComponentType<
    Readonly<{
      testID: string;
      title: string;
      description?: string;
      children: React.ReactNode;
    }>
  >;
  /** The sentence row, which opens the rules in place; `changeLabel` replaces the caret while closed (add flows). */
  Disclosure: React.ComponentType<
    Readonly<{
      testID: string;
      rowTestID: string;
      /** The section injects its row divider; the sentence row draws none (the consequence continues it). */
      showDivider?: boolean;
      expanded: boolean;
      onExpandedChange: (expanded: boolean) => void;
      title: React.ReactNode;
      changeLabel?: string;
      children: React.ReactNode;
    }>
  >;
  /** The Everywhere On | Off row. */
  Everywhere: React.ComponentType<
    Readonly<{
      testID: string;
      title: string;
      subtitle: string;
      options: readonly Readonly<{ id: 'on' | 'off'; label: string }>[];
      value: 'on' | 'off';
      disabled: boolean;
      onChange: (value: 'on' | 'off') => void;
    }>
  >;
  /** The rule rows' own list, so their marks align their titles. */
  RuleList: React.ComponentType<Readonly<{ children: React.ReactNode }>>;
  GroupLabel: React.ComponentType<Readonly<{ title: string }>>;
  /** A rule: its mark, title, effect, its controls and a note under it. */
  Rule: React.ComponentType<
    Readonly<{
      testID: string;
      title: string;
      subtitle: string;
      mark: React.ReactNode;
      /** The controls move beneath the label on a phone (the Agent select is wide). */
      wideControls: boolean;
      controls?: React.ReactNode;
      note?: React.ReactNode;
    }>
  >;
  RemoveButton: React.ComponentType<
    Readonly<{
      testID: string;
      accessibilityLabel: string;
      onPress: () => void;
    }>
  >;
  /** "Add an exception": a section action that opens a menu of grouped choices. */
  AddMenu: React.ComponentType<
    Readonly<{
      testID: string;
      title: string;
      groups: readonly Readonly<{
        title: string;
        items: readonly HappierWhereItsOnMenuItem[];
      }>[];
      onSelect: (id: string) => void;
    }>
  >;
  /** A place rule's "All agents | Claude only" field select. */
  AgentSelect: React.ComponentType<
    Readonly<{
      testID: string;
      label: string;
      accessibilityLabel: string;
      selectedAgentId: string | null;
      items: readonly HappierWhereItsOnMenuItem[];
      selectedId: string;
      onSelect: (id: string) => void;
    }>
  >;
  /** The consequence's row: it continues the sentence's row while the rules are closed. */
  ConsequenceRow: React.ComponentType<
    Readonly<{
      testID: string;
      continuesRow: boolean;
      showDivider: boolean;
      children: React.ReactNode;
    }>
  >;
  ErrorLine: React.ComponentType<
    Readonly<{
      testID: string;
      showDivider?: boolean;
      title: string;
      diagnostic: string;
      actionLabel: string;
      onAction: () => void;
    }>
  >;
  Text: React.ComponentType<HappierWhereItsOnTextProps>;
  /** A place glyph inline in the sentence ("[folder] client-site"). */
  PlaceGlyph: React.ComponentType<
    Readonly<{ name: 'desktop' | 'folder'; size: 'xs' | 'sm' | 'md' }>
  >;
  /** An Agent's identity mark; null when the Agent has no known identity. */
  AgentMark: React.ComponentType<
    Readonly<{ agentId: string; size: 'xs' | 'sm' | 'md' }>
  >;
  /** The available Agents in the consequence sentence, as names (with marks when the caller has them). */
  AgentNames: React.ComponentType<
    Readonly<{
      agentIds: readonly string[];
      machines: readonly Readonly<{
        machineId: string;
        agentIds: readonly string[];
      }>[];
      testID: string;
    }>
  >;
  /** Whether an Agent has an identity mark (rules for an Agent everywhere draw it instead of a place glyph). */
  hasAgentMark: (agentId: string) => boolean;
}>;

export type HappierWhereItsOnControlProps = Readonly<{
  kind: HappierWhereItsOnItemKind;
  state: HappierWhereItsOnState;
  status: 'ready' | 'loading' | 'unavailable';
  /**
   * The rules' live reach per machine; null while resolving (the consequence keeps its slot). Undefined: the
   * caller has no reach to report, and no consequence line is drawn.
   */
  projection?: readonly HappierWhereItsOnProjectionRow[] | null;
  /** What "Add an exception" / "Add a place" offers; `online` is the caller's reachability. */
  places: HappierWhereItsOnPlaces;
  /** Which Agents can take this item. Absent: every Agent takes it. */
  agentTakes?: (agentId: string) => 'full' | 'index' | 'none';
  /** The person's choice; the caller applies it to its rules. A failed result keeps the choice for Try again. */
  onIntent: (
    intent: HappierWhereItsOnIntent,
  ) => Promise<HappierWhereItsOnChangeResult>;
  /** 'section': a detail page's section (the closed sentence opens in place). 'pick': the compact form in add flows. */
  presentation: 'section' | 'pick';
  /** Why the viewer cannot edit; keeps the sentence and the consequence, drops every control. */
  readOnlyReason?: string;
  testID: string;
  names: HappierWhereItsOnNames;
  labels: HappierWhereItsOnControlLabels;
  host: HappierWhereItsOnHost;
  /** The caller's spacing steps (a compact density tightens them). */
  space?: Readonly<Record<'s4' | 's8' | 's12' | 's16', number>>;
}>;

const takesEverything = () => 'full' as const;
const PLACE_RANK: Record<HappierReachPlace['t'], number> = {
  allMachines: 0,
  machine: 1,
  project: 2,
  workspace: 3,
};

/** Every Agent the control may name: the offered ones, the ones rules name, and the ones the projection reports. */
export function collectHappierWhereItsOnAgentIds(
  agentIds: readonly string[],
  rules: readonly Readonly<{ agentId?: string | undefined }>[],
  projection: readonly HappierWhereItsOnProjectionRow[] | null | undefined,
): readonly string[] {
  const ids = new Set<string>(agentIds);
  for (const rule of rules)
    if (rule.agentId !== undefined) ids.add(rule.agentId);
  for (const row of projection ?? [])
    for (const agent of row.agents) ids.add(agent.agentId);
  return [...ids];
}

/** "On everywhere · except Gemini · except in [folder] client-site": the head emphasised, a project carrying its glyph. */
function SentenceText(
  props: Readonly<{
    sentence: HappierWhereItsOnSentence;
    names: HappierWhereItsOnNames;
    host: HappierWhereItsOnHost;
    testID: string;
  }>,
) {
  const { Text, PlaceGlyph } = props.host;
  const withPlaceGlyph = (
    text: string,
    place: HappierReachPlace | undefined,
    key: string,
  ) => {
    if (!place || (place.t !== 'project' && place.t !== 'workspace'))
      return text;
    const name =
      place.t === 'project'
        ? props.names.projectName(place.projectKey)
        : props.names.folderLabel(place.machineId, place.workspaceRoot);
    const at = text.lastIndexOf(name);
    if (at < 0) return text;
    return (
      <React.Fragment key={key}>
        {text.slice(0, at)}
        <PlaceGlyph name="folder" size="xs" />
        {` ${text.slice(at)}`}
      </React.Fragment>
    );
  };
  return (
    <Text
      variant="label"
      tone="primary"
      testID={props.testID}
      style={SENTENCE}
    >
      <Text variant="label" tone="primary" emphasis="semiBold">
        {withPlaceGlyph(
          props.sentence.head,
          props.sentence.headStatement?.place,
          'head',
        )}
      </Text>
      {props.sentence.clauses.map((clause, index) => (
        <Text key={index} variant="label" tone="secondary">
          <Text variant="label" tone="tertiary" hidden>
            {'  ·  '}
          </Text>
          {withPlaceGlyph(clause.text, clause.place, `c${index}`)}
        </Text>
      ))}
    </Text>
  );
}

const NAME_OPEN = '\u0003';
const NAME_CLOSE = '\u0004';
// Web only (the text is CSS): a name is one unit, so the sentence wraps before it, never inside it. A name wider
// than the line (a generated host name) breaks inside its own box rather than running out of the card.
// The portable style has no inline-block or overflow-wrap; react-native-web still receives them.
const WHOLE_NAME = Platform.select<NonNullable<HappierWhereItsOnTextProps['style']>>({
  web: { display: 'inline-block', maxWidth: '100%', overflowWrap: 'anywhere' } as unknown as NonNullable<HappierWhereItsOnTextProps['style']>,
});

/** "Available to [Claude], [Codex] and [OpenCode] on MacBook Pro and nl2", then the notes. */
function ConsequenceLine(
  props: Readonly<{
    kind: HappierWhereItsOnItemKind;
    projection: readonly HappierWhereItsOnProjectionRow[] | null;
    machines: HappierWhereItsOnPlaces['machines'];
    names: HappierWhereItsOnNames;
    labels: HappierWhereItsOnControlLabels;
    host: HappierWhereItsOnHost;
    agentTakes: (agentId: string) => 'full' | 'index' | 'none';
    /** Whether any rule turns the item on. With none, it is known to be available nowhere, whatever machines report. */
    anyRuleOn: boolean;
    gap: number;
    testID: string;
  }>,
) {
  const { Text, AgentNames } = props.host;
  const machines = React.useMemo(
    () =>
      props.projection?.map((row) => ({
        machineId: row.machineId,
        agentIds: row.agents
          .filter((agent) => agent.enabled)
          .map((agent) => agent.agentId),
      })) ?? [],
    [props.projection],
  );
  const consequence =
    props.projection === null
      ? null
      : describeHappierReach(
          props.projection,
          props.machines,
          props.names,
          props.agentTakes,
          props.kind,
          props.labels,
        );
  if (
    consequence === null ||
    (consequence.availabilityUnknown && props.anyRuleOn)
  ) {
    return (
      <Text variant="body" tone="secondary" testID={props.testID}>
        {props.labels.control.checking()}
      </Text>
    );
  }
  const nowhere =
    consequence.availableAgentIds.length === 0 ||
    consequence.onlineMachineNames.length === 0;
  // The sentence is the caller's translation; the Agent names inside it are drawn by the host (with their marks).
  const marker = '\u0002';
  const [before, after] = props.labels.where
    .available({
      agents: marker,
      machines: props.labels.joinList(
        foldHappierMachineNames(
          consequence.onlineMachineNames,
          props.labels,
        ).map((name) => `${NAME_OPEN}${name}${NAME_CLOSE}`),
      ),
      ...(consequence.onlyProjectNames.length
        ? { projects: props.labels.joinList(consequence.onlyProjectNames) }
        : {}),
    })
    .split(marker);
  const withWholeNames = (text: string): React.ReactNode =>
    text
      .split(new RegExp(`${NAME_OPEN}(.*?)${NAME_CLOSE}`))
      .map((part, index) =>
        index % 2 === 1 ? (
          <Text
            key={index}
            variant="body"
            tone="secondary"
            {...(WHOLE_NAME ? { style: WHOLE_NAME } : {})}
          >
            {part}
          </Text>
        ) : (
          part
        ),
      );
  return (
    <View testID={props.testID} style={{ gap: props.gap }} aria-live="polite">
      {nowhere ? (
        <Text variant="body" tone="secondary">
          {props.labels.where.availableNowhere()}
        </Text>
      ) : (
        <Text variant="body" tone="secondary">
          {withWholeNames(before ?? '')}
          <AgentNames
            agentIds={consequence.availableAgentIds}
            machines={machines}
            testID={`${props.testID}:agents`}
          />
          {withWholeNames(after ?? '')}
        </Text>
      )}
      {consequence.notes.map((note) => (
        <Text key={note} variant="meta" tone="tertiary">
          {note}
        </Text>
      ))}
    </View>
  );
}

/** The sheet's own row hairline, full width, where the disclosure body ends. */
function SheetHairline() {
  const pageSection = useHappierPageSection();
  return (
    <View
      style={[
        HAIRLINE,
        pageSection ? { backgroundColor: pageSection.rowDividerColor } : null,
      ]}
    />
  );
}

/**
 * "Where it's on" (Capabilities D18): the sentence, which opens in place into Everywhere On | Off, the rules under
 * "Turned on in" and "Except", and one add menu; the live consequence underneath. The caller passes the computed
 * state and applies the person's choice (an intent) to its own rules; words come only from `whereItsOn`.
 */
export const HappierWhereItsOnControl = React.memo(
  function HappierWhereItsOnControl(props: HappierWhereItsOnControlProps) {
    const { names, labels, host, state } = props;
    const words = labels.control;
    const space = props.space ?? HAPPIER_SPACE_STEPS;
    const [expanded, setExpanded] = React.useState(false);
    const [failure, setFailure] = React.useState<Readonly<{
      intent: HappierWhereItsOnIntent;
      message: string;
    }> | null>(null);
    const editable =
      props.readOnlyReason === undefined && props.status === 'ready';

    const sentence = React.useMemo(
      () =>
        state.sentence ??
        sayHappierWhereItsOn(stateRules(state), names, labels, statedGroups),
      [state, names, labels],
    );
    const baseOn = state.everywhere === 'on';
    // Broadest first (an Agent everywhere, then machines, projects, folders), as the sentence reads them.
    const ruleRows = state.rules
      .filter((rule) => !(rule.place.t === 'allMachines' && rule.agentId === undefined))
      .sort((left, right) => PLACE_RANK[left.place.t] - PLACE_RANK[right.place.t]);
    const onRows = ruleRows.filter((rule) => rule.on);
    const offRows = ruleRows.filter((rule) => !rule.on);
    const exceptedAgentIds = offRows
      .filter((rule) => rule.place.t === 'allMachines' && rule.agentId !== undefined)
      .map((rule) => rule.agentId!);

    const { onIntent } = props;
    const commit = React.useCallback(
      async (intent: HappierWhereItsOnIntent) => {
        setFailure(null);
        const result = await onIntent(intent);
        if (!result.ok) setFailure({ intent, message: result.message });
      },
      [onIntent],
    );
    const choose = React.useCallback(
      (intent: HappierWhereItsOnIntent) => {
        void commit(intent);
      },
      [commit],
    );

    const addGroups = React.useMemo(() => {
      const has = (place: HappierReachPlace, agentId?: string) =>
        state.rules.some(
          (rule) => rule.agentId === agentId && samePlace(rule.place, place),
        );
      const agentItems = props.places.agentIds
        .filter((agentId) => !has({ t: 'allMachines' }, agentId))
        .map((agentId): HappierWhereItsOnMenuItem => ({
          id: `agent:${agentId}`,
          title: names.agentName(agentId),
          testID: `${props.testID}:add:agent:${agentId}`,
          ...(host.hasAgentMark(agentId)
            ? { mark: { kind: 'agent', agentId } }
            : {}),
        }));
      const machineItems = props.places.machines
        .filter(
          (machine) => !has({ t: 'machine', machineId: machine.machineId }),
        )
        .map((machine): HappierWhereItsOnMenuItem => ({
          id: `machine:${machine.machineId}`,
          title: machine.name,
          testID: `${props.testID}:add:machine:${machine.machineId}`,
          mark: { kind: 'icon', name: 'desktop' },
          ...(machine.online
            ? {}
            : {
                trailing: {
                  text:
                    machine.online === false
                      ? words.offline()
                      : words.unknown(),
                },
              }),
        }));
      const projectItems = props.places.projects
        .filter(
          (project) => !has({ t: 'project', projectKey: project.projectKey }),
        )
        .map((project): HappierWhereItsOnMenuItem => ({
          id: `project:${project.projectKey}`,
          title: project.name,
          testID: `${props.testID}:add:project:${project.projectKey}`,
          mark: { kind: 'icon', name: 'folder' },
          trailing: {
            text: words.machineCount(project.machineCount),
            tabular: true,
          },
        }));
      // Under On everywhere the commonest exception is an Agent; under Off, a project (it follows you to every machine).
      const groups = baseOn
        ? [
            { title: words.menuAgent(), items: agentItems },
            { title: words.menuMachine(), items: machineItems },
            { title: words.menuProject(), items: projectItems },
          ]
        : [
            { title: words.menuProjectEverywhere(), items: projectItems },
            { title: words.menuMachine(), items: machineItems },
            { title: words.menuAgentEverywhere(), items: agentItems },
          ];
      return groups.filter((group) => group.items.length > 0);
    }, [state.rules, props.places, names, baseOn, props.testID, host, words]);

    const onAdd = React.useCallback(
      (itemId: string) => {
        const [kindOfPlace, ...rest] = itemId.split(':');
        const id = rest.join(':');
        const turn = baseOn ? ('off' as const) : ('on' as const);
        if (kindOfPlace === 'agent')
          choose({ kind: 'add', place: { t: 'allMachines' }, agentId: id, state: turn });
        else if (kindOfPlace === 'machine')
          choose({ kind: 'add', place: { t: 'machine', machineId: id }, state: turn });
        else if (kindOfPlace === 'project')
          choose({ kind: 'add', place: { t: 'project', projectKey: id }, state: turn });
      },
      [baseOn, choose],
    );

    const {
      Rule,
      RemoveButton,
      AgentSelect,
      GroupLabel,
      Text,
      AgentMark,
      PlaceGlyph,
    } = host;
    const ruleRow = (row: HappierWhereItsOnRuleState) => {
      const rule = {
        target: row.place,
        ...(row.agentId !== undefined ? { agentId: row.agentId } : {}),
        enabled: row.on,
      };
      const described = describeHappierReachRule(
        rule,
        names,
        props.kind,
        labels,
      );
      const key = ruleKey(row);
      const testID = `${props.testID}:rule:${key}`;
      // A place turned on can be narrowed to one Agent; the select swaps the qualifier in one change.
      const narrowable = rule.enabled && rule.target.t !== 'allMachines';
      const placeTitle =
        rule.target.t === 'allMachines'
          ? described.title
          : rule.target.t === 'machine'
            ? names.machineName(rule.target.machineId)
            : rule.target.t === 'project'
              ? names.projectName(rule.target.projectKey)
              : names.projectName(rule.target.machineId);
      let agentSelect: React.ReactNode = null;
      if (narrowable && editable) {
        const selected = rule.agentId ?? null;
        const allId = '*';
        agentSelect = (
          <AgentSelect
            testID={`${testID}:agents`}
            label={
              selected === null
                ? words.allAgents()
                : words.agentOnly(names.agentName(selected))
            }
            accessibilityLabel={words.whichAgents(placeTitle)}
            selectedAgentId={
              selected !== null && host.hasAgentMark(selected) ? selected : null
            }
            selectedId={selected ?? allId}
            items={[
              {
                id: allId,
                title: words.allAgents(),
                checked: selected === null,
                testID: `${testID}:agents:all`,
              },
              ...props.places.agentIds.map(
                (agentId): HappierWhereItsOnMenuItem => ({
                  id: agentId,
                  title: names.agentName(agentId),
                  checked: selected === agentId,
                  testID: `${testID}:agents:${agentId}`,
                  ...(host.hasAgentMark(agentId)
                    ? { mark: { kind: 'agent', agentId } }
                    : {}),
                }),
              ),
            ]}
            onSelect={(id) => {
              if (id === (selected ?? allId)) return;
              choose({
                kind: 'narrow',
                place: rule.target,
                ...(rule.agentId ? { from: rule.agentId } : {}),
                ...(id === allId ? {} : { to: id }),
              });
            }}
          />
        );
      }
      const remove = editable ? (
        <RemoveButton
          testID={`${testID}:remove`}
          accessibilityLabel={words.remove(described.title)}
          onPress={() =>
            choose({
              kind: 'remove',
              place: rule.target,
              ...(rule.agentId ? { agentId: rule.agentId } : {}),
            })
          }
        />
      ) : null;
      // A place turned on for all agents never re-enables an excepted Agent there; say so under the row.
      const staysOff =
        rule.enabled &&
        rule.agentId === undefined &&
        rule.target.t !== 'allMachines'
          ? exceptedAgentIds.filter(
              (agentId) =>
                !state.rules.some(
                  (other) =>
                    other.agentId === agentId &&
                    other.on &&
                    samePlace(other.place, rule.target),
                ),
            )
          : [];
      const mark =
        rule.target.t === 'allMachines' &&
        rule.agentId !== undefined &&
        host.hasAgentMark(rule.agentId) ? (
          <AgentMark agentId={rule.agentId} size="md" />
        ) : (
          <PlaceGlyph
            name={rule.target.t === 'machine' ? 'desktop' : 'folder'}
            size="md"
          />
        );
      return (
        <Rule
          key={key}
          testID={testID}
          title={
            rule.agentId !== undefined && rule.target.t !== 'allMachines'
              ? placeTitle
              : described.title
          }
          subtitle={described.effect}
          mark={mark}
          wideControls={agentSelect !== null}
          {...(agentSelect || remove
            ? {
                controls: (
                  <View style={[RULE_CONTROLS, { gap: space.s8 }]}>
                    {agentSelect}
                    {remove}
                  </View>
                ),
              }
            : {})}
          {...(staysOff.length > 0
            ? {
                note: (
                  <Text
                    variant="meta"
                    tone="tertiary"
                    testID={`${testID}:staysOff`}
                  >
                    {words.staysOff(labels.joinList(happierWhereItsOnAgentNames(staysOff, names)))}
                  </Text>
                ),
              }
            : {})}
        />
      );
    };

    const group = (title: string, rows: readonly HappierWhereItsOnRuleState[], key: string) =>
      rows.length === 0 ? null : (
        <View key={key} testID={`${props.testID}:${key}`}>
          <GroupLabel title={title} />
          {rows.map(ruleRow)}
        </View>
      );

    const quietInset = {
      paddingHorizontal: space.s16,
      paddingBottom: space.s8,
    };
    const body = (
      <View testID={`${props.testID}:body`}>
        <SheetHairline />
        <host.Everywhere
          testID={`${props.testID}:everywhere`}
          title={labels.where.everywhere()}
          subtitle={
            baseOn
              ? labels.where.effect.everywhereOn()
              : labels.where.effect.everywhereOff()
          }
          options={[
            { id: 'on', label: words.on() },
            { id: 'off', label: words.off() },
          ]}
          value={baseOn ? 'on' : 'off'}
          disabled={!editable}
          onChange={(next) => choose({ kind: 'everywhere', state: next })}
        />
        {/* The rules are their own list: their marks align the rule titles without moving the sentence or Everywhere. */}
        <host.RuleList>
          {baseOn
            ? [
                group(words.except(), offRows, 'except'),
                group(words.turnedOnIn(), onRows, 'turnedOnIn'),
              ]
            : [
                group(words.turnedOnIn(), onRows, 'turnedOnIn'),
                group(words.except(), offRows, 'except'),
              ]}
          {!baseOn && onRows.length === 0 ? (
            <View>
              <GroupLabel title={words.turnedOnIn()} />
              <Text
                variant="body"
                tone="secondary"
                style={quietInset}
                testID={`${props.testID}:nowhere`}
              >
                {words.nowhereYet()}
              </Text>
            </View>
          ) : null}
        </host.RuleList>
        {editable && addGroups.length > 0 ? (
          <View
            style={[
              ADD,
              {
                paddingHorizontal: space.s12,
                paddingTop: space.s4,
                paddingBottom: space.s12,
              },
            ]}
          >
            <host.AddMenu
              testID={`${props.testID}:add`}
              title={baseOn ? words.addException() : words.addPlace()}
              groups={addGroups}
              onSelect={onAdd}
            />
          </View>
        ) : props.readOnlyReason !== undefined ? (
          <Text
            variant="meta"
            tone="tertiary"
            style={quietInset}
            testID={`${props.testID}:readOnly`}
          >
            {props.readOnlyReason}
          </Text>
        ) : null}
        <SheetHairline />
      </View>
    );

    return (
      <host.Section
        testID={props.testID}
        title={words.title()}
        {...(props.presentation === 'section'
          ? { description: words.description() }
          : {})}
      >
        <host.Disclosure
          testID={`${props.testID}:disclosure`}
          rowTestID={`${props.testID}:sentence`}
        showDivider={false}
          expanded={expanded}
          onExpandedChange={setExpanded}
          title={
            <SentenceText
              sentence={sentence}
              names={names}
              host={host}
              testID={`${props.testID}:sentenceText`}
            />
          }
          {...(props.presentation === 'pick'
            ? { changeLabel: words.change() }
            : {})}
        >
          {expanded ? body : null}
        </host.Disclosure>
        {props.projection === undefined ? null : (
        <host.ConsequenceRow
          testID={`${props.testID}:consequenceRow`}
          showDivider={failure !== null}
          // Closed, the consequence finishes the sentence's row (one card); open, it follows the rules.
          continuesRow={!expanded}
        >
          <ConsequenceLine
            kind={props.kind}
            projection={props.projection}
            machines={props.places.machines}
            names={names}
            labels={labels}
            host={host}
            agentTakes={props.agentTakes ?? takesEverything}
            anyRuleOn={baseOn || state.rules.some((rule) => rule.on)}
            gap={space.s4}
            testID={`${props.testID}:consequence`}
          />
        </host.ConsequenceRow>
        )}
        {failure ? (
          <host.ErrorLine
            testID={`${props.testID}:error`}
            title={words.changeFailed()}
            diagnostic={failure.message}
            actionLabel={words.tryAgain()}
            onAction={() => void commit(failure.intent)}
          />
        ) : null}
      </host.Section>
    );
  },
);

const SENTENCE = { flexShrink: 1 } as const;
const HAIRLINE = { height: StyleSheet.hairlineWidth } as const;
const RULE_CONTROLS = { flexDirection: 'row', alignItems: 'center' } as const;
const ADD = { alignItems: 'flex-start' } as const;
