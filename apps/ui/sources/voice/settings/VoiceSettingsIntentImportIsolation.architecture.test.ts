import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';

import { describe, expect, it } from 'vitest';

const SOURCES_ROOT = join(process.cwd(), 'sources');

const intents = ['dictation', 'conversations', 'privacy', 'advanced'] as const;

function readImports(relativePath: string) {
  const path = join(SOURCES_ROOT, relativePath);
  const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  return source.statements.flatMap((statement) => {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) return [];
    const clause = statement.importClause;
    const bindings = clause?.namedBindings;
    return [{
      module: statement.moduleSpecifier.text,
      names: [
        ...(clause?.name ? [clause.name.text] : []),
        ...(bindings && ts.isNamedImports(bindings)
          ? bindings.elements.flatMap((binding) => [binding.propertyName?.text ?? binding.name.text, binding.name.text])
          : bindings && ts.isNamespaceImport(bindings) ? [bindings.name.text] : []),
      ],
    }];
  });
}

describe('Voice settings intent import isolation', () => {
  it.each(intents)('%s route imports only its intent-owned screen', (intent) => {
    const imports = readImports(`app/(app)/settings/voice/${intent}.tsx`);
    const edges = imports.flatMap((edge) => [edge.module, ...edge.names]);
    const screenName = `Voice${intent[0]!.toUpperCase()}${intent.slice(1)}SettingsScreen`;

    expect(imports.map((edge) => edge.module)).toContain(`@/voice/settings/screens/${screenName}`);
    expect(edges.some((edge) => edge.includes('VoiceSettingsIntentDetailsScreen'))).toBe(false);
    for (const otherIntent of intents.filter((candidate) => candidate !== intent)) {
      const otherScreen = `Voice${otherIntent[0]!.toUpperCase()}${otherIntent.slice(1)}SettingsScreen`;
      expect(edges.some((edge) => edge.includes(otherScreen))).toBe(false);
    }
  });

  it('Privacy and Dictation do not statically import conversation settings subtrees', () => {
    const forbiddenConversationImports = [
      'VoiceProviderSection',
      'BundledConversationSettingsSection',
      'LocalDirectSection',
      'LocalConversationSection',
      'VoiceConversationsSettingsScreen',
    ];

    for (const screenName of ['VoicePrivacySettingsScreen', 'VoiceDictationSettingsScreen']) {
      const imports = readImports(`voice/settings/screens/${screenName}.tsx`);
      const edges = imports.flatMap((edge) => [edge.module, ...edge.names]);

      for (const token of forbiddenConversationImports) {
        expect(edges.some((edge) => edge.includes(token)), `${screenName} must not import ${token}`).toBe(false);
      }
    }
  });
});
