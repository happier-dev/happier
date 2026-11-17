/** Stable CSS addresses; entries are published together with their owning emission. */
export type ThemeSurfacePaintRole = Readonly<{
  facet: 'background' | 'foreground' | 'border';
  /** Editable colour-token reference supplied by the host's token owner. */
  tokenRef: string;
}>;

type Part = Readonly<{ kind: 'view' | 'text' }>;
const view = { kind: 'view' } as const;
const text = { kind: 'text' } as const;

export const THEME_SURFACE_REGISTRY = {
  sidebar: { parts: { root: view, header: view, row: view, footer: view }, states: ['default'] },
  'session-row': { parts: { root: view, title: text, meta: text, status: text }, states: ['default', 'selected'] },
  'user-bubble': { parts: { root: view, text }, states: ['default'] },
  'assistant-text': { parts: { root: view }, states: ['default'] },
  'code-block': { parts: { root: view, header: view, body: view }, states: ['default'] },
  'tool-row': { parts: { root: view, icon: view, title: text, detail: text }, states: ['default'] },
  composer: { parts: { root: view, input: view, toolbar: view, send: view }, states: ['default', 'disabled'] },
  'chat-header': { parts: { root: view, title: text, facts: view }, states: ['default'] },
  'tab-bar': { parts: { root: view, tab: view, label: text, icon: view }, states: ['default', 'disabled', 'selected'] },
  button: { parts: { root: view, label: text, icon: view }, states: ['default', 'disabled', 'selected'] },
  'model-picker': { parts: { root: view, provider: text, row: view, effort: view }, states: ['default', 'selected', 'disabled'] },
  'project-picker': { parts: { root: view, row: view, label: text }, states: ['default', 'selected', 'disabled'] },
  menu: { parts: { root: view, row: view, separator: view }, states: ['default', 'disabled', 'selected', 'checked', 'expanded'] },
  input: { parts: { root: view, text: text }, states: ['default', 'disabled'] },
  dialog: { parts: { root: view, header: view, body: view, footer: view }, states: ['default'] },
  switch: { parts: { root: view, track: view, thumb: view }, states: ['default', 'disabled', 'checked'] },
  tooltip: { parts: { root: view, text: text }, states: ['default'] },
  'inline-code': { parts: { root: text, text: text }, states: ['default'] },
} as const satisfies Record<string, Readonly<{ parts: Readonly<Record<string, Part>>; states: readonly string[] }>>;

export type SurfaceId = keyof typeof THEME_SURFACE_REGISTRY;
export type SurfacePart<S extends SurfaceId> = keyof typeof THEME_SURFACE_REGISTRY[S]['parts'] & string;
export type ThemeSurfaceState<S extends SurfaceId> = typeof THEME_SURFACE_REGISTRY[S]['states'][number];
export type SurfaceAddress = { [S in SurfaceId]: Readonly<{ surface: S; part: SurfacePart<S>; state?: ThemeSurfaceState<S> }> }[SurfaceId];
export type ThemeSurfacePaintDescriptor = Readonly<{
  address: SurfaceAddress;
  selector: string;
  label: string;
  paintRoles: readonly ThemeSurfacePaintRole[];
}>;

export type ThemeSurfaceReference = Readonly<{
  id: SurfaceId;
  parts: readonly string[];
  states: readonly string[];
}>;

/** The guide and surface reference project the same emitted address authority. */
export function getThemeSurfaceReference(): readonly ThemeSurfaceReference[] {
  return (Object.keys(THEME_SURFACE_REGISTRY) as SurfaceId[]).map(id => ({
    id,
    parts: Object.keys(THEME_SURFACE_REGISTRY[id].parts),
    states: THEME_SURFACE_REGISTRY[id].states,
  }));
}

export function themeSurfaceDataSet<S extends SurfaceId>(surface: S, part: SurfacePart<S>, state: ThemeSurfaceState<S>) {
  return { surface, part, state } as const;
}

export function isThemeSurfaceAddress(surface: string, part = 'root', state = 'default'): boolean {
  if (!Object.prototype.hasOwnProperty.call(THEME_SURFACE_REGISTRY, surface)) return false;
  const entry = THEME_SURFACE_REGISTRY[surface as SurfaceId];
  return Object.prototype.hasOwnProperty.call(entry.parts, part) && (entry.states as readonly string[]).includes(state);
}

/** Actual paint refs come from the host's resolved token/part metadata, never guessed from pixels. */
export function getThemeSurfacePaintMap(
  resolvePaint: (address: SurfaceAddress) => Readonly<{ label: string; paintRoles: readonly ThemeSurfacePaintRole[] }>,
): readonly ThemeSurfacePaintDescriptor[] {
  return (Object.keys(THEME_SURFACE_REGISTRY) as SurfaceId[]).flatMap((surface) =>
    Object.keys(THEME_SURFACE_REGISTRY[surface].parts).flatMap((part) => {
      const selector = `[data-surface="${surface}"][data-part="${part}"]`;
      const address = { surface, part } as SurfaceAddress;
      return [
        { address, selector, ...resolvePaint(address) },
        ...THEME_SURFACE_REGISTRY[surface].states.filter((state) => state !== 'default').map((state) => {
          const stateAddress = { surface, part, state } as SurfaceAddress;
          return { address: stateAddress, selector: `${selector}[data-state="${state}"]`, ...resolvePaint(stateAddress) };
        }),
      ];
    }),
  );
}
