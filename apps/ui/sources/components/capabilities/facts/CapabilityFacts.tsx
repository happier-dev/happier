import * as React from 'react';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
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
} from '@happier-dev/plugin-ui/presentation';

import { Icon, type IconName } from '@/components/ui/icons/Icon';
import type { PageHeaderMetaFact } from '@/components/ui/layout/PageHeader';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

/**
 * Happier's words and glyphs for the shared capability facts owner (`@happier-dev/plugin-ui` presentation), which
 * decides the facts, their order and weight, and lays out the row line for core pages and plugins alike.
 */
export type CapabilitySource = HappierCapabilitySource;
export type CapabilityTrust = HappierCapabilityTrust;
export type CapabilityCost = HappierCapabilityCost;
export type CapabilityFactsProps = HappierCapabilityFactsInput & Readonly<{
  /** 'row': one quiet line, truncates at the end. */
  presentation: 'row';
}>;

const labels: HappierCapabilityFactsLabels = {
  you: () => t('capabilities.facts.you'),
  happier: () => t('capabilities.facts.happier'),
  trust: (trust) => trust === 'runs_scripts'
    ? t('capabilities.facts.runsScripts')
    : trust === 'has_files' ? t('capabilities.facts.hasFiles') : t('capabilities.facts.textOnly'),
  toolCount: (count, shown) => t('capabilities.facts.toolCount', { count, shown }),
  tokensPerTurn: (shown) => t('capabilities.facts.tokensPerTurn', { count: shown }),
  tokensWhenUsed: (shown) => t('capabilities.facts.tokensWhenUsed', { count: shown }),
  onDemand: () => t('capabilities.mcp.tools.loading.onDemand'),
};

const GLYPH_ICON: Readonly<Record<HappierCapabilityFactGlyph, IconName>> = {
  you: 'user-circle',
  git: 'github-logo',
  machine: 'desktop',
  link: 'link',
  text_only: 'file-text',
  has_files: 'folder',
  runs_scripts: 'terminal',
};

export function CapabilityFacts(
  props: CapabilityFactsProps,
): React.ReactElement | null {
  const { theme } = useUnistyles();
  const { presentation: _presentation, ...input } = props;
  return (
    <HappierCapabilityFacts
      facts={buildHappierCapabilityFacts(input, labels)}
      Text={FactsText}
      renderGlyph={(glyph) => <Icon name={GLYPH_ICON[glyph]} size={12} color={theme.colors.text.tertiary} />}
    />
  );
}

function FactsText(props: HappierCapabilityFactsTextProps): React.ReactElement {
  return (
    <Text
      variant="meta"
      {...(props.numberOfLines === undefined ? {} : { numberOfLines: props.numberOfLines })}
      {...(props['aria-hidden'] === true ? { 'aria-hidden': true } : {})}
      style={props.role === 'fact'
        ? [props.strong === true ? styles.strong : null, props.mono === true ? styles.mono : null]
        : props.role === 'line' ? styles.line : styles.quiet}
    >
      {props.children}
    </Text>
  );
}

/** The same facts for an entity header, through `PageHeader` `meta` (one owner for header facts). */
export function buildCapabilityHeaderMeta(
  input: HappierCapabilityFactsInput,
): readonly PageHeaderMetaFact[] {
  return buildHappierCapabilityHeaderFacts(input, labels).map((fact) => ({
    key: fact.key,
    text: fact.text,
    ...(fact.glyph === undefined ? {} : { icon: GLYPH_ICON[fact.glyph] }),
  }));
}

const styles = StyleSheet.create((theme) => ({
  line: { color: theme.colors.text.tertiary, flexShrink: 1 },
  quiet: { color: theme.colors.text.tertiary },
  strong: { color: theme.colors.text.secondary },
  mono: { ...Typography.mono() },
}));
