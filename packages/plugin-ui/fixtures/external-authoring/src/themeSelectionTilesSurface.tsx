import {
  Button,
  SelectionTiles,
  ThemePalettePreview,
  type SelectionTilesOption,
  type ThemePreviewPalette,
} from '@happier-dev/plugin-ui/components';

type ThemeChoiceProps = Readonly<{
  options: readonly SelectionTilesOption[];
  value: string;
  onChange: (value: string) => void;
}>;

/** A visual theme's menu is independent of selecting the theme. */
export function VisualThemeChoices(props: ThemeChoiceProps & Readonly<{ onManage: (id: string) => void }>) {
  return <SelectionTiles {...props} variant="visual" accessibilityLabel="Theme"
    renderOptionAccessory={({ option, revealed }) => revealed
      ? <Button title={`Manage ${option.title}`} variant="plain" size="small" onPress={() => props.onManage(option.id)} />
      : null} />;
}

/** The first described theme card can occupy the row above the rest of the gallery. */
export function DescribedThemeChoices(props: ThemeChoiceProps) {
  const options = props.options.map((option, index) => ({ ...option, span: index === 0 ? 'row' as const : undefined }));
  return <SelectionTiles {...props} options={options} descriptionPlacement="below" accessibilityLabel="Theme" />;
}

/** A plugin supplies palettes and uses the host's miniature instead of drawing its own preview. */
export function PaletteThemeChoices(props: Omit<ThemeChoiceProps, 'options'> & Readonly<{
  options: readonly (SelectionTilesOption & Readonly<{ palette: ThemePreviewPalette }>)[];
}>) {
  const options = props.options.map(({ palette, ...option }) => ({
    ...option,
    preview: <ThemePalettePreview palette={palette} form="window" />,
  }));
  return <SelectionTiles {...props} options={options} variant="visual" accessibilityLabel="Theme" />;
}
