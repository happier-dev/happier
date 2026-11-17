import type { ThemeSelectionSurfaceBinding } from '@happier-dev/plugin-ui/presentation';

/** The Project choice anatomy used by Store and the Session condition editor. */
export const PROJECT_PICKER_THEME_SURFACE = {
    root: { surface: 'project-picker', part: 'root', state: 'default' },
    row: { surface: 'project-picker', part: 'row', state: 'default' },
    label: { surface: 'project-picker', part: 'label', state: 'default' },
} as const satisfies ThemeSelectionSurfaceBinding;
