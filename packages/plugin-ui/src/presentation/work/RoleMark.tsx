import type { ReactNode } from 'react';
import { resolveHappierRoleGlyph, type HappierRoleRunsAsKind } from './workVocabulary.js';

/** An engine identity takes precedence; roles without one carry their own portable glyph. */
export function HappierRoleMark(props: Readonly<{
  roleId?: string;
  runsAs: HappierRoleRunsAsKind;
  agentMark?: ReactNode;
  renderGlyph: (glyph: ReturnType<typeof resolveHappierRoleGlyph>) => ReactNode;
}>) {
  return props.agentMark ?? props.renderGlyph(resolveHappierRoleGlyph(props.roleId, props.runsAs));
}
