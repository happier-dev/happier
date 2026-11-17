/** Keep the field's value, placeholder, outline and error roles paired with their host inputs. */
export function resolveHappierFieldTextColors<Color>(palette: Readonly<{
  controlBorder: Color;
  fieldBackground: Color;
  controlEdge?: import('../../environment/types.js').HappierUiPalette['controlEdge'];
  placeholder: Color;
}>, theme: Readonly<{ colors: Readonly<{ text: Color; danger: Color }> }>) {
  return {
    borderColor: palette.controlBorder,
    backgroundColor: palette.fieldBackground,
    edge: palette.controlEdge,
    valueColor: theme.colors.text,
    placeholderColor: palette.placeholder,
    errorColor: theme.colors.danger,
  };
}
