import type { AgentActivityStatusV1 } from '@happier-dev/protocol';

import type { AgentActivityRowEntry } from '../agentActivityRowEntry';
import { resolveAgentActivityStatusWord } from './agentActivityToneStyle';
import { collapseToSingleLine } from './collapseToSingleLine';

/**
 * Statuses whose word the row does NOT repeat below the title.
 *
 * `running` already says so with a spinner and a clock that is visibly moving; `succeeded` says so
 * with a settled check glyph and a frozen total. Everything else is abnormal, and an abnormal state
 * must be legible without colour (R-12) — which means a word, in the one line this row has.
 */
const SELF_EVIDENT_STATUSES: ReadonlySet<AgentActivityStatusV1> = new Set(['running', 'succeeded']);

const META_SEPARATOR = ' · ';

/**
 * The row's single meta line, or `null` when the row should stay one line tall.
 *
 * This replaces up to seven `Label: value` fact pills per row. The budget is one line because the
 * row's job is scanning a roster, not reading a record: everything the pills carried (type,
 * provider, backend, intent, native type, model, agent id, duration) is either already visible
 * elsewhere on the row or belongs in the detail view the row opens.
 */
export function resolveAgentActivityMetaLine(entry: AgentActivityRowEntry): string | null {
    const statusWord = SELF_EVIDENT_STATUSES.has(entry.status)
        ? null
        : resolveAgentActivityStatusWord(entry.status);
    const detail = collapseToSingleLine(entry.metaDetail);

    if (statusWord && detail) return `${statusWord}${META_SEPARATOR}${detail}`;
    return statusWord ?? detail ?? null;
}
