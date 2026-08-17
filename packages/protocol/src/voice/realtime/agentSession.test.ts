import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import ts from 'typescript';

import { ProtocolValidationError } from '../../plugins/actions/jsonSchemaValidation.js';
import {
  AGENT_SESSION_REALTIME_SDP_MAX_BYTES,
  AgentSessionRealtimeInspectRequestV1Schema,
  AgentSessionRealtimeInspectResultV1Schema,
  AgentSessionRealtimeStartRequestV1Schema,
  AgentSessionRealtimeStartResultV1Schema,
  AgentSessionRealtimeStopRequestV1Schema,
  AgentSessionRealtimeWatchRequestV1Schema,
  AgentSessionRealtimeWatchResultV1Schema,
} from './agentSession.js';

function emitAgentSessionDeclarations(): Map<string, string> {
  const configPath = fileURLToPath(new URL('../../../tsconfig.json', import.meta.url));
  const sourcePath = fileURLToPath(new URL('./agentSession.ts', import.meta.url));
  const parsed = ts.getParsedCommandLineOfConfigFile(configPath, {}, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic(diagnostic) {
      throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
    },
  });
  if (!parsed) throw new Error(`Unable to parse ${configPath}`);

  const program = ts.createProgram({
    rootNames: [sourcePath],
    options: {
      ...parsed.options,
      declaration: true,
      declarationMap: false,
      emitDeclarationOnly: true,
      incremental: false,
    },
    projectReferences: parsed.projectReferences,
  });
  const sourceFile = program.getSourceFile(sourcePath);
  if (!sourceFile) throw new Error(`Missing ${sourcePath}`);

  const diagnostics = program.getDeclarationDiagnostics(sourceFile);
  if (diagnostics.length > 0) {
    throw new Error(diagnostics.map((diagnostic) => (
      ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')
    )).join('\n'));
  }

  const declarations = new Map<string, string>();
  const emitted = program.emit(undefined, (fileName, contents) => {
    if (fileName.endsWith('.d.ts')) declarations.set(fileName, contents);
  }, undefined, true);
  if (emitted.diagnostics.length > 0) {
    throw new Error(emitted.diagnostics.map((diagnostic) => (
      ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')
    )).join('\n'));
  }
  if (![...declarations.keys()].some((fileName) => fileName.endsWith('/voice/realtime/agentSession.d.ts'))) {
    throw new Error('Agent Session realtime declaration was not emitted');
  }
  return declarations;
}

type DeclarationImport = Readonly<{
  moduleSpecifier: string;
  importedName: string;
}>;

type DeclarationModule = Readonly<{
  fileName: string;
  declarations: ReadonlyMap<string, ts.Declaration>;
  imports: ReadonlyMap<string, DeclarationImport>;
}>;

function declarationModule(fileName: string, text: string): DeclarationModule {
  const sourceFile = ts.createSourceFile(
    fileName,
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const declarations = new Map<string, ts.Declaration>();
  const imports = new Map<string, DeclarationImport>();

  for (const statement of sourceFile.statements) {
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) declarations.set(declaration.name.text, declaration);
      }
      continue;
    }
    if (ts.isTypeAliasDeclaration(statement)
      || ts.isInterfaceDeclaration(statement)
      || ts.isClassDeclaration(statement)
      || ts.isFunctionDeclaration(statement)) {
      if (statement.name) declarations.set(statement.name.text, statement);
      continue;
    }
    if (!ts.isImportDeclaration(statement)
      || !ts.isStringLiteral(statement.moduleSpecifier)
      || !statement.importClause) {
      continue;
    }
    const moduleSpecifier = statement.moduleSpecifier.text;
    if (statement.importClause.name) {
      imports.set(statement.importClause.name.text, {
        moduleSpecifier,
        importedName: 'default',
      });
    }
    const bindings = statement.importClause.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) {
      imports.set(bindings.name.text, { moduleSpecifier, importedName: '*' });
    }
    if (bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        imports.set(element.name.text, {
          moduleSpecifier,
          importedName: element.propertyName?.text ?? element.name.text,
        });
      }
    }
  }
  return { fileName, declarations, imports };
}

function resolveDeclarationModule(
  declarations: ReadonlyMap<string, DeclarationModule>,
  fromFileName: string,
  moduleSpecifier: string,
): DeclarationModule | undefined {
  if (!moduleSpecifier.startsWith('.')) return undefined;
  const unresolved = resolve(dirname(fromFileName), moduleSpecifier);
  for (const candidate of [
    unresolved.replace(/\.js$/u, '.d.ts'),
    `${unresolved}.d.ts`,
    resolve(unresolved, 'index.d.ts'),
  ]) {
    const declaration = declarations.get(candidate);
    if (declaration) return declaration;
  }
  return undefined;
}

function collectStartRequestDeclarationLeaks(): readonly string[] {
  const emitted = emitAgentSessionDeclarations();
  const declarations = new Map<string, DeclarationModule>(
    [...emitted].map(([fileName, text]) => [fileName, declarationModule(fileName, text)]),
  );
  const agentSessionFileName = [...declarations.keys()].find((fileName) => (
    fileName.endsWith('/voice/realtime/agentSession.d.ts')
  ));
  if (!agentSessionFileName) throw new Error('Missing emitted Agent Session realtime declaration');
  const agentSessionDeclaration = declarations.get(agentSessionFileName);
  if (!agentSessionDeclaration) throw new Error('Missing Agent Session realtime declaration module');

  const leaks = new Set<string>();
  const visited = new Set<string>();
  const visitIdentifier = (module: DeclarationModule, fileName: string, identifier: ts.Identifier): void => {
    if (identifier.text === 'ProtocolZodComposableSchema') {
      leaks.add(`${fileName}: ProtocolZodComposableSchema`);
      return;
    }
    const local = module.declarations.get(identifier.text);
    if (local) {
      visitDeclaration(module, fileName, identifier.text, local);
      return;
    }
    const imported = module.imports.get(identifier.text);
    if (!imported) return;
    if (imported.moduleSpecifier === 'zod') {
      leaks.add(`${fileName}: zod.${imported.importedName}`);
      return;
    }
    const importedModule = resolveDeclarationModule(declarations, fileName, imported.moduleSpecifier);
    if (!importedModule) {
      leaks.add(`${fileName}: unresolved declaration import ${imported.moduleSpecifier}`);
      return;
    }
    const importedDeclaration = importedModule.declarations.get(imported.importedName);
    if (!importedDeclaration) {
      leaks.add(`${importedModule.fileName}: missing declaration for ${imported.importedName}`);
      return;
    }
    visitDeclaration(importedModule, importedModule.fileName, imported.importedName, importedDeclaration);
  };
  const visitDeclaration = (
    module: DeclarationModule,
    fileName: string,
    name: string,
    declaration: ts.Declaration,
  ): void => {
    const key = `${fileName}:${name}`;
    if (visited.has(key)) return;
    visited.add(key);
    const visit = (node: ts.Node): void => {
      if (ts.isIdentifier(node)) visitIdentifier(module, fileName, node);
      ts.forEachChild(node, visit);
    };
    visit(declaration);
  };

  for (const name of [
    'AgentSessionRealtimeStartRequestV1',
    'AgentSessionRealtimeStartRequestV1Schema',
  ]) {
    const declaration = agentSessionDeclaration.declarations.get(name);
    if (!declaration) throw new Error(`Missing public declaration for ${name}`);
    visitDeclaration(agentSessionDeclaration, agentSessionFileName, name, declaration);
  }
  return [...leaks].sort();
}

describe('Agent-session realtime Voice control contracts', () => {
  const exactSdp = 'é'.repeat(AGENT_SESSION_REALTIME_SDP_MAX_BYTES / 2);
  const oversizedSdp = `${exactSdp}x`;
  const selection = {
    v: 1,
    provider: { pluginId: 'happier.agent.codex', localId: 'realtime-codex' },
  } as const;

  it('accepts only an exact declaration selection, opaque attempt id, and bounded WebRTC offer', () => {
    expect(AgentSessionRealtimeInspectRequestV1Schema.parse(selection)).toEqual(selection);
    const start = {
      ...selection,
      applicationAttemptId: 'attempt-1',
      transport: { kind: 'webrtc', offerSdp: 'v=0\r\n' },
    } as const;
    expect(AgentSessionRealtimeStartRequestV1Schema.parse(start)).toMatchObject({
      provider: selection.provider,
      applicationAttemptId: 'attempt-1',
      transport: { kind: 'webrtc', offerSdp: 'v=0\r\n' },
    });
    expect(AgentSessionRealtimeStartRequestV1Schema.safeParse({
      ...start,
      transport: { kind: 'host_pcm' },
    }).success).toBe(false);
  });

  it('keeps the complete public start-request declaration closure validator-neutral', () => {
    expect(collectStartRequestDeclarationLeaks()).toEqual([]);
  }, 30_000);

  it('returns Protocol validation errors from the public start-request safeParse boundary', () => {
    const parsed = AgentSessionRealtimeStartRequestV1Schema.safeParse({
      ...selection,
      applicationAttemptId: 'attempt-1',
      transport: { kind: 'host_pcm' },
    });

    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.error).toBeInstanceOf(ProtocolValidationError);
    expect(() => AgentSessionRealtimeStartRequestV1Schema.parse({
      ...selection,
      applicationAttemptId: 'attempt-1',
      transport: { kind: 'host_pcm' },
    })).toThrow(ProtocolValidationError);
  });

  it('forbids caller-selected session, thread, generation, credential, grant, prompt, and upstream RPC fields', () => {
    for (const forbidden of ['sessionId', 'threadId', 'generation', 'apiKey', 'grant', 'prompt', 'method']) {
      const parsed = AgentSessionRealtimeStartRequestV1Schema.safeParse({
        ...selection,
        applicationAttemptId: 'attempt-1',
        transport: { kind: 'webrtc', offerSdp: 'v=0\r\n' },
        [forbidden]: 'caller-controlled',
      });
      expect(parsed.success).toBe(false);
      if (!parsed.success) expect(parsed.error).toBeInstanceOf(ProtocolValidationError);
    }
  });

  it('preserves authentication-required separately from lifecycle session unavailability', () => {
    expect(AgentSessionRealtimeInspectResultV1Schema.parse({
      ok: false,
      status: 'unavailable',
      code: 'agent_realtime_authentication_required',
      message: 'Connect the selected Agent account.',
      reason: 'authentication_required',
    })).toMatchObject({
      status: 'unavailable',
      reason: 'authentication_required',
    });
  });

  it('returns bounded WebRTC answer and retained terminal lifecycle facts without media authority', () => {
    expect(AgentSessionRealtimeStartResultV1Schema.parse({
      ok: true,
      status: 'started',
      transport: { kind: 'webrtc', answerSdp: 'v=0\r\n' },
    })).toEqual({
      ok: true,
      status: 'started',
      transport: { kind: 'webrtc', answerSdp: 'v=0\r\n' },
    });
    expect(AgentSessionRealtimeStartResultV1Schema.safeParse({
      ok: true,
      status: 'started',
      transport: { kind: 'host_pcm' },
    }).success).toBe(false);
    const attempt = { ...selection, applicationAttemptId: 'attempt-1' };
    expect(AgentSessionRealtimeStopRequestV1Schema.parse(attempt)).toEqual(attempt);
    expect(AgentSessionRealtimeWatchRequestV1Schema.parse(attempt)).toEqual(attempt);
    expect(AgentSessionRealtimeWatchResultV1Schema.parse({
      ok: true,
      status: 'terminal',
      event: { kind: 'terminal', reason: 'upstream_closed' },
    })).toEqual({
      ok: true,
      status: 'terminal',
      event: { kind: 'terminal', reason: 'upstream_closed' },
    });
  });

  it('enforces the canonical UTF-8 byte ceiling exactly for offer and answer SDP', () => {
    expect(new TextEncoder().encode(exactSdp).byteLength)
      .toBe(AGENT_SESSION_REALTIME_SDP_MAX_BYTES);
    expect(new TextEncoder().encode(oversizedSdp).byteLength)
      .toBe(AGENT_SESSION_REALTIME_SDP_MAX_BYTES + 1);
    const start = {
      ...selection,
      applicationAttemptId: 'attempt-byte-boundary',
      transport: { kind: 'webrtc' as const, offerSdp: exactSdp },
    };
    expect(AgentSessionRealtimeStartRequestV1Schema.safeParse(start).success).toBe(true);
    const rejectedStart = AgentSessionRealtimeStartRequestV1Schema.safeParse({
      ...start,
      transport: { kind: 'webrtc', offerSdp: oversizedSdp },
    });
    expect(rejectedStart.success).toBe(false);
    if (!rejectedStart.success) expect(rejectedStart.error).toBeInstanceOf(ProtocolValidationError);

    const result = {
      ok: true as const,
      status: 'started' as const,
      transport: { kind: 'webrtc' as const, answerSdp: exactSdp },
    };
    expect(AgentSessionRealtimeStartResultV1Schema.safeParse(result).success).toBe(true);
    expect(AgentSessionRealtimeStartResultV1Schema.safeParse({
      ...result,
      transport: { kind: 'webrtc', answerSdp: oversizedSdp },
    }).success).toBe(false);
  });
});
