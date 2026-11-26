import {
  Fragment,
  type ComponentType,
  type ReactElement,
  type ReactNode,
} from 'react';
import { View } from 'react-native';

/**
 * The one owner of a capability's source · trust · cost facts, for list rows and entity headers alike, shared by
 * Happier and plugins. The caller supplies the words and draws the glyphs in its own icon vocabulary; this module
 * decides which facts exist, their order, which carry weight, and how a row lays them out on one line.
 */

export type HappierCapabilitySource =
  | Readonly<{ kind: 'you' }>
  | Readonly<{ kind: 'happier' }>
  | Readonly<{ kind: 'git'; label: string; ref?: string }>
  | Readonly<{ kind: 'registry'; label: string; mark?: ReactNode }>
  | Readonly<{ kind: 'machine'; machineName: string }>
  | Readonly<{ kind: 'plugin'; pluginName: string; mark?: ReactNode }>
  | Readonly<{ kind: 'link'; host: string }>;

/** What installing it can do: read text, bring files, or run scripts (the one trust fact with weight). */
export type HappierCapabilityTrust = 'text_only' | 'has_files' | 'runs_scripts';

export type HappierCapabilityCost = Readonly<{
  /** Skills: tokens the body costs when an agent loads it. */
  tokensWhenUsed?: number;
  /** MCP: tools exposed and their schema tokens every turn. */
  toolCount?: number;
  tokensPerTurn?: number;
  /** MCP: agents search the tools when they need one, so they add nothing to each turn. */
  onDemand?: boolean;
}>;

export type HappierCapabilityFactsInput = Readonly<{
  source?: HappierCapabilitySource;
  trust?: HappierCapabilityTrust;
  cost?: HappierCapabilityCost;
  /** Extra facts after cost ("Remote", "via skills.sh"); a path or id is drawn in mono. */
  extra?: readonly (string | Readonly<{ text: string; mono: true }>)[];
}>;

/** A glyph the caller draws from its own icon set; registry and plugin sources bring their own `mark`. */
export type HappierCapabilityFactGlyph =
  | 'you'
  | 'git'
  | 'machine'
  | 'link'
  | HappierCapabilityTrust;

export type HappierCapabilityFact = Readonly<{
  key: string;
  text: string;
  glyph?: HappierCapabilityFactGlyph;
  mark?: ReactNode;
  mono?: boolean;
  strong?: boolean;
}>;

export type HappierCapabilityFactsLabels = Readonly<{
  you: () => string;
  happier: () => string;
  trust: (trust: HappierCapabilityTrust) => string;
  /** `shown` is the compact count ("1.2k"); `count` picks the plural. */
  toolCount: (count: number, shown: string) => string;
  tokensPerTurn: (shown: string) => string;
  tokensWhenUsed: (shown: string) => string;
  /** How an On demand server reaches agents; leads its cost facts as a word. */
  onDemand: () => string;
}>;

/** The one compact number for tool counts and token costs ("1.2k"), wherever a capability states them. */
export function formatHappierCapabilityCount(value: number): string {
  return new Intl.NumberFormat(undefined, {
    notation: 'compact',
    maximumFractionDigits: 1,
  })
    .format(value)
    .toLowerCase();
}

function sourceFact(
  source: HappierCapabilitySource,
  labels: HappierCapabilityFactsLabels,
): HappierCapabilityFact {
  switch (source.kind) {
    case 'you':
      return { key: 'source', text: labels.you(), glyph: 'you' };
    case 'happier':
      return { key: 'source', text: labels.happier() };
    case 'git':
      return { key: 'source', text: source.label, glyph: 'git' };
    case 'registry':
      return {
        key: 'source',
        text: source.label,
        ...(source.mark === undefined ? {} : { mark: source.mark }),
      };
    case 'machine':
      return { key: 'source', text: source.machineName, glyph: 'machine' };
    case 'plugin':
      return {
        key: 'source',
        text: source.pluginName,
        ...(source.mark === undefined ? {} : { mark: source.mark }),
      };
    case 'link':
      return { key: 'source', text: source.host, glyph: 'link' };
  }
}

export function buildHappierCapabilityFacts(
  input: HappierCapabilityFactsInput,
  labels: HappierCapabilityFactsLabels,
): readonly HappierCapabilityFact[] {
  const facts: HappierCapabilityFact[] = [];
  if (input.source !== undefined) facts.push(sourceFact(input.source, labels));
  // "Runs scripts" is the one trust fact that carries weight; the quieter two stay muted.
  if (input.trust !== undefined)
    facts.push({
      key: 'trust',
      text: labels.trust(input.trust),
      glyph: input.trust,
      strong: input.trust === 'runs_scripts',
    });
  const cost = input.cost;
  if (cost?.onDemand === true) facts.push({ key: 'delivery', text: labels.onDemand() });
  if (cost?.toolCount !== undefined)
    facts.push({
      key: 'tools',
      text: labels.toolCount(
        cost.toolCount,
        formatHappierCapabilityCount(cost.toolCount),
      ),
    });
  // On demand already says what a turn carries (nothing); its 0 still counts toward the per-turn total.
  if (cost?.tokensPerTurn !== undefined && cost.onDemand !== true)
    facts.push({
      key: 'tokensPerTurn',
      text: labels.tokensPerTurn(
        formatHappierCapabilityCount(cost.tokensPerTurn),
      ),
    });
  if (cost?.tokensWhenUsed !== undefined)
    facts.push({
      key: 'tokens',
      text: labels.tokensWhenUsed(
        formatHappierCapabilityCount(cost.tokensWhenUsed),
      ),
    });
  for (const [index, extra] of (input.extra ?? []).entries())
    facts.push(
      typeof extra === 'string'
        ? { key: `extra:${index}`, text: extra }
        : { key: `extra:${index}`, text: extra.text, mono: true },
    );
  return facts;
}

/** The same facts as an entity header's meta line (a pinned git source names its ref). */
export function buildHappierCapabilityHeaderFacts(
  input: HappierCapabilityFactsInput,
  labels: HappierCapabilityFactsLabels,
): readonly HappierCapabilityFact[] {
  return buildHappierCapabilityFacts(input, labels).map((fact) =>
    fact.key === 'source' &&
    input.source?.kind === 'git' &&
    input.source.ref !== undefined
      ? { ...fact, text: `${fact.text} @${input.source.ref}` }
      : fact,
  );
}

export type HappierCapabilityFactsTextProps = Readonly<{
  /** `line`: the one truncating line; `separator`: the middle dot; `fact`: one fact's words; `glyph`: an icon's line box. */
  role: 'line' | 'separator' | 'fact' | 'glyph';
  strong?: boolean;
  mono?: boolean;
  numberOfLines?: number;
  'aria-hidden'?: boolean;
  children: ReactNode;
}>;

export type HappierCapabilityFactsProps = Readonly<{
  facts: readonly HappierCapabilityFact[];
  Text: ComponentType<HappierCapabilityFactsTextProps>;
  renderGlyph: (glyph: HappierCapabilityFactGlyph) => ReactNode;
  testID?: string;
}>;

/** One quiet line that truncates at its end: facts separated by middle dots, a glyph or mark before each. */
export function HappierCapabilityFacts(
  props: HappierCapabilityFactsProps,
): ReactElement | null {
  const { Text, facts } = props;
  if (facts.length === 0) return null;
  return (
    <View style={LINE} testID={props.testID}>
      <Text role="line" numberOfLines={1}>
        {facts.map((fact, index) => (
          <Fragment key={fact.key}>
            {index === 0 ? null : (
              <Text role="separator" aria-hidden>
                {'  ·  '}
              </Text>
            )}
            {fact.mark ??
              (fact.glyph === undefined ? null : (
                <Text role="glyph">{props.renderGlyph(fact.glyph)} </Text>
              ))}
            <Text
              role="fact"
              {...(fact.strong === true ? { strong: true } : {})}
              {...(fact.mono === true ? { mono: true } : {})}
            >
              {fact.text}
            </Text>
          </Fragment>
        ))}
      </Text>
    </View>
  );
}

const LINE = { flexDirection: 'row', minWidth: 0, flexShrink: 1 } as const;
