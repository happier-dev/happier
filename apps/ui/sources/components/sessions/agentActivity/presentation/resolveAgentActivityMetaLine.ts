import type { AgentActivityStatusV1 } from '@happier-dev/protocol';

import type { AgentActivityRowEntry } from '../agentActivityRowEntry';
import {
    resolveAgentActivityStalenessNote,
    type AgentActivityStaleness,
} from './agentActivityStaleness';
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
export function resolveAgentActivityMetaLine(
    entry: AgentActivityRowEntry,
    /**
     * How long this entry has been silent (4.10). It contributes a word to the line and nothing
     * else — it never changes the status, the glyph or the section.
     */
    staleness: AgentActivityStaleness = 'fresh',
): string | null {
    const statusWord = SELF_EVIDENT_STATUSES.has(entry.status)
        ? null
        : resolveAgentActivityStatusWord(entry.status);
    const detail = collapseToSingleLine(entry.metaDetail);

    // The silence note goes before the detail, because the line is tail-truncated and the detail is
    // by definition the thing we are no longer sure is current. A reader who sees only the first
    // half must see the caveat, not the stale preview it applies to.
    const parts = [statusWord, resolveAgentActivityStalenessNote(staleness), detail]
        .filter((part): part is string => part != null && part.length > 0);

    return parts.length > 0 ? parts.join(META_SEPARATOR) : null;
}
