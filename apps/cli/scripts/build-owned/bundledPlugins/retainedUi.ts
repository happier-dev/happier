/** Refresh manifest facts while retaining unavailable peer UI descriptors. */
import {
  createSourceFile, isIdentifier, isImportDeclaration, isObjectLiteralExpression, isPropertyAssignment,
  isStringLiteral, isTypeAliasDeclaration, isVariableStatement, ScriptTarget,
} from 'typescript';
import type { Expression, ObjectLiteralExpression, PropertyAssignment, Statement } from 'typescript';
import { toAgentConstPrefix } from './agentUi.ts';
import { renderJsonLiteral, renderTsStringArrayLiteral } from './literals.ts';
import type { BundledPluginPackage } from './projectionFacts.ts';
import {
  readPermissionModeMapping, readProviderOwnedEnvironmentKeys,
  renderBundledAccountConnectedServiceDeclarationsTs, renderBundledAccountProviderDeclarationsTs,
  renderBundledAgentDeclarationsTs, renderBundledMachineProvisionerDeclarationsTs,
  renderBundledPluginPresentationTs, renderBundledUiDeclarationImportsTs, renderBundledAgentDeclarationTypeTs,
} from './uiDeclarations.ts';

function property(object: ObjectLiteralExpression, name: string): PropertyAssignment | undefined {
  return object.properties.find((node): node is PropertyAssignment =>
    isPropertyAssignment(node) && isIdentifier(node.name) && node.name.text === name);
}

export function renderRetainedUiBundledPluginEntriesTs(
  source: string,
  pluginPackages: readonly BundledPluginPackage[],
  outPath: string,
): string {
  const parsed = createSourceFile(outPath, source, ScriptTarget.Latest);
  const constants = new Map<string, Expression>();
  const declarations = new Map<string, Statement>();
  for (const statement of parsed.statements) {
    if (isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (!isIdentifier(declaration.name)) continue;
        declarations.set(declaration.name.text, statement);
        if (declaration.initializer) constants.set(declaration.name.text, declaration.initializer);
      }
    } else if (isTypeAliasDeclaration(statement)) {
      declarations.set(statement.name.text, statement);
    }
  }
  const edits: { start: number; end: number; text: string }[] = [];
  // Protocol type imports belong to the manifest declarations. Descriptor
  // imports and executable expressions remain exactly as published by peers.
  const imports = parsed.statements.filter(statement => isImportDeclaration(statement)
    && statement.importClause?.isTypeOnly && isStringLiteral(statement.moduleSpecifier)
    && (statement.moduleSpecifier.text === '@happier-dev/protocol'
      || statement.moduleSpecifier.text.startsWith('@happier-dev/protocol/')));
  if (imports.length === 0) throw new Error(`Missing bundled declaration imports: ${outPath}`);
  for (const [index, statement] of imports.entries()) {
    edits.push({ start: index === 0 ? statement.getStart(parsed) : statement.getFullStart(), end: statement.end,
      text: index === 0 ? renderBundledUiDeclarationImportsTs() : '' });
  }
  for (const [name, render] of [
    ['BundledAgentDeclaration', renderBundledAgentDeclarationTypeTs],
    ['BUNDLED_FIRST_PARTY_PLUGIN_PRESENTATION', renderBundledPluginPresentationTs],
    ['BUNDLED_CANONICAL_AGENT_DECLARATIONS', renderBundledAgentDeclarationsTs],
    ['BUNDLED_ACCOUNT_PROVIDER_DECLARATIONS', renderBundledAccountProviderDeclarationsTs],
    ['BUNDLED_ACCOUNT_CONNECTED_SERVICE_DECLARATIONS', renderBundledAccountConnectedServiceDeclarationsTs],
    ['BUNDLED_MACHINE_PROVISIONER_DECLARATIONS', renderBundledMachineProvisionerDeclarationsTs],
  ] as const) {
    const statement = declarations.get(name);
    if (!statement) throw new Error(`Missing bundled declaration '${name}': ${outPath}`);
    edits.push({ start: statement.getStart(parsed), end: statement.end, text: render(pluginPackages) });
  }

  // CORE/UI map entries reference descriptor constants, not manifest payloads.
  // The two manifest fields embedded in CORE constants must still advance.
  // Use syntax spans so nested permission mappings and field removal are safe.
  for (const entry of pluginPackages) {
    if (!entry.agentId) continue;
    const core = constants.get(`${toAgentConstPrefix(entry.agentId)}_CORE`);
    // Declarative catalog Agents without a bundled UI descriptor have no CORE.
    if (!core || !isObjectLiteralExpression(core)) continue;
    const environmentKeys = property(core, 'providerOwnedEnvironmentKeys');
    if (!environmentKeys) throw new Error(`Missing bundled Agent environment keys for '${entry.agentId}': ${outPath}`);
    edits.push({ start: environmentKeys.initializer.getStart(parsed), end: environmentKeys.initializer.end,
      text: renderTsStringArrayLiteral(readProviderOwnedEnvironmentKeys(entry, entry.agentId)) });
    const permissions = property(core, 'permissions');
    if (!permissions || !isObjectLiteralExpression(permissions.initializer)) {
      throw new Error(`Missing bundled Agent permissions for '${entry.agentId}': ${outPath}`);
    }
    const mapping = property(permissions.initializer, 'permissionModeMapping');
    const nextMapping = readPermissionModeMapping(entry, entry.agentId);
    if (mapping && nextMapping !== undefined) {
      edits.push({ start: mapping.initializer.getStart(parsed), end: mapping.initializer.end, text: renderJsonLiteral(nextMapping) });
    } else if (mapping) {
      edits.push({ start: mapping.getFullStart(), end: mapping.end + (source[mapping.end] === ',' ? 1 : 0), text: '' });
    } else if (nextMapping !== undefined) {
      const protocol = property(permissions.initializer, 'promptProtocol');
      if (!protocol) throw new Error(`Missing bundled Agent prompt protocol for '${entry.agentId}': ${outPath}`);
      const afterProtocol = protocol.end + (source[protocol.end] === ',' ? 1 : 0);
      edits.push({ start: afterProtocol, end: afterProtocol, text: `\n        permissionModeMapping: ${renderJsonLiteral(nextMapping)},` });
    }
  }
  for (const edit of edits.sort((a, b) => b.start - a.start)) {
    source = source.slice(0, edit.start) + edit.text + source.slice(edit.end);
  }
  return source;
}
