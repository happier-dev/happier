import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import ts from 'typescript';

async function readSource(relativePath) {
  const text = await readFile(new URL(`../src/${relativePath}`, import.meta.url), 'utf8');
  return ts.createSourceFile(relativePath, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

async function readApiSurfaceInventory() {
  return JSON.parse(await readFile(new URL('../api-surface.json', import.meta.url), 'utf8'));
}

function requiredTypeAlias(source, name) {
  const declaration = source.statements.find((statement) => (
    ts.isTypeAliasDeclaration(statement) && statement.name.text === name
  ));
  assert.ok(declaration, `Expected ${name} to be declared in ${source.fileName}`);
  return declaration;
}

function typeLiteralProperty(typeAlias, name) {
  const type = ts.isTypeLiteralNode(typeAlias.type)
    ? typeAlias.type
    : (
      ts.isTypeReferenceNode(typeAlias.type)
      && ts.isIdentifier(typeAlias.type.typeName)
      && typeAlias.type.typeName.text === 'Readonly'
      && typeAlias.type.typeArguments?.length === 1
      && ts.isTypeLiteralNode(typeAlias.type.typeArguments[0])
        ? typeAlias.type.typeArguments[0]
        : undefined
    );
  assert.ok(type, `${typeAlias.name.text} must be a Readonly type literal`);
  return type.members.find((member) => (
    ts.isPropertySignature(member)
    && member.name
    && ts.isIdentifier(member.name)
    && member.name.text === name
  ));
}

test('keeps terminal-follow user classification on the Agent producer projection only', async () => {
  const [agentSource, publicSource, barrelSource] = await Promise.all([
    readSource('externalSessions.ts'),
    readSource('services/externalSessions.ts'),
    readSource('sessions/external/index.ts'),
  ]);

  const projection = requiredTypeAlias(agentSource, 'AgentExternalSessionUserProjection');
  assert.ok(ts.isUnionTypeNode(projection.type));
  assert.deepEqual(
    projection.type.types.map((member) => member.getText(agentSource)),
    ["'source_fact'", "'terminal_origin'", "'host_prompt_echo'"],
  );

  const agentItem = requiredTypeAlias(agentSource, 'AgentExternalSessionTranscriptItem');
  const userProjection = typeLiteralProperty(agentItem, 'userProjection');
  assert.ok(userProjection, 'Agent transcript item must carry explicit user projection metadata');
  assert.ok(userProjection.questionToken, 'Agent user projection must remain optional for non-user records');
  assert.equal(userProjection.type?.getText(agentSource), 'AgentExternalSessionUserProjection');
  assert.ok(typeLiteralProperty(agentItem, 'raw'), 'Agent transcript item must retain the canonical raw record');

  const publicItem = requiredTypeAlias(publicSource, 'ExternalSessionTranscriptItem');
  assert.equal(
    typeLiteralProperty(publicItem, 'userProjection'),
    undefined,
    'recipient-safe public transcript items must not disclose producer-only classification',
  );
  assert.equal(
    typeLiteralProperty(publicItem, 'raw'),
    undefined,
    'recipient-safe public transcript items must not disclose the canonical producer raw record',
  );

  const barrelText = barrelSource.getFullText();
  assert.match(
    barrelText,
    /export type \{ AgentExternalSessionUserProjection \} from '\.\.\/\.\.\/externalSessions\.js';/u,
  );
});

test('projects the strict canonical Agent transcript raw record through the SDK author type', async () => {
  const [agentSource, barrelSource] = await Promise.all([
    readSource('externalSessions.ts'),
    readSource('sessions/external/index.ts'),
  ]);

  const protocolImport = agentSource.statements.find((statement) => (
    ts.isImportDeclaration(statement)
    && ts.isStringLiteral(statement.moduleSpecifier)
    && statement.moduleSpecifier.text === '@happier-dev/protocol'
  ));
  assert.ok(protocolImport, 'Agent transcript producer must import its canonical Protocol contract');
  assert.ok(agentSource.getFullText().includes('AgentExternalSessionTranscriptRawRecordSchema'),
    'Agent transcript producer must consume the strict canonical Protocol schema');
  assert.ok(
    !(
      protocolImport.importClause
      && protocolImport.importClause.namedBindings
      && ts.isNamedImports(protocolImport.importClause.namedBindings)
      && protocolImport.importClause.namedBindings.elements.some((element) => (
        element.name.text === 'TranscriptRawRecordV1'
      ))
    ),
    'Agent transcript producer must not admit through the persisted compatibility reader',
  );

  assert.ok(agentSource.statements.some((statement) => (
    ts.isTypeAliasDeclaration(statement)
    && statement.name.text === 'AgentExternalSessionTranscriptRawRecord'
  )), 'SDK must own the declaration-neutral public author projection');
  assert.ok(!agentSource.statements.some((statement) => (
    ts.isExportDeclaration(statement)
    && ts.isStringLiteral(statement.moduleSpecifier)
    && statement.moduleSpecifier.text === '@happier-dev/protocol'
  )), 'SDK must not leak the Protocol declaration graph through its public author type');

  assert.match(
    barrelSource.getFullText(),
    /export type \{ AgentExternalSessionTranscriptRawRecord \} from '\.\.\/\.\.\/externalSessions\.js';/u,
  );
});

test('publishes the Agent-only user classification through the canonical SDK inventory', async () => {
  const inventory = await readApiSurfaceInventory();
  assert.ok(inventory.symbols.some((symbol) => (
    symbol.specifier === './sessions/external'
    && symbol.exportName === 'AgentExternalSessionUserProjection'
    && symbol.kind === 'type'
    && symbol.sourceModule === 'src/externalSessions.ts'
    && symbol.sourceExport === 'AgentExternalSessionUserProjection'
    && symbol.realm === 'daemon'
    && symbol.stability === 'preview'
  )));
});

test('publishes the strict canonical Agent transcript raw record through the canonical SDK inventory', async () => {
  const inventory = await readApiSurfaceInventory();
  assert.ok(inventory.symbols.some((symbol) => (
    symbol.specifier === './sessions/external'
    && symbol.exportName === 'AgentExternalSessionTranscriptRawRecord'
    && symbol.kind === 'type'
    && symbol.sourceModule === 'src/externalSessions.ts'
    && symbol.sourceExport === 'AgentExternalSessionTranscriptRawRecord'
    && symbol.realm === 'daemon'
    && symbol.stability === 'preview'
  )));
});
