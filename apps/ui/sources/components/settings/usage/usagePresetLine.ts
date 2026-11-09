import type {
  WidgetAreaPresetStateV1,
  WidgetSurfaceRefV1,
} from '@happier-dev/protocol/widgets';

/**
 * Whether the "… is yours now" line shows, and for which preset and surface. Whether a preset view was edited is
 * already known locally from the view list, so the line is drawn on the first paint instead of arriving with the
 * layout read and pushing the widgets down (R139). Once the layout answers, its own preset state decides.
 */
export function resolveUsagePresetLine(
  ready: Readonly<{
    preset?: WidgetAreaPresetStateV1 | null;
    surface: WidgetSurfaceRefV1;
  }> | null,
  selected: Readonly<{
    id: string;
    name: string;
    isPreset: boolean;
    edited?: boolean;
  }> | null,
  surface: WidgetSurfaceRefV1 | undefined,
): Readonly<{
  preset: WidgetAreaPresetStateV1;
  surface: WidgetSurfaceRefV1;
}> | null {
  if (ready)
    return ready.preset?.isEdited
      ? { preset: ready.preset, surface: ready.surface }
      : null;
  if (!selected?.isPreset || selected.edited !== true || !surface) return null;
  return {
    preset: {
      id: selected.id,
      name: selected.name,
      isEdited: true,
      changes: [],
    },
    surface,
  };
}
