import { Fragment, type ReactNode } from 'react';

import type { HappierStyleProp } from '../portableTypes.js';
import { resolveHappierWorkHost, useHappierWorkTheme, type HappierWorkHost, type HappierWorkTextRole, type HappierWorkTheme } from './workTheme.js';

const FACT_SEPARATOR = ' · ';

/** Ordered human facts, omitting absent values without changing their wording. */
export function joinHappierFacts(...facts: readonly (string | null | undefined)[]): string {
  return facts.filter((fact): fact is string => typeof fact === 'string' && fact.length > 0).join(FACT_SEPARATOR);
}

export type HappierFactLineProps = Readonly<{
  facts: readonly ReactNode[];
  testID?: string;
  numberOfLines?: number;
  role?: HappierWorkTextRole;
  style?: HappierStyleProp;
  theme?: HappierWorkTheme;
  host?: HappierWorkHost;
}>;

/** One quiet line of facts; separators use quieter ink than the facts themselves. */
export function HappierFactLine(props: HappierFactLineProps) {
  const theme = useHappierWorkTheme(props.theme);
  const { Text } = resolveHappierWorkHost(props.host);
  const facts = props.facts.filter((fact) => fact !== null && fact !== undefined && fact !== false && fact !== '');
  const role = props.role ?? 'rowLine';
  if (facts.length === 0) return null;
  return (
    <Text
      role={role}
      testID={props.testID}
      numberOfLines={props.numberOfLines}
      style={[{ color: theme.colors.secondaryText }, props.style]}
    >
      {facts.map((fact, index) => (
        <Fragment key={index}>
          {index > 0 ? <Text role={role} style={{ color: theme.colors.mutedText }}>{FACT_SEPARATOR}</Text> : null}
          {fact}
        </Fragment>
      ))}
    </Text>
  );
}
