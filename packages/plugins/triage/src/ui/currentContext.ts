import type {
  CurrentUiCommandDeclarationV1,
  CurrentUiContextBoundedIncompletenessV1,
  PluginUiContextEnrichmentV1,
} from '@happier-dev/plugin-sdk/ui';
import {
  CURRENT_UI_CONTEXT_BOUNDED_INCOMPLETENESS_V1,
  CURRENT_UI_CONTEXT_MAX_COMMANDS_V1,
  CURRENT_UI_CONTEXT_MAX_UTF8_BYTES_V1,
} from '@happier-dev/plugin-sdk/ui';

import { triageEntryRowKey, type TriageListRowV1 } from '../projection/listWindow.js';
import { TRIAGE_ENTRY_DETAIL_DESTINATION_V1 } from '../composer/openEntryDetails.js';
import {
  preflightTriageRouteLensV1,
  readTriageRouteLensV1,
} from './navigation/location.js';
import { resolveTriageActionTargetV1 } from './state/actionTarget.js';
import { readTriageLensNarrowingV1 } from './state/narrowing.js';
import type { TriageSurfaceStateV1 } from './state/surface.js';
import { projectTriageEntryDisplay } from './window/entryDisplay.js';

type ContextDetailV1 = Readonly<{
  view: 'list' | 'selected-detail';
  scopeLabel?: string;
  /**
   * The reader's own lens is hiding rows from the set below.
   *
   * The commands this projection publishes are exactly the entries the lens
   * left, so without this a reading agent answers "what is on my plate" from a
   * narrowed list as though it were the whole one — the same failure as a bare
   * count printed beside a filtered list. It is deliberately NOT the transport
   * bound's `incomplete`: that one means this surface withheld context to stay
   * inside the canonical byte limit, and giving one flag two meanings would
   * leave nobody able to tell which happened.
   */
  filtered?: true;
} & Partial<CurrentUiContextBoundedIncompletenessV1>>;

function utf8Bytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function withCommands(
  base: Omit<PluginUiContextEnrichmentV1, 'commands' | 'detail'>,
  detail: ContextDetailV1,
  commands: readonly CurrentUiCommandDeclarationV1[],
  incomplete: boolean,
): PluginUiContextEnrichmentV1 {
  return Object.freeze({
    ...base,
    detail: Object.freeze({
      ...detail,
      ...(incomplete ? CURRENT_UI_CONTEXT_BOUNDED_INCOMPLETENESS_V1 : {}),
    }),
    commands: [...commands],
  });
}

/**
 * Project the bounded, data-only context for the mounted aggregate page.
 *
 * Selection is read only through the aggregate action-target owner. Display
 * facts come only from the canonical row projection, while command locations
 * are built and preflighted only by the route owner. The resulting commands
 * are declarative `openSurface` data; this module owns no callback, resolver,
 * navigation effect, Voice hook or currentness store.
 */
export function projectTriageCurrentUiContextV1(input: Readonly<{
  surface: TriageSurfaceStateV1;
  visibleRows: readonly TriageListRowV1[];
}>): PluginUiContextEnrichmentV1 {
  const target = resolveTriageActionTargetV1(input.surface);
  const selectedKey = target.kind === 'entry'
    ? triageEntryRowKey(target.entryRef)
    : null;
  const displayedRows = input.visibleRows
    .filter((row) => row.selected.kind === 'selected')
    .map((row) => ({ row, display: projectTriageEntryDisplay(row) }))
    .sort((left, right) => (
      left.display.key < right.display.key ? -1 : left.display.key > right.display.key ? 1 : 0
    ));
  const selected = selectedKey === null
    ? undefined
    : displayedRows.find(({ display }) => display.key === selectedKey);

  // A retained selection remains the canonical action target even after its
  // row leaves the mounted window (including a direct launch outside the
  // current lens). Preserve that exact identity without inventing or
  // remembering row display facts that are no longer mounted.
  const selectionHasNoDisplay = target.kind === 'entry' && selected === undefined;
  const base = selected === undefined
    ? target.kind === 'entry'
      ? Object.freeze({
          entity: Object.freeze({
            kind: target.entryRef.kindId,
            label: `${target.entryRef.kindId} ${target.entryRef.entryId}`,
            reference: target.entryRef,
          }),
        })
      : Object.freeze({})
    : Object.freeze({
        entity: Object.freeze({
          kind: selected.row.entryRef.kindId,
          label: selected.display.title,
          ...(selected.display.summary === null ? {} : { summary: selected.display.summary }),
          reference: selected.row.entryRef,
        }),
      });
  // Read from the one narrowing owner, so the page's published context and the
  // page's own empty slot cannot disagree about whether the list is narrowed.
  const narrowed = readTriageLensNarrowingV1({
    filters: input.surface.filters,
    query: input.surface.search.query,
  }).narrowed;
  const detail: ContextDetailV1 = target.kind === 'refused'
    ? Object.freeze({ view: 'list', ...(narrowed ? { filtered: true } as const : {}) })
    : Object.freeze({
        view: 'selected-detail',
        ...(selected === undefined ? {} : { scopeLabel: selected.display.scopeLabel }),
        ...(narrowed ? { filtered: true } as const : {}),
      });

  const lens = readTriageRouteLensV1(input.surface);
  const commands: CurrentUiCommandDeclarationV1[] = [];
  const seen = new Set<string>();
  let routeOmitted = false;
  for (const { row, display } of displayedRows) {
    if (display.key === selected?.display.key || seen.has(display.key)) continue;
    seen.add(display.key);
    const location = preflightTriageRouteLensV1({ ...lens, selection: row.entryRef });
    if (location.kind === 'refused') {
      routeOmitted = true;
      continue;
    }
    commands.push(Object.freeze({
      title: `Open ${display.title}`,
      command: Object.freeze({
        kind: 'openSurface',
        destination: TRIAGE_ENTRY_DETAIL_DESTINATION_V1,
        subPath: location.subPath,
      }),
    }));
  }

  const complete = withCommands(base, detail, commands, routeOmitted || selectionHasNoDisplay);
  if (!routeOmitted
    && commands.length <= CURRENT_UI_CONTEXT_MAX_COMMANDS_V1
    && utf8Bytes(complete) <= CURRENT_UI_CONTEXT_MAX_UTF8_BYTES_V1) {
    return complete;
  }

  const bounded: CurrentUiCommandDeclarationV1[] = [];
  for (const command of commands) {
    if (bounded.length >= CURRENT_UI_CONTEXT_MAX_COMMANDS_V1) break;
    const candidate = withCommands(base, detail, [...bounded, command], true);
    if (utf8Bytes(candidate) <= CURRENT_UI_CONTEXT_MAX_UTF8_BYTES_V1) bounded.push(command);
  }
  return withCommands(base, detail, bounded, true);
}
