import ts from 'typescript';

/** Expand an authored export list, including type-only generated re-export lists. */
export async function readPublicationSpecExports(source, { resolveSource, readDeprecation }, ancestors = new Set()) {
  if (ancestors.has(source.physicalPath)) {
    throw new Error(`API surface publication spec has a circular type-only export: ${source.sourceModule}`);
  }
  const nextAncestors = new Set(ancestors).add(source.physicalPath);
  const file = ts.createSourceFile(source.sourceModule, source.contents,
    ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const groups = await Promise.all(file.statements.map(async statement => {
    // A generated empty type list may use the ordinary module marker.
    if (ts.isExportDeclaration(statement) && !statement.moduleSpecifier
      && statement.exportClause && ts.isNamedExports(statement.exportClause)
      && statement.exportClause.elements.length === 0) return [];
    const named = ts.isExportDeclaration(statement) && statement.exportClause
      && ts.isNamedExports(statement.exportClause);
    const typeList = ts.isExportDeclaration(statement) && statement.isTypeOnly && !statement.exportClause;
    if ((!named && !typeList) || !statement.moduleSpecifier || !ts.isStringLiteralLike(statement.moduleSpecifier)) {
      throw new Error(`API surface publication spec ${source.sourceModule} must contain only named re-export declarations or type-only re-export lists`);
    }
    const moduleSpecifier = statement.moduleSpecifier.text;
    if (!moduleSpecifier.startsWith('./') && !moduleSpecifier.startsWith('../')) {
      throw new Error(`API surface publication spec ${source.sourceModule} must re-export package-local modules, not ${moduleSpecifier}`);
    }
    const deprecation = readDeprecation(statement, source.sourceModule);
    const target = await resolveSource(source, moduleSpecifier);
    if (typeList) {
      const expanded = await readPublicationSpecExports(target, { resolveSource, readDeprecation }, nextAncestors);
      if (expanded.some(publication => publication.kind !== 'type')) {
        throw new Error(`API surface publication spec ${source.sourceModule} type-only re-export list contains a value export: ${moduleSpecifier}`);
      }
      return expanded.map(publication => Object.freeze({ ...deprecation, ...publication }));
    }
    return statement.exportClause.elements.map(element => Object.freeze({
      ...deprecation,
      exportName: element.name.text,
      sourceExport: (element.propertyName ?? element.name).text,
      kind: statement.isTypeOnly || element.isTypeOnly ? 'type' : 'value',
      moduleSpecifier,
      sourceModule: target.sourceModule,
    }));
  }));
  return groups.flat();
}
