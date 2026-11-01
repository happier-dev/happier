// Keep manifest data opaque to Babel: emitting it as an object expression
// creates an AST and retained Metro source-map tuples for every schema field.
export function renderBundledPluginUiDeclarationSource(declaration, typePath) {
  return `/** @type {import(${JSON.stringify(typePath)}).PluginHostBundledUiDeclaration} */\nexport const declaration = JSON.parse(${JSON.stringify(JSON.stringify(declaration))});\nexport default declaration;\n`;
}

export function readBundledPluginUiDeclarationSource(source) {
  const expression = source.match(/^export const declaration = (.+);$/m)[1];
  // Last-good graphs emitted before the data encoding change remain readable.
  const json = expression.startsWith('JSON.parse(') && expression.endsWith(')')
    ? JSON.parse(expression.slice('JSON.parse('.length, -1))
    : expression;
  return JSON.parse(json);
}
