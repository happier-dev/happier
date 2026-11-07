// Declaration bodies are packaged data, outside Metro's JavaScript graph.
export function renderBundledPluginUiDeclarationSource(declaration) {
  return `${JSON.stringify(declaration)}\n`;
}

export function readBundledPluginUiDeclarationSource(source) {
  if (source.trimStart().startsWith('{')) return JSON.parse(source);
  const expression = source.match(/^export const declaration = (.+);$/m)[1];
  // Last-good graphs emitted before the data encoding change remain readable.
  const json = expression.startsWith('JSON.parse(') && expression.endsWith(')')
    ? JSON.parse(expression.slice('JSON.parse('.length, -1))
    : expression;
  return JSON.parse(json);
}
