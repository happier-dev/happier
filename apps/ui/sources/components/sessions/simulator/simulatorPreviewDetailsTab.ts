/** The Session's simulator preview (one per Session); the mounted runtime picks the device. */
export const SIMULATOR_PREVIEW_DETAILS_TAB_KEY = 'simulator-preview';

/** The Details tab the Session details renderer shows as the simulator preview pane. */
export function createSimulatorPreviewDetailsTab(
  input: Readonly<{ title: string }>,
) {
  return {
    key: SIMULATOR_PREVIEW_DETAILS_TAB_KEY,
    kind: 'simulatorPreview',
    title: input.title,
    resource: { kind: 'simulatorPreview' },
  } as const;
}
