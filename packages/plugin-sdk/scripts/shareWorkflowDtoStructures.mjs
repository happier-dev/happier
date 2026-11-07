import ts from 'typescript';

const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed });
const semanticFields = new Set(['definition', 'selection', 'execution']);

/** Share exact Workflow projections; readonly and shallow ingress stay distinct. */
export function shareWorkflowDtoStructures(declarations) {
  const prefix = declarations[0][0].replace(/InputById$/u, '');
  const nextByField = new Map();
  let text = declarations.map(([, declaration]) => declaration).join('\n');
  const containsObject = node => ts.isTypeLiteralNode(node) || ts.forEachChild(node, containsObject);
  for (;;) {
    const source = ts.createSourceFile('workflows.ts', text, ts.ScriptTarget.ES2022, true);
    const groups = new Map();
    const projection = node => {
      if (!ts.isPropertySignature(node) || !semanticFields.has(node.name.text)
        || !node.type || !containsObject(node.type)) return null;
      const body = printer.printNode(ts.EmitHint.Unspecified, node.type, source);
      return { key: `${node.name.text}\0${body}`, field: node.name.text, body };
    };
    const collect = node => {
      const candidate = projection(node);
      if (candidate) {
        const group = groups.get(candidate.key) ?? { ...candidate, count: 0 };
        group.count++;
        groups.set(candidate.key, group);
      }
      ts.forEachChild(node, collect);
    };
    collect(source);
    // Outer objects first: recount inner uses after their parent is shared,
    // so repeated parents do not manufacture single-use support aliases.
    const selected = [...groups.values()].filter(group => group.count > 1)
      .sort((left, right) => right.body.length - left.body.length)[0];
    if (!selected) return text;
    const index = (nextByField.get(selected.field) ?? 0) + 1;
    nextByField.set(selected.field, index);
    const name = `${prefix}${selected.field[0].toUpperCase()}${selected.field.slice(1)}${index}`;
    const transformed = ts.transform(source, [context => {
      const visit = node => projection(node)?.key === selected.key
        ? ts.factory.updatePropertySignature(node, node.modifiers, node.name, node.questionToken,
          ts.factory.createTypeReferenceNode(name))
        : ts.visitEachChild(node, visit, context);
      return root => ts.visitNode(root, visit);
    }]);
    try {
      text = `type ${name} = ${selected.body};\n` + printer.printFile(transformed.transformed[0]);
    } finally {
      transformed.dispose();
    }
  }
}
