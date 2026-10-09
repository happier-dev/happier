import { projectOverviewDefaultPlacementsV1, type WidgetAreaLayoutV1 } from '@happier-dev/protocol/widgets';

type Placement = WidgetAreaLayoutV1['instances'][number];
export type ProjectOverviewAreaPlacements = readonly Placement[];

/** One dashboard document's two areas; `null` is a genuinely missing area, `[]` a present empty one. */
export type ProjectOverviewWidgetAreas = Readonly<{
  main: ProjectOverviewAreaPlacements | null;
  aside: ProjectOverviewAreaPlacements | null;
}>;

/**
 * The render-only defaults of a missing Overview (plan 12 §2): main Code and README; aside About,
 * Local changes, Checkouts, Scripts and Sessions. Drawn, never written: the first explicit edit writes
 * the document through the canonical layout owner.
 */
const DEFAULTS = projectOverviewDefaultPlacementsV1();
const DEFAULT_MAIN: ProjectOverviewAreaPlacements = Object.freeze(DEFAULTS.filter(entry => entry.area === 'main'));
const DEFAULT_ASIDE: ProjectOverviewAreaPlacements = Object.freeze(DEFAULTS.filter(entry => entry.area === 'aside'));

/** Each area of one document, in saved order; a missing document has two missing areas. */
export function readProjectOverviewWidgetAreas(
  layout: WidgetAreaLayoutV1 | null,
): ProjectOverviewWidgetAreas {
  if (!layout) return { main: null, aside: null };
  const main: Placement[] = [];
  const aside: Placement[] = [];
  for (const placement of layout.instances)
    (placement.area === 'aside' ? aside : main).push(placement);
  return { main, aside };
}

/** What each area draws: its saved sequence, or the render-only defaults where it is missing. */
export function projectOverviewWidgetAreas(
  areas: ProjectOverviewWidgetAreas,
): Readonly<{
  main: ProjectOverviewAreaPlacements;
  aside: ProjectOverviewAreaPlacements;
}> {
  return {
    main: areas.main ?? DEFAULT_MAIN,
    aside: areas.aside ?? DEFAULT_ASIDE,
  };
}

/** The phone reading order's semantic priority (lab `p-overview` HOMEp); anything else is "custom". */
const PHONE_PRIORITY: Readonly<Record<string, number>> = {
  project_about: 0,
  project_changes: 1,
  project_scripts: 2,
  project_code: 4,
  project_readme: 5,
  project_checkouts: 6,
  project_sessions: 7,
};
const CUSTOM_PRIORITY = 3;

function phonePriority(placement: Placement): number {
  const definition = placement.instance.definition;
  return definition.kind === 'builtin'
    ? (PHONE_PRIORITY[definition.id] ?? CUSTOM_PRIORITY)
    : CUSTOM_PRIORITY;
}

/**
 * The phone's one reading order (§5 deterministic merge): only the two areas' current heads compete,
 * the lower semantic priority wins and main wins a tie. No widget can pass another of its own area, so
 * every saved and user-moved position holds, and nothing is persisted for the phone.
 */
export function mergeProjectOverviewWidgetHeads(
  areas: ProjectOverviewWidgetAreas,
): readonly Placement[] {
  const { main, aside: savedAside } = projectOverviewWidgetAreas(areas);
  // The unpersisted phone default hierarchy differs from the desktop's aside; a saved area's
  // sequence, including empty, must never be sorted by semantic priority.
  const aside = areas.aside === null
    ? [savedAside[0]!, savedAside[1]!, savedAside[3]!, savedAside[2]!, savedAside[4]!]
    : savedAside;
  const merged: Placement[] = [];
  let m = 0;
  let a = 0;
  while (m < main.length || a < aside.length) {
    const fromMain = main[m];
    const fromAside = aside[a];
    if (
      fromMain &&
      (!fromAside || phonePriority(fromMain) <= phonePriority(fromAside))
    ) {
      merged.push(fromMain);
      m += 1;
    } else if (fromAside) {
      merged.push(fromAside);
      a += 1;
    }
  }
  return merged;
}
