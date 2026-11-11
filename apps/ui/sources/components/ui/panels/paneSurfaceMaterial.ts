import type {
  FloatingSurfaceRole,
  GlassSurfaceGroup,
} from '@/components/ui/glass/glassMaterial';

/**
 * The one material decision for a pane host's sheet (side, details and bottom panes alike). In flow a pane is
 * page: the content material. Over the page it floats: the floating panel material that dialogs and large
 * anchored panels use (blur plus the panel's heavy coat), so a transcript read in it stays legible and the page
 * under it is frosted, never shown through sharp (owner 2026-11-11 desktop #12, #18).
 */
export type PaneSurfaceMaterial = Readonly<{
  surfaceGroup: GlassSurfaceGroup;
  floatingRole?: FloatingSurfaceRole;
  solidColor: string;
}>;

export function resolvePaneSurfaceMaterial(
  overlay: boolean,
  colors: Readonly<{
    surface: Readonly<{ base: string }>;
    edge: Readonly<{ floatingFill: string }>;
  }>,
): PaneSurfaceMaterial {
  return overlay
    ? {
        surfaceGroup: 'floating',
        floatingRole: 'panel',
        solidColor: colors.edge.floatingFill,
      }
    : { surfaceGroup: 'content', solidColor: colors.surface.base };
}
