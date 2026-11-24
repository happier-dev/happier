import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import ts from 'typescript';

import { ProtocolValidationError } from '../../plugins/actions/protocolComposableSchema.js';
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

function createAgentSessionDeclarationReader() {
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
  const host = ts.createCompilerHost(program.getCompilerOptions());
  const declarations = new Map<string, DeclarationModule>();
  function read(fileName: string): DeclarationModule {
    const cached = declarations.get(fileName);
    if (cached) return cached;
    const sourceFile = program.getSourceFile(fileName);
    if (!sourceFile) throw new Error(`Missing declaration source ${fileName}`);

    // Emit only modules reached by the public declaration's referenced symbols.
    // Whole-program emit serializes unrelated result and Action schema exports.
    let text = sourceFile.isDeclarationFile ? sourceFile.text : undefined;
    if (!sourceFile.isDeclarationFile) {
      const result = program.emit(sourceFile, (outputName, contents) => {
        if (outputName.endsWith('.d.ts')) text = contents;
      }, undefined, true);
      if (result.diagnostics.length > 0) {
        throw new Error(ts.formatDiagnostics(result.diagnostics, host));
      }
    }
    if (text === undefined) throw new Error(`No declaration emitted for ${fileName}`);
    const declaration = declarationModule(fileName, text);
    declarations.set(fileName, declaration);
    return declaration;
  }
  return {
    entry: () => read(sourcePath),
    resolve(fromFileName: string, moduleSpecifier: string): DeclarationModule | undefined {
      if (!moduleSpecifier.startsWith('.')) return undefined;
      const resolved = ts.resolveModuleName(moduleSpecifier, fromFileName, program.getCompilerOptions(), host).resolvedModule;
      return resolved && read(resolved.resolvedFileName);
    },
  };
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

function collectStartRequestDeclarationLeaks(): readonly string[] {
  const declarations = createAgentSessionDeclarationReader();
  const agentSessionDeclaration = declarations.entry();
  const agentSessionFileName = agentSessionDeclaration.fileName;

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
    const importedModule = declarations.resolve(fileName, imported.moduleSpecifier);
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

  it('accepts a closed prepared-instructions receipt only on a successful native start', () => {
    const started = { ok: true, status: 'started', transport: { kind: 'webrtc', answerSdp: 'answer' } };
    const preparedInstructionsFor = { serverId: 'home-a', sessionId: 'session-a' };
    expect(AgentSessionRealtimeStartResultV1Schema.parse({ ...started, preparedInstructionsFor }))
      .toEqual({ ...started, preparedInstructionsFor });
    expect(AgentSessionRealtimeStartResultV1Schema.safeParse({
      ...started, preparedInstructionsFor: { ...preparedInstructionsFor, markdown: 'private' },
    }).success).toBe(false);
    expect(AgentSessionRealtimeStartResultV1Schema.safeParse({
      ok: true, status: 'aborted', preparedInstructionsFor,
    }).success).toBe(false);
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
