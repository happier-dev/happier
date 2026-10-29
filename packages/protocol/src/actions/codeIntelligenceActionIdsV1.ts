/** Action identity leaf: schema modules and the registry share these constants. */
export const CODE_INTELLIGENCE_ACTION_IDS = ['code.hover.get', 'code.definition.get', 'code.references.list', 'code.symbols.list', 'code.diagnostics.list', 'code.restart',
  'code.rename.preview', 'code.rename.apply', 'code.file.rename.preview', 'code.file.rename.apply', 'code.codeActions.list', 'code.codeAction.apply',
  'code.completion.list', 'code.signature.get', 'code.typeDefinition.get', 'code.implementation.get', 'code.symbols.workspace',
  'code.callHierarchy.get', 'code.format.apply', 'code.imports.organize'] as const;
