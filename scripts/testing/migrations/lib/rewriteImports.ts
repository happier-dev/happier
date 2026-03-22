import { type InventoryFile, type RewritePlan, type RewriteRule } from './migrationTypes.ts';

function rewriteImportSpecifier(content: string, rule: RewriteRule): string {
  return content
    .replaceAll(`'${rule.from}'`, `'${rule.to}'`)
    .replaceAll(`"${rule.from}"`, `"${rule.to}"`);
}

export function planImportRewrites(files: readonly InventoryFile[], rules: readonly RewriteRule[]): RewritePlan {
  const edits = files.flatMap((file) => {
    const after = rules.reduce((current, rule) => rewriteImportSpecifier(current, rule), file.content);
    if (after === file.content) {
      return [];
    }

    return [
      {
        filePath: file.filePath,
        before: file.content,
        after,
      },
    ];
  });

  return { edits };
}
