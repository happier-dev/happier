import ts from 'typescript';
import { resolve, relative } from 'node:path';
import { createParitySourceIndex } from './uiActionParity.ts';

type Surface = 'ui' | 'agent' | 'mcp' | 'cli' | 'voice';
export type DispatchSpec = Readonly<{
  id: string;
  executionPlacement?: string;
  surfaces: Readonly<Partial<Record<Surface | 'rpc', boolean>>>;
  bindings?: Readonly<{ rpcMethod?: string; rpcMethodAliases?: readonly string[] }>;
}>;
type Source = Readonly<{ filePath: string; content: string }>;
export type ActionDispatchGraph = Readonly<{
  requirements: Readonly<Record<string, readonly string[]>>;
  children?: Readonly<Record<string, readonly string[]>>;
  uiPorts: readonly string[];
  hostPorts: readonly string[];
  /** Standalone MCP's non-PAT harness; PAT uses the credentialed CLI host. */
  mcpPorts?: readonly string[];
  daemonPorts?: readonly string[];
  uiMachineDispatch?: boolean;
  clientReverseDispatch?: boolean;
  hostMachineDispatch?: boolean;
  voiceDispatch?: boolean;
  cliDispatch?: boolean;
  sessionToolDispatch?: boolean;
  standaloneToolDispatch?: boolean;
  hostClientDispatch?: boolean;
}>;

/** Static dispatch presence, using the real guards and value producers.
 * Types establish Action identity; callable values must come from actual initializers,
 * never the optional properties published by an ActionExecutorDeps annotation. */
export function readActionDispatchGraph(root: string, sources: readonly Source[] = []): ActionDispatchGraph {
  const options: ts.CompilerOptions = { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler, jsx: ts.JsxEmit.Preserve, strict: true,
    skipLibCheck: true, noEmit: true, types: [], baseUrl: root,
    paths: { '@happier-dev/protocol': ['packages/protocol/src/index.ts'], '@happier-dev/protocol/*': ['packages/protocol/src/*'] } };
  const host = ts.createCompilerHost(options, true);
  const supplied = new Map(sources.map(source => [resolve(root, source.filePath), source.content]));
  const read = host.readFile;
  const exists = host.fileExists;
  const getSource = host.getSourceFile;
  host.readFile = path => supplied.get(resolve(path)) ?? read(path);
  host.fileExists = path => supplied.has(resolve(path)) || exists(path);
  host.getSourceFile = (path, version, onError, fresh) => supplied.has(resolve(path))
    ? ts.createSourceFile(path, supplied.get(resolve(path))!, version, true)
    : getSource(path, version, onError, fresh);
  const directoryExists = host.directoryExists;
  let protocolPhase = false;
  host.directoryExists = path => [...supplied.keys()].some(file => file.startsWith(`${resolve(path)}/`))
    || directoryExists?.(path) === true;
  const core = 'packages/protocol/src/actions/actionExecutor.ts';
  const cli = 'apps/cli/src/session/actions/createCliActionDeps.ts';
  const cliIngress = 'apps/cli/src/session/actions/createCliActionExecutorFromCredentials.ts';
  const ui = 'apps/ui/sources/sync/ops/actions/defaultActionExecutor.ts';
  const daemon = 'apps/cli/src/daemon/externalActions/execution.ts';
  const reverseRuntime = 'apps/ui/sources/components/appShell/runtime/ClientActionReverseRuntime.tsx';
  const mounts = 'apps/ui/sources/components/appShell/runtime/AuthenticatedAppRuntimeMounts.tsx';
  const mcp = 'apps/cli/src/mcp/createExternalMcpServer.ts';
  const sessionMcp = 'apps/cli/src/mcp/createHappierMcpServer.ts';
  const voice = 'apps/ui/sources/voice/tools/handlers.ts';
  const voiceExecution = 'apps/ui/sources/voice/tools/voiceActionExecution.ts';
  const frontDoor = 'apps/ui/sources/sync/ops/actions/frontDoorRuntimeActionExecutor.ts';
  const spoken = 'apps/ui/sources/voice/tools/executeSpokenAction.ts';
  const cliCommand = 'apps/cli/src/cli/commands/actions.ts';
  const cliCompiled = 'apps/cli/src/cli/actions/executeCommand.ts';
  const toolBridge = 'apps/cli/src/agent/tools/happierTools/createActionToolExecutorBridge.ts';
  const toolRegistrar = 'apps/cli/src/mcp/server/registerHappierMcpBuiltInTools.ts';
  const toolDispatch = 'apps/cli/src/agent/tools/happierTools/dispatchBuiltInHappierTool.ts';
  const hostReverse = 'apps/cli/src/session/actions/clientActionReverseDispatch.ts';
  let appIndex: ReturnType<typeof createParitySourceIndex> | undefined = createParitySourceIndex(sources, root);
  let program: Pick<ts.Program, 'getSourceFile' | 'getSourceFiles'> = {
    getSourceFile: path => appIndex?.module(path)?.source,
    getSourceFiles: () => [...appIndex!.modules.values()].map(owner => owner.source),
  };
  let checker: ts.TypeChecker;
  type OwnerSymbol = Readonly<{ name: string; declarations?: readonly ts.Declaration[]; valueDeclaration?: ts.Declaration }>;
  const appSymbols = new Map<ts.Declaration, OwnerSymbol>();
  const appScopes = new Map<ts.Node, Map<string, ts.Declaration>>();
  const unwrap = (node: ts.Expression): ts.Expression => ts.isAsExpression(node) || ts.isSatisfiesExpression(node)
    || ts.isParenthesizedExpression(node) || ts.isNonNullExpression(node) ? unwrap(node.expression) : node;
  const lexicalScope = (node: ts.Node) => ts.isSourceFile(node) || ts.isBlock(node) || ts.isFunctionLike(node)
    || ts.isForOfStatement(node) || ts.isForStatement(node) || ts.isCatchClause(node);
  function scopeBindings(scope: ts.Node): Map<string, ts.Declaration> {
    const cached = appScopes.get(scope);
    if (cached) return cached;
    const bindings = new Map<string, ts.Declaration>();
    appScopes.set(scope, bindings);
    function bind(name: ts.BindingName, declaration: ts.Declaration): void {
      if (ts.isIdentifier(name)) bindings.set(name.text, declaration);
      else for (const element of name.elements) if (ts.isBindingElement(element)) bind(element.name, element);
    }
    function visit(node: ts.Node): void {
      if (ts.isTypeNode(node)) return;
      if (node !== scope && lexicalScope(node)) {
        if (ts.isFunctionDeclaration(node) && node.name) bindings.set(node.name.text, node);
        return;
      }
      if (ts.isVariableDeclaration(node) || ts.isParameter(node)) bind(node.name, node);
      if (ts.isImportSpecifier(node) || ts.isNamespaceImport(node)) bindings.set(node.name.text, node);
      ts.forEachChild(node, visit);
    }
    visit(scope);
    return bindings;
  }
  function localDeclaration(node: ts.Identifier): ts.Declaration | undefined {
    for (let scope: ts.Node | undefined = node.parent; scope; scope = scope.parent) {
      if (!lexicalScope(scope)) continue;
      const declaration = scopeBindings(scope).get(node.text);
      if (!declaration) continue;
      return ts.isImportSpecifier(declaration)
        ? appIndex?.declaration(node.getSourceFile().fileName, node.text) : declaration;
    }
  }
  function appDeclaration(node: ts.Identifier): ts.Declaration | undefined {
    if (ts.isPropertyAccessExpression(node.parent) && node.parent.name === node) {
      let receiver = unwrap(node.parent.expression);
      if (ts.isIdentifier(receiver)) {
        const owner = appIndex?.module(receiver.getSourceFile().fileName);
        const imported = owner?.imports.get(receiver.text);
        if (imported?.name === '*' && !imported.typeOnly) return appIndex?.declaration(imported.path, node.text);
        const declaration = localDeclaration(receiver);
        if (declaration && ts.isVariableDeclaration(declaration) && declaration.initializer) receiver = unwrap(declaration.initializer);
      }
      if (ts.isAwaitExpression(receiver)) receiver = unwrap(receiver.expression);
      if (ts.isCallExpression(receiver) && receiver.expression.kind === ts.SyntaxKind.ImportKeyword
        && receiver.arguments[0] && ts.isStringLiteralLike(receiver.arguments[0])) {
        const path = appIndex?.modulePath(receiver.arguments[0].text, node.getSourceFile().fileName);
        return path ? appIndex?.declaration(path, node.text) : undefined;
      }
      return;
    }
    return localDeclaration(node);
  }
  const symbol = (node: ts.Node): OwnerSymbol | undefined => {
    if (!protocolPhase) {
      if (!ts.isIdentifier(node)) return;
      const declaration = appDeclaration(node);
      if (!declaration) return;
      let owner = appSymbols.get(declaration);
      if (!owner) {
        const name = (declaration as ts.NamedDeclaration).name;
        owner = { name: name && ts.isIdentifier(name) ? name.text : node.text,
          declarations: [declaration], valueDeclaration: declaration };
        appSymbols.set(declaration, owner);
      }
      return owner;
    }
    const found = ts.isIdentifier(node) && ts.isShorthandPropertyAssignment(node.parent)
      ? checker.getShorthandAssignmentValueSymbol(node.parent) : checker.getSymbolAtLocation(node);
    return found && found.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(found) : found;
  };
  function installedFunctions(roots: readonly ts.Node[], accepts: (path: string) => boolean): Set<ts.Node> {
    const installed = new Set<ts.Node>();
    const pending: ts.FunctionLikeDeclaration[] = [];
    function enqueue(node: ts.Node | undefined): void {
      if (!node || installed.has(node) || !ts.isFunctionLike(node) || !('body' in node) || !node.body
        || !accepts(relative(root, node.getSourceFile().fileName).replaceAll('\\', '/'))) return;
      installed.add(node);
      pending.push(node);
    }
    for (const root of roots) enqueue(root);
    while (pending.length) {
      const owner = pending.pop()!;
      function visit(node: ts.Node): void {
        if (ts.isTypeNode(node)) return;
        if (node !== owner && ts.isFunctionLike(node)) {
          if (!ts.isFunctionDeclaration(node) && !ts.isVariableDeclaration(node.parent)) enqueue(node);
          return;
        }
        if (ts.isIdentifier(node)) {
          const parent = node.parent;
          // Follow references that install or invoke a function. Asking the
          // checker about every value identifier also instantiates unrelated
          // app state and schema types, although those cannot add a call edge.
          const referenced = ts.isCallExpression(parent) && (parent.expression === node || parent.arguments.includes(node))
            || ts.isPropertyAssignment(parent) && parent.initializer === node
            || ts.isShorthandPropertyAssignment(parent)
            || ts.isReturnStatement(parent) && parent.expression === node
            || ts.isVariableDeclaration(parent) && parent.initializer === node
            || ts.isConditionalExpression(parent) && (parent.whenTrue === node || parent.whenFalse === node)
            || ts.isBinaryExpression(parent) && [ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken].includes(parent.operatorToken.kind);
          if (referenced) for (const declaration of symbol(node)?.declarations ?? []) {
            if (ts.isFunctionDeclaration(declaration)) enqueue(declaration);
            if (ts.isVariableDeclaration(declaration) && declaration.initializer) enqueue(unwrap(declaration.initializer));
          }
        }
        ts.forEachChild(node, visit);
      }
      if (owner.body) visit(owner.body);
    }
    return installed;
  }
  type Value = Readonly<{ node: ts.Node; args: ReadonlyMap<OwnerSymbol, Value> }>;
  const empty = new Map<OwnerSymbol, Value>();
  function values(value: Value, seen = new Set<ts.Node>()): Value[] {
    let node = value.node;
    if (ts.isExpression(node)) node = unwrap(node);
    if (seen.has(node)) return [];
    seen = new Set(seen).add(node);
    const next = (node: ts.Node) => values({ node, args: value.args }, seen);
    if (ts.isIdentifier(node)) {
      const owner = symbol(node);
      const argument = owner && value.args.get(owner);
      if (argument) return values(argument, seen);
      return owner?.declarations?.flatMap(declaration => ts.isVariableDeclaration(declaration) && declaration.initializer
        ? next(declaration.initializer) : ts.isFunctionDeclaration(declaration) ? [{ node: declaration, args: value.args }]
          : ts.isBindingElement(declaration) && ts.isObjectBindingPattern(declaration.parent)
            && ts.isVariableDeclaration(declaration.parent.parent) && declaration.parent.parent.initializer
            ? (() => {
              const fields = objectFields({ node: declaration.parent.parent.initializer!, args: value.args }, seen);
              if (!declaration.dotDotDotToken) return (fields.get(declaration.propertyName?.getText() ?? declaration.name.getText()) ?? [])
                .flatMap(field => values(field, seen));
              return [{ node: declaration, args: value.args }];
            })() : []) ?? [];
    }
    if (ts.isConditionalExpression(node)) return [...next(node.whenTrue), ...next(node.whenFalse)];
    if (ts.isBinaryExpression(node) && (node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
      || node.operatorToken.kind === ts.SyntaxKind.BarBarToken)) return [...next(node.left), ...next(node.right)];
    if (ts.isAwaitExpression(node)) return next(node.expression);
    if (ts.isPropertyAccessExpression(node)) return next(node.expression).flatMap(owner =>
      (objectFields(owner, seen).get(node.name.text) ?? []).flatMap(field => values(field, seen)));
    if (ts.isCallExpression(node)) {
      if (node.expression.getText() === 'Object.freeze' && node.arguments[0]) return next(node.arguments[0]);
      if (node.expression.getText() === 'Object.assign' && node.arguments[0]) {
        const target = next(node.arguments[0]);
        // Object.assign preserves a callable target and supplies own members.
        // Retain both so a method subsequently selected from the result also
        // has an actual initializer (for example nativeAdapter.preparePreset).
        return [...target.filter(value => ts.isFunctionLike(value.node)), { node, args: value.args }];
      }
      return next(node.expression).flatMap(owner => {
        const fn = owner.node;
        if (!(ts.isFunctionDeclaration(fn) || ts.isFunctionExpression(fn) || ts.isArrowFunction(fn) || ts.isMethodDeclaration(fn)) || !fn.body) return [];
        const args = new Map(owner.args);
        fn.parameters.forEach((parameter, index) => {
          const key = symbol(parameter.name);
          if (key && node.arguments[index]) args.set(key, { node: node.arguments[index], args: value.args });
        });
        if (!ts.isBlock(fn.body)) return values({ node: fn.body, args }, seen);
        const returns: Value[] = [];
        function visit(candidate: ts.Node): void {
          if (candidate !== fn.body && ts.isFunctionLike(candidate)) return;
          if (ts.isReturnStatement(candidate) && candidate.expression) returns.push(...values({ node: candidate.expression, args }, seen));
          ts.forEachChild(candidate, visit);
        }
        visit(fn.body);
        return returns;
      });
    }
    return [{ node, args: value.args }];
  }
  function objectFields(value: Value, seen = new Set<ts.Node>()): Map<string, Value[]> {
    const fields = new Map<string, Value[]>();
    for (const owner of values(value, seen)) {
      if (ts.isCallExpression(owner.node) && owner.node.expression.getText() === 'Object.assign') {
        for (const argument of owner.node.arguments) for (const [key, entries] of objectFields({ node: argument, args: owner.args },
          new Set(seen).add(owner.node))) fields.set(key, entries);
        continue;
      }
      if (ts.isBindingElement(owner.node) && owner.node.dotDotDotToken && ts.isObjectBindingPattern(owner.node.parent)
        && ts.isVariableDeclaration(owner.node.parent.parent) && owner.node.parent.parent.initializer) {
        const omitted = new Set(owner.node.parent.elements.filter(item => !item.dotDotDotToken)
          .map(item => item.propertyName?.getText() ?? item.name.getText()));
        for (const [key, entries] of objectFields({ node: owner.node.parent.parent.initializer, args: owner.args },
          new Set(seen).add(owner.node))) if (!omitted.has(key)) fields.set(key, entries);
        continue;
      }
      if (!ts.isObjectLiteralExpression(owner.node)) continue;
      for (const property of owner.node.properties) {
        if (ts.isSpreadAssignment(property)) {
          const spread = unwrap(property.expression);
          const optional = ts.isConditionalExpression(spread) && ts.isObjectLiteralExpression(unwrap(spread.whenFalse))
            && (unwrap(spread.whenFalse) as ts.ObjectLiteralExpression).properties.length === 0 ? spread : undefined;
          for (const [key, field] of objectFields({ node: property.expression, args: owner.args }, new Set(seen).add(owner.node))) {
            // `...(override ? { port: override } : {})` preserves an already
            // supplied implementation when the optional override is omitted.
            // An unresolved constructor parameter is not evidence that the
            // base implementation disappeared, or that a new port exists.
            if (optional && field.every(value => value.node.getText() === optional.condition.getText()
              && values(value).length === 0)) continue;
            fields.set(key, field);
          }
        } else if (property.name && (ts.isIdentifier(property.name) || ts.isStringLiteralLike(property.name))) {
          fields.set(property.name.text, [{ node: ts.isPropertyAssignment(property) ? property.initializer
            : ts.isShorthandPropertyAssignment(property) ? property.name : property, args: owner.args }]);
        }
      }
    }
    return fields;
  }
  function callablePorts(expression: ts.Expression, args: ReadonlyMap<OwnerSymbol, Value> = empty): string[] {
    function implemented(field: Value, seen = new Set<ts.Node>()): boolean {
      if (seen.has(field.node)) return false;
      seen = new Set(seen).add(field.node);
      return values(field).some(value => ts.isFunctionLike(value.node) || ts.isObjectLiteralExpression(value.node)
        && [...objectFields(value)].some(([, members]) => members.some(member => implemented(member, seen))));
    }
    return [...objectFields({ node: expression, args })].filter(([, fields]) => fields.some(field =>
      implemented(field))).map(([key]) => key).sort();
  }
  const compositionGraph = (() => {
  const hostPorts = new Set<string>();
  const mcpPorts = new Set<string>();
  const daemonPorts = new Set<string>();
  const uiPorts = new Set<string>();
  // Follow the actual credentialed composition through its harness. The base
  // dependency factory alone omits Account HTTP and final host overrides.
  function composition(call: ts.CallExpression, context: ReadonlyMap<OwnerSymbol, Value>, destination = hostPorts): void {
    for (const owner of values({ node: call.expression, args: context })) {
      const fn = owner.node;
      if (!(ts.isFunctionDeclaration(fn) || ts.isFunctionExpression(fn) || ts.isArrowFunction(fn)) || !fn.body) continue;
      const args = new Map(owner.args);
      fn.parameters.forEach((parameter, index) => {
        const key = symbol(parameter.name);
        if (key && call.arguments[index]) args.set(key, { node: call.arguments[index], args: context });
      });
      function visit(node: ts.Node): void {
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
          const name = symbol(node.expression)?.name;
          if (name === 'createActionExecutor' && node.arguments[0]) {
            for (const port of callablePorts(node.arguments[0], args)) destination.add(port);
          } else if (name === 'createCliActionExecutorHarness' || name === 'createCliActionExecutor'
            || name === 'createCliActionExecutionCoreFromCredentials' || name === 'createCliActionHost') composition(node, args, destination);
        }
        ts.forEachChild(node, visit);
      }
      visit(fn.body);
    }
  }
  const ingress = program.getSourceFile(resolve(root, cliIngress));
  function visitIngress(node: ts.Node): void {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)
      && symbol(node.expression)?.name === 'createCliActionExecutor') composition(node, empty);
    ts.forEachChild(node, visitIngress);
  }
  if (ingress) visitIngress(ingress);
  const mcpSource = program.getSourceFile(resolve(root, mcp));
  function visitMcp(node: ts.Node): void {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)
      && symbol(node.expression)?.name === 'createCliActionExecutorHarness') composition(node, empty, mcpPorts);
    ts.forEachChild(node, visitMcp);
  }
  if (mcpSource) visitMcp(mcpSource);
  const daemonSource = program.getSourceFile(resolve(root, daemon));
  function visitDaemon(node: ts.Node): void {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)
      && symbol(node.expression)?.name === 'createCliActionExecutorFromCredentials') composition(node, empty, daemonPorts);
    ts.forEachChild(node, visitDaemon);
  }
  if (daemonSource) visitDaemon(daemonSource);
  for (const [path, ports] of [[cli, hostPorts], [ui, uiPorts]] as const) {
    const source = program.getSourceFile(resolve(root, path));
    function visit(node: ts.Node): void {
      if (path === cli && !ingress && ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'actionDeps'
        && node.initializer) for (const port of callablePorts(node.initializer)) ports.add(port);
      if (path === ui && ts.isCallExpression(node) && ts.isIdentifier(node.expression) && symbol(node.expression)?.name === 'createActionExecutor'
        && node.arguments[0]) for (const port of callablePorts(node.arguments[0])) ports.add(port);
      ts.forEachChild(node, visit);
    }
    if (source) visit(source);
  }
  const uiSource = program.getSourceFile(resolve(root, ui));
  const appRoots = [[cliIngress, 'createCliActionExecutorFromCredentials'], [ui, 'createDefaultActionExecutor'],
    [mcp, 'createExternalMcpServer'], [sessionMcp, 'createHappierMcpServer'], [voice, 'createVoiceToolHandlers'],
    [cliCommand, 'handleActionsCommand'], [cliCompiled, 'runCompiledActionCliCommand'], [daemon, 'createDaemonExternalActionExecution']];
  const appOwnerPaths = new Set([...appRoots.map(([path]) => path),
    'apps/cli/src/mcp/runtime/createSessionAccountActionExecutor.ts', voiceExecution, frontDoor, spoken,
    toolBridge, toolRegistrar, toolDispatch, hostReverse]);
  const appInstalled = installedFunctions(appRoots.flatMap(([path, name]) =>
    program.getSourceFile(resolve(root, path))?.statements.filter(node => ts.isFunctionDeclaration(node) && node.name?.text === name) ?? []),
    path => appOwnerPaths.has(path));
  const uiFunctions = new Map<string, (ts.ArrowFunction | ts.FunctionDeclaration)[]>();
  function indexFunction(name: string, node: ts.ArrowFunction | ts.FunctionDeclaration): void {
    uiFunctions.set(name, [...uiFunctions.get(name) ?? [], node]);
  }
  function indexUi(node: ts.Node): void {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer
      && ts.isArrowFunction(node.initializer) && appInstalled.has(node.initializer)) indexFunction(node.name.text, node.initializer);
    if (ts.isFunctionDeclaration(node) && node.name && appInstalled.has(node)) indexFunction(node.name.text, node);
    ts.forEachChild(node, indexUi);
  }
  if (uiSource) indexUi(uiSource);
  function callsOwned(owner: ts.Node | undefined, name: string, path: string, installed?: ReadonlySet<ts.Node>,
    acceptsCall: (call: ts.CallExpression) => boolean = () => true): boolean {
    let found = false;
    function visit(node: ts.Node): void {
      if (node !== owner && ts.isFunctionLike(node) && installed && !installed.has(node)) return;
      if (ts.isCallExpression(node) && (ts.isIdentifier(node.expression)
        || ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === name)) {
        const callee = symbol(ts.isIdentifier(node.expression) ? node.expression : node.expression.name);
        if (callee?.name === name && callee.declarations?.some(declaration => {
          if (relative(root, declaration.getSourceFile().fileName).replaceAll('\\', '/') === path) return true;
          if (!ts.isBindingElement(declaration) || !ts.isObjectBindingPattern(declaration.parent)
            || !ts.isVariableDeclaration(declaration.parent.parent) || !declaration.parent.parent.initializer) return false;
          const initializer = unwrap(declaration.parent.parent.initializer);
          const expression = ts.isAwaitExpression(initializer) ? initializer.expression : initializer;
          if (!ts.isCallExpression(expression) || expression.expression.kind !== ts.SyntaxKind.ImportKeyword
            || !expression.arguments[0] || !ts.isStringLiteralLike(expression.arguments[0])) return false;
          return appIndex?.modulePath(expression.arguments[0].text, declaration.getSourceFile().fileName) === path;
        }) && acceptsCall(node)) found = true;
      }
      ts.forEachChild(node, visit);
    }
    if (owner) visit(owner);
    return found;
  }
  const daemonUiOwner = 'apps/ui/sources/sync/ops/actions/executeMachineActionAtDaemon.ts';
  const uiExecute = uiFunctions.get('executeAction');
  let uiMachineBranch = false;
  function machineBranch(node: ts.Node): void {
    if (ts.isFunctionLike(node) && !appInstalled.has(node)) return;
    if (ts.isConditionalExpression(node)
      && callsOwned(node.condition, 'isUiMachineOwnedAdmissionAction', daemonUiOwner)
      && callsOwned(node.whenTrue, 'executeMachineAction', ui)) uiMachineBranch = true;
    ts.forEachChild(node, machineBranch);
  }
  for (const execute of uiExecute ?? []) machineBranch(execute);
  const uiMachineDispatch = uiMachineBranch
    && (uiFunctions.get('executeMachineAction') ?? []).some(owner =>
      callsOwned(owner, 'executeMachineActionAtDaemon', daemonUiOwner, appInstalled) && callsOwned(owner, 'executeMachineOwnedAction', ui, appInstalled))
    && (uiFunctions.get('executeMachineOwnedAction') ?? []).some(owner => callsOwned(owner, 'executeOriginalAccountMachineAction',
      'apps/ui/sources/sync/api/externalActionAccountTransport.ts', appInstalled));
  const calledByInstalled = (path: string, name: string, owner: string) => [...appInstalled].some(fn =>
    relative(root, fn.getSourceFile().fileName).replaceAll('\\', '/') === path
      && callsOwned(fn, name, owner, appInstalled));
  const hostMachineDispatch = calledByInstalled(cliIngress, 'hasDeclaredActionDaemonIngress', 'packages/protocol/src/actions/originalExecution.ts')
    && calledByInstalled(cliIngress, 'requestDaemonSignedRootActionExecution', 'apps/cli/src/daemon/controlClient.ts')
    && calledByInstalled(mcp, 'hasDeclaredActionDaemonIngress', 'packages/protocol/src/actions/originalExecution.ts')
    && calledByInstalled(mcp, 'requestDaemonSignedRootActionExecution', 'apps/cli/src/daemon/controlClient.ts')
    && calledByInstalled(sessionMcp, 'createSessionAccountActionExecutor', 'apps/cli/src/mcp/runtime/createSessionAccountActionExecutor.ts');
  const reverseOwner = 'apps/ui/sources/sync/ops/actions/clientActionReverseDispatch.ts';
  const reverseSource = program.getSourceFile(resolve(root, reverseRuntime));
  const mountSource = program.getSourceFile(resolve(root, mounts));
  const reverseHandlerSource = program.getSourceFile(resolve(root, reverseOwner));
  function some(owner: ts.Node | undefined, predicate: (node: ts.Node) => boolean): boolean {
    if (!owner) return false;
    if (predicate(owner)) return true;
    return ts.forEachChild(owner, child => some(child, predicate)) === true;
  }
  const reverseComponent = reverseSource?.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'ClientActionReverseRuntime');
  const bindingHook = reverseSource?.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'useMachineClientActionBindings');
  const reverseHandler = reverseHandlerSource?.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'createUiClientActionReverseHandler');
  function initializer(node: ts.Expression): ts.Expression | undefined {
    const declaration = ts.isIdentifier(node) ? symbol(node)?.valueDeclaration : undefined;
    return declaration && ts.isVariableDeclaration(declaration) ? declaration.initializer : undefined;
  }
  const clientReverseDispatch = reverseSource ? Boolean(
    some(mountSource, node => (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node))
      && ts.isIdentifier(node.tagName) && symbol(node.tagName)?.declarations?.includes(reverseComponent!))
    && some(reverseComponent, node => {
      if (!ts.isCallExpression(node) || !ts.isIdentifier(node.expression)
        || !symbol(node.expression)?.declarations?.includes(bindingHook!) || !node.arguments[0]) return false;
      const methods = objectFields({ node: node.arguments[0], args: empty }).get('methods') ?? [];
      return methods.some(value => ts.isExpression(value.node) && some(initializer(value.node), candidate =>
        ts.isPropertyAccessExpression(candidate) && candidate.name.text === 'UI_ACTION_EXECUTE'
        && symbol(candidate.expression)?.name === 'RPC_METHODS'));
    })
    && some(bindingHook, node => {
      if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)
        || node.expression.name.text !== 'registerMachineScopedRpcHandler' || !node.arguments[2] || !node.arguments[1]) return false;
      const method = ts.isIdentifier(node.arguments[1]) ? symbol(node.arguments[1])?.valueDeclaration : undefined;
      const loop = method && ts.isVariableDeclaration(method) && ts.isVariableDeclarationList(method.parent)
        && ts.isForOfStatement(method.parent.parent) ? method.parent.parent : undefined;
      const forwarded = loop && some(initializer(loop.expression), candidate => ts.isSpreadElement(candidate)
        && ts.isIdentifier(candidate.expression) && symbol(candidate.expression)?.declarations?.some(declaration =>
          ts.isBindingElement(declaration) && declaration.name.getText() === 'methods'));
      // The default handler of the registration is the canonical reverse
      // receiver, rather than another function with a compatible annotation.
      return Boolean(forwarded && callsOwned(initializer(node.arguments[2]), 'createUiClientActionReverseHandler', reverseOwner));
    })
    && callsOwned(reverseHandler, 'createDefaultActionExecutor', ui)
    && some(reverseHandler, node => ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && node.expression.name.text === 'execute' && ts.isIdentifier(node.expression.expression)
      && symbol(node.expression.expression)?.declarations?.some(declaration => ts.isVariableDeclaration(declaration)
        && declaration.initializer && callsOwned(declaration.initializer, 'createDefaultActionExecutor', ui)))) : false;
  const voiceSource = program.getSourceFile(resolve(root, voice));
  const voiceFactory = voiceSource?.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'createVoiceToolHandlers');
  function variable(owner: ts.Node | undefined, name: string): ts.VariableDeclaration | undefined {
    let result: ts.VariableDeclaration | undefined;
    function visit(node: ts.Node): void {
      if (node !== owner && ts.isFunctionLike(node)) return;
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name) result = node;
      ts.forEachChild(node, visit);
    }
    if (owner) visit(owner);
    return result;
  }
  const voiceMap = variable(voiceSource, 'VOICE_TOOL_ACTION_ID_BY_TOOL_NAME');
  const voiceHandlers = variable(voiceFactory, 'handlers');
  const voiceExecute = variable(voiceFactory, 'execute');
  const voiceActionExecute = variable(voiceFactory, 'actionExecute');
  const namedVoiceHandlers = some(voiceFactory, node => ts.isForOfStatement(node)
    && ts.isCallExpression(node.expression) && node.expression.arguments[0] !== undefined
    && ts.isIdentifier(node.expression.arguments[0]) && symbol(node.expression.arguments[0])?.declarations?.includes(voiceMap!) === true
    && some(node.statement, candidate => ts.isBinaryExpression(candidate) && ts.isElementAccessExpression(candidate.left)
      && ts.isIdentifier(candidate.left.expression) && symbol(candidate.left.expression)?.declarations?.includes(voiceHandlers!) === true
      && callsOwned(candidate.right, 'execute', voice)));
  const genericVoiceHandler = some(voiceFactory, node => ts.isBinaryExpression(node) && ts.isElementAccessExpression(node.left)
    && ts.isIdentifier(node.left.expression) && symbol(node.left.expression)?.declarations?.includes(voiceHandlers!) === true
    && ts.isIdentifier(node.left.argumentExpression) && symbol(node.left.argumentExpression)?.declarations?.some(declaration =>
      relative(root, declaration.getSourceFile().fileName).replaceAll('\\', '/') === voiceExecution) === true
    && callsOwned(node.right, 'resolveVoiceActionExecution', voiceExecution) && callsOwned(node.right, 'execute', voice));
  const frontDoorFactory = program.getSourceFile(resolve(root, frontDoor))?.statements.find(node =>
    ts.isFunctionDeclaration(node) && node.name?.text === 'createFrontDoorActionExecute');
  const spokenFactory = program.getSourceFile(resolve(root, spoken))?.statements.find((node): node is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(node) && node.name?.text === 'executeSpokenAction');
  const voiceDispatch = voiceSource ? Boolean(namedVoiceHandlers && genericVoiceHandler
    && callsOwned(voiceMap?.initializer, 'listVoiceToolActionSpecs', 'packages/protocol/src/actions/actionSpecs.ts')
    && callsOwned(voiceActionExecute?.initializer, 'createFrontDoorActionExecute', frontDoor)
    && callsOwned(voiceExecute?.initializer, 'executeSpokenAction', spoken)
    && some(spokenFactory, node => ts.isCallExpression(node) && ts.isIdentifier(node.expression)
      && symbol(node.expression)?.declarations?.includes(spokenFactory!.parameters[0]) === true)
    && some(voiceExecute?.initializer, node => ts.isCallExpression(node) && ts.isIdentifier(node.expression)
      && symbol(node.expression)?.name === 'executeSpokenAction' && node.arguments[0] !== undefined
      && ts.isIdentifier(node.arguments[0]) && symbol(node.arguments[0])?.declarations?.includes(voiceActionExecute!) === true)
    && callsOwned(frontDoorFactory, 'createDefaultActionExecutor', ui, appInstalled)
    && some(voiceFactory, node => ts.isReturnStatement(node) && node.expression !== undefined
      && some(node.expression, candidate => ts.isIdentifier(candidate) && symbol(candidate)?.declarations?.includes(voiceHandlers!) === true))) : false;
  const ownedFunction = (path: string, name: string) => program.getSourceFile(resolve(root, path))?.statements.find(node =>
    ts.isFunctionDeclaration(node) && node.name?.text === name) as ts.FunctionDeclaration | undefined;
  const refersTo = (node: ts.Node | undefined, declaration: ts.Declaration | undefined): boolean => Boolean(node && declaration
    && ts.isIdentifier(node) && symbol(node)?.declarations?.includes(declaration));
  const field = (node: ts.Expression | undefined, name: string): ts.Expression | undefined => {
    const value = node && objectFields({ node, args: empty }).get(name)?.[0]?.node;
    return value && ts.isExpression(value) ? value : undefined;
  };
  function memberCall(owner: ts.Node | undefined, declaration: ts.Declaration | undefined, members: readonly string[],
    acceptsCall: (call: ts.CallExpression) => boolean = () => true): boolean {
    function visit(node: ts.Node): boolean {
      if (node !== owner && ts.isFunctionLike(node) && !appInstalled.has(node)) return false;
      if (ts.isCallExpression(node)) {
        let receiver: ts.Expression | undefined = node.expression;
        for (const member of [...members].reverse()) {
          receiver = receiver && ts.isPropertyAccessExpression(receiver) && receiver.name.text === member ? receiver.expression : undefined;
        }
        if (refersTo(receiver, declaration) && acceptsCall(node)) return true;
      }
      return ts.forEachChild(node, visit) === true;
    }
    return owner !== undefined && visit(owner);
  }
  const compiledFactory = ownedFunction(cliCompiled, 'runCompiledActionCliCommand');
  const invokeFactory = ownedFunction(cliCommand, 'execute');
  const compiledDefaults = variable(program.getSourceFile(resolve(root, cliCompiled)), 'DEFAULT_DEPS');
  const invokeDefaults = variable(program.getSourceFile(resolve(root, cliCommand)), 'DEFAULT_DEPS');
  const usesActualHost = (defaults: ts.VariableDeclaration | undefined) =>
    callsOwned(field(defaults?.initializer, 'createExecutorFn'), 'createCliActionExecutorFromCredentials', cliIngress);
  const compiledExecutor = variable(compiledFactory, 'executor');
  const compiledDeps = variable(compiledFactory, 'deps');
  const invocationExecutor = variable(invokeFactory, 'executor');
  const invocationExecute = variable(invokeFactory, 'executeAction');
  const carriesDefaults = (node: ts.Expression | undefined, defaults: ts.Node | undefined) => refersTo(node, defaults)
    || node !== undefined && ts.isObjectLiteralExpression(node) && node.properties.some(property =>
      ts.isSpreadAssignment(property) && refersTo(property.expression, defaults));
  const cliDispatch = compiledFactory && invokeFactory ? Boolean(appInstalled.has(compiledFactory) && appInstalled.has(invokeFactory)
    && usesActualHost(compiledDefaults) && usesActualHost(invokeDefaults)
    && carriesDefaults(compiledDeps?.initializer, compiledDefaults)
    && memberCall(compiledExecutor?.initializer, compiledDeps, ['createExecutorFn'])
    && memberCall(invocationExecutor?.initializer, invokeFactory.parameters[1], ['createExecutorFn'])
    && callsOwned(ownedFunction(cliCommand, 'handleActionsCommand'), 'execute', cliCommand, appInstalled,
      call => carriesDefaults(call.arguments[1], invokeDefaults))
    && some(invocationExecute?.initializer, node => ts.isPropertyAccessExpression(node) && node.name.text === 'execute'
      && refersTo(node.expression, invocationExecutor))
    && memberCall(compiledFactory, compiledExecutor, ['execute'], call => call.arguments[0] !== undefined
      && ts.isPropertyAccessExpression(call.arguments[0]) && call.arguments[0].name.text === 'actionId')
    && some(invokeFactory, node => ts.isCallExpression(node) && refersTo(node.expression, invocationExecute)
      && node.arguments[0] !== undefined && ts.isPropertyAccessExpression(node.arguments[0]) && node.arguments[0].name.text === 'actionId')) : false;
  const registrar = ownedFunction(toolRegistrar, 'registerHappierMcpBuiltInTools');
  const dispatcher = ownedFunction(toolDispatch, 'dispatchBuiltInHappierTool');
  const bridge = ownedFunction(toolBridge, 'createActionToolExecutorBridge');
  const toolInventory = variable(registrar, 'inventory');
  const toolRegistration = Boolean(registrar && dispatcher && bridge
    && appInstalled.has(registrar) && appInstalled.has(dispatcher) && appInstalled.has(bridge)
    && callsOwned(toolInventory?.initializer, 'createHappierToolInventory', 'apps/cli/src/agent/tools/happierTools/listBuiltInHappierTools.ts')
    && some(registrar, node => ts.isForOfStatement(node) && ts.isPropertyAccessExpression(node.expression)
      && node.expression.name.text === 'registrations' && refersTo(node.expression.expression, toolInventory)
      && memberCall(node.statement, registrar.parameters[0], ['registerTool'], call =>
        callsOwned(call.arguments[2], 'dispatchBuiltInHappierTool', toolDispatch, appInstalled)))
    && memberCall(dispatcher, dispatcher.parameters[0], ['deps', 'executeActionByToolName'], call =>
      call.arguments[0] !== undefined && ts.isPropertyAccessExpression(call.arguments[0]) && call.arguments[0].name.text === 'toolName')
    && memberCall(bridge, bridge.parameters[0], ['executor', 'execute'], call =>
      call.arguments[0] !== undefined && ts.isIdentifier(unwrap(call.arguments[0]))));
  function toolIngress(path: string, name: string): boolean {
    const factory = ownedFunction(path, name);
    if (!factory) return false;
    const executor = variable(factory, 'executor');
    const actionToolBridge = variable(factory, 'actionToolBridge');
    return toolRegistration
      && callsOwned(actionToolBridge?.initializer, 'createActionToolExecutorBridge', toolBridge, appInstalled,
        call => refersTo(field(call.arguments[0], 'executor'), executor))
      && callsOwned(factory, 'registerHappierMcpBuiltInTools', toolRegistrar, appInstalled, call => {
        const execute = field(field(call.arguments[1], 'deps'), 'executeActionByToolName');
        return execute !== undefined && ts.isPropertyAccessExpression(execute) && execute.name.text === 'executeActionByToolName'
          && refersTo(execute.expression, actionToolBridge);
      });
  }
  const sessionToolDispatch = toolIngress(sessionMcp, 'createHappierMcpServer');
  const standaloneToolDispatch = toolIngress(mcp, 'createExternalMcpServer');
  function clientPlacementRoute(path: string): boolean {
    return [...appInstalled].some(owner => relative(root, owner.getSourceFile().fileName).replaceAll('\\', '/') === path
      && some(owner, node => ts.isBinaryExpression(node)
        && [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken].includes(node.operatorToken.kind)
        && ts.isStringLiteralLike(node.right) && node.right.text === 'client' && ts.isIdentifier(node.left)
        && symbol(node.left)?.declarations?.some(declaration => ts.isVariableDeclaration(declaration)
          && callsOwned(declaration.initializer, 'resolveActionExecutionPlacementForInput', 'packages/protocol/src/actions/actionSpecs.ts')) === true));
  }
  const daemonFactory = ownedFunction(daemon, 'createDaemonExternalActionExecution');
  const hostClientDispatch = daemonSource ? Boolean(hostMachineDispatch && clientPlacementRoute(cliIngress) && clientPlacementRoute(mcp)
    && callsOwned(daemonFactory, 'createCliActionExecutorFromCredentials', cliIngress, appInstalled, call =>
      callsOwned(field(call.arguments[0], 'clientActionExecute'), 'createClientActionReverseDispatcher', hostReverse))
    && [...appInstalled].some(owner => relative(root, owner.getSourceFile().fileName).replaceAll('\\', '/') === hostReverse
      && callsOwned(owner, 'buildUiActionDispatchRequestV1', 'packages/protocol/src/actions/clientDispatchV1.ts', appInstalled)
      && memberCall(owner, variable(owner, 'client'), ['callConnectedClientRpc'], call => {
        const method = variable(owner, 'method');
        return refersTo(call.arguments[0], method) && some(method?.initializer, node => ts.isPropertyAccessExpression(node)
          && node.name.text === 'UI_ACTION_EXECUTE' && symbol(node.expression)?.declarations?.some(declaration =>
            relative(root, declaration.getSourceFile().fileName).replaceAll('\\', '/') === 'packages/protocol/src/rpc/methods.ts') === true);
      }))) : false;
  return { uiPorts: [...uiPorts].sort(), hostPorts: [...hostPorts].sort(),
    mcpPorts: mcpSource ? [...mcpPorts].sort() : undefined, daemonPorts: [...daemonPorts].sort(),
    uiMachineDispatch, clientReverseDispatch, hostMachineDispatch, voiceDispatch,
    cliDispatch, sessionToolDispatch, standaloneToolDispatch, hostClientDispatch };
  })();
  // Keep control-flow inference in the protocol graph. App-wide React/native
  // types are irrelevant to narrowing its dispatch predicates and can multiply
  // the compiler's instantiation cost when both graphs share one checker.
  protocolPhase = true;
  appIndex = undefined;
  appSymbols.clear();
  appScopes.clear();
  const protocolProgram = ts.createProgram([resolve(root, core)], options, host);
  program = protocolProgram;
  checker = protocolProgram.getTypeChecker();
  const requirements = new Map<string, Set<string>>();
  const completedCases = new Map<string, Set<string>>();
  const children = new Map<string, Set<string>>();
  const strings = (type: ts.Type): string[] => type.isUnion() ? type.types.flatMap(strings)
    : type.flags & ts.TypeFlags.StringLiteral ? [(type as ts.StringLiteralType).value] : [];
  let allActionIds = new Set<string>();
  const actionIds = program.getSourceFiles().find(source => source.fileName.replaceAll('\\', '/').endsWith('/actions/actionIds.ts'));
  const alias = actionIds?.statements.find(statement => ts.isTypeAliasDeclaration(statement) && statement.name.text === 'ActionId');
  if (alias && ts.isTypeAliasDeclaration(alias)) allActionIds = new Set(strings(checker.getTypeFromTypeNode(alias.type)));
  const dependencyOwner = program.getSourceFiles().flatMap(source => source.statements)
    .find((statement): statement is ts.TypeAliasDeclaration => ts.isTypeAliasDeclaration(statement) && statement.name.text === 'ActionExecutorDeps');
  const dependencyPorts = new Set<string>();
  function readDependencyPorts(node: ts.Node): void {
    if (ts.isTypeLiteralNode(node)) {
      for (const member of node.members) if (member.name && (ts.isIdentifier(member.name) || ts.isStringLiteralLike(member.name))) {
        dependencyPorts.add(member.name.text);
      }
    } else ts.forEachChild(node, readDependencyPorts);
  }
  if (dependencyOwner && ts.isTypeAliasDeclaration(dependencyOwner)) readDependencyPorts(dependencyOwner.type);
  function ownsDependencies(type: ts.TypeNode): boolean {
    if (ts.isTypeReferenceNode(type) && symbol(type.typeName)?.declarations?.includes(dependencyOwner!)) return true;
    return ts.forEachChild(type, node => ts.isTypeNode(node) && ownsDependencies(node)) === true;
  }
  function propertyType(type: ts.TypeNode, key: string, seen = new Set<ts.Node>()): ts.TypeNode | undefined {
    if (seen.has(type)) return;
    seen = new Set(seen).add(type);
    if (ts.isTypeLiteralNode(type)) {
      const member = type.members.find(member => member.name?.getText() === key);
      return member && ts.isPropertySignature(member) ? member.type : undefined;
    }
    if (ts.isTypeReferenceNode(type)) {
      for (const declaration of symbol(type.typeName)?.declarations ?? []) {
        if (ts.isTypeAliasDeclaration(declaration)) {
          const found = propertyType(declaration.type, key, seen);
          if (found) return found;
        }
      }
    }
    let result: ts.TypeNode | undefined;
    ts.forEachChild(type, node => { if (ts.isTypeNode(node)) result ??= propertyType(node, key, seen); });
    return result;
  }
  function receiverType(node: ts.Identifier): ts.TypeNode | undefined {
    const declaration = symbol(node)?.valueDeclaration;
    if (declaration && (ts.isParameter(declaration) || ts.isVariableDeclaration(declaration))) return declaration.type;
    if (declaration && ts.isBindingElement(declaration) && ts.isObjectBindingPattern(declaration.parent)
      && ts.isVariableDeclaration(declaration.parent.parent)) {
      const initializer = declaration.parent.parent.initializer;
      const parent = initializer && ts.isIdentifier(initializer) ? receiverType(initializer) : undefined;
      if (parent) return propertyType(parent, declaration.propertyName?.getText() ?? declaration.name.getText());
    }
    return undefined;
  }
  type Selection = { ids: Set<string>; finite: boolean };
  const unknownSelection = (): Selection => ({ ids: new Set(allActionIds), finite: false });
  const selector = (node: ts.Node): node is ts.Identifier | ts.PropertyAccessExpression =>
    ts.isIdentifier(node) && /actionId$/i.test(node.text)
    || ts.isPropertyAccessExpression(node) && /actionId$/i.test(node.name.text);
  function selection(expression: ts.Expression): Selection {
    expression = unwrap(expression);
    if (ts.isBinaryExpression(expression)) {
      const operator = expression.operatorToken.kind;
      if (operator === ts.SyntaxKind.AmpersandAmpersandToken || operator === ts.SyntaxKind.BarBarToken) {
        const left = selection(expression.left), right = selection(expression.right);
        return operator === ts.SyntaxKind.AmpersandAmpersandToken
          ? { ids: new Set([...left.ids].filter(id => right.ids.has(id))), finite: left.finite || right.finite }
          : { ids: new Set([...left.ids, ...right.ids]), finite: left.finite && right.finite };
      }
      const equals = operator === ts.SyntaxKind.EqualsEqualsEqualsToken || operator === ts.SyntaxKind.EqualsEqualsToken;
      const differs = operator === ts.SyntaxKind.ExclamationEqualsEqualsToken || operator === ts.SyntaxKind.ExclamationEqualsToken;
      if (equals || differs) {
        const selected = selector(expression.left) ? expression.left : selector(expression.right) ? expression.right : undefined;
        const other = selected === expression.left ? expression.right : expression.left;
        if (selected) {
          let ids = strings(checker.getTypeAtLocation(other));
          // A nullable local alias is produced by the real family predicate.
          // The original parameter's pre-condition type supplies no narrowing.
          const declaration = symbol(selected)?.valueDeclaration;
          if (other.kind === ts.SyntaxKind.NullKeyword && declaration && ts.isVariableDeclaration(declaration)) {
            ids = strings(checker.getTypeAtLocation(selected));
            if (differs && ids.length && ids.length < allActionIds.size) return { ids: new Set(ids), finite: true };
          }
          if (ids.length) return equals ? { ids: new Set(ids), finite: true }
            : { ids: new Set([...allActionIds].filter(id => !ids.includes(id))), finite: false };
        }
      }
    }
    if (ts.isCallExpression(expression)) {
      if (ts.isIdentifier(expression.expression)) {
        const signature = checker.getResolvedSignature(expression);
        const predicate = signature && checker.getTypePredicateOfSignature(signature);
        const ids = predicate?.type ? strings(predicate.type) : [];
        if (ids.length && ids.length < allActionIds.size) return { ids: new Set(ids), finite: true };
      } else if (ts.isPropertyAccessExpression(expression.expression)
        && ['includes', 'some'].includes(expression.expression.name.text)) {
        const argument = expression.arguments[0];
        const matches = expression.expression.name.text === 'includes' ? argument && selector(unwrap(argument))
          : argument && ts.isArrowFunction(argument) && ts.isBinaryExpression(argument.body)
            && [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken].includes(argument.body.operatorToken.kind)
            && (selector(argument.body.left) || selector(argument.body.right));
        if (!matches) return unknownSelection();
        const element = checker.getIndexTypeOfType(checker.getTypeAtLocation(unwrap(expression.expression.expression)), ts.IndexKind.Number);
        const ids = element ? strings(element) : [];
        if (ids.length && ids.length < allActionIds.size) return { ids: new Set(ids), finite: true };
      }
    }
    return unknownSelection();
  }
  function dependency(node: ts.Node): string | undefined {
    if (ts.isIdentifier(node)) {
      const declaration = symbol(node)?.valueDeclaration;
      if (declaration && ts.isVariableDeclaration(declaration) && declaration.initializer) return dependency(unwrap(declaration.initializer));
    }
    if (!ts.isPropertyAccessExpression(node) || !dependencyPorts.has(node.name.text)) return undefined;
    function expressionType(expression: ts.Expression): ts.TypeNode | undefined {
      if (ts.isIdentifier(expression)) return receiverType(expression);
      if (ts.isPropertyAccessExpression(expression)) {
        const owner = expressionType(expression.expression);
        return owner && propertyType(owner, expression.name.text);
      }
      return undefined;
    }
    const type = expressionType(node.expression);
    if (type && ownsDependencies(type)) return node.name.text;
    const supplied = type && propertyType(type, node.name.text);
    const canonical = dependencyOwner && propertyType(dependencyOwner.type, node.name.text);
    if (supplied && canonical && ts.isTypeReferenceNode(supplied) && ts.isTypeReferenceNode(canonical)
      && symbol(supplied.typeName) === symbol(canonical.typeName)) return node.name.text;
    return undefined;
  }
  function dependencyChoices(node: ts.Expression, allowed = new Set(allActionIds), seen = new Set<ts.Node>()): { port: string; ids: Set<string> }[] {
    node = unwrap(node);
    if (seen.has(node)) return [];
    seen = new Set(seen).add(node);
    if (ts.isIdentifier(node)) {
      const declaration = symbol(node)?.valueDeclaration;
      if (declaration && ts.isVariableDeclaration(declaration) && declaration.initializer) {
        return dependencyChoices(declaration.initializer, allowed, seen);
      }
    }
    if (ts.isConditionalExpression(node)) {
      const boundary = selection(node.condition);
      if (!boundary.finite) return [];
      return [...dependencyChoices(node.whenTrue, new Set([...allowed].filter(id => boundary.ids.has(id))), seen),
        ...dependencyChoices(node.whenFalse, new Set([...allowed].filter(id => !boundary.ids.has(id))), seen)];
    }
    const port = dependency(node);
    return port ? [{ port, ids: allowed }] : [];
  }
  // Follow the executor's installed functions, including callbacks supplied to
  // its helpers. An unused dispatcher declaration or barrel export supplies no
  // reachability evidence merely because the compiler loaded its source file.
  const coreSource = program.getSourceFile(resolve(root, core));
  const reachable = installedFunctions(coreSource?.statements.filter(statement => ts.isFunctionDeclaration(statement)
    && statement.name?.text === 'createActionExecutor') ?? [], path => path === core || path.startsWith('packages/protocol/src/actions/executor/'));
  for (const source of program.getSourceFiles()) {
    const path = relative(root, source.fileName).replaceAll('\\', '/');
    if (path !== core && !path.startsWith('packages/protocol/src/actions/executor/')) continue;
    function visit(node: ts.Node): void {
      if (ts.isFunctionLike(node) && !reachable.has(node)) return;
      // A finite read can produce its canonical result locally, including a
      // partial result when an optional native enrichment is absent. Such a
      // completed case has no required port unless it invokes one unguarded.
      if (ts.isIfStatement(node) && ts.isBlock(node.thenStatement)) {
        const terminal = node.thenStatement.statements.at(-1);
        const result = terminal && ts.isReturnStatement(terminal) && terminal.expression && unwrap(terminal.expression);
        const success = result && ts.isObjectLiteralExpression(result) && result.properties.some(property =>
          ts.isPropertyAssignment(property) && property.name.getText() === 'ok'
            && property.initializer.kind === ts.SyntaxKind.TrueKeyword);
        const boundary = success && selection(node.expression);
        if (boundary && boundary.finite) {
          const ports = new Set<string>();
          let guardedRefusal = false;
          function scan(candidate: ts.Node): void {
            if (ts.isFunctionLike(candidate)) return;
            if (ts.isIfStatement(candidate) && ts.isPrefixUnaryExpression(candidate.expression)
              && candidate.expression.operator === ts.SyntaxKind.ExclamationToken
              && dependencyChoices(candidate.expression.operand).length
              && /clientActionUnavailable\(|unsupported_action/.test(candidate.thenStatement.getText(source))) guardedRefusal = true;
            if (ts.isCallExpression(candidate)) {
              let receiver: ts.Expression = candidate.expression;
              while (ts.isPropertyAccessExpression(receiver)) {
                for (const choice of dependencyChoices(receiver)) {
                  let optional = false;
                  for (let parent: ts.Node | undefined = candidate.parent; parent && parent !== node; parent = parent.parent) {
                    if (ts.isConditionalExpression(parent) && parent.whenTrue.pos <= candidate.pos && parent.whenTrue.end >= candidate.end
                      && dependencyChoices(parent.condition).some(condition => condition.port === choice.port)) optional = true;
                  }
                  if (!optional) ports.add(choice.port);
                }
                receiver = receiver.expression;
              }
            }
            ts.forEachChild(candidate, scan);
          }
          scan(node.thenStatement);
          if (!guardedRefusal) for (const id of boundary.ids) completedCases.set(id, ports);
        }
      }
      // Finite orchestrations can dispatch their work through the canonical
      // child executor without owning another optional leaf port. Follow the
      // actual returned helper and the callback it receives, retaining every
      // literal child Action as an obligation of the composition.
      if (ts.isReturnStatement(node) && node.expression) {
        const expression = unwrap(ts.isAwaitExpression(node.expression) ? node.expression.expression : node.expression);
        if (ts.isCallExpression(expression) && ts.isIdentifier(expression.expression)) {
          const helper = symbol(expression.expression)?.valueDeclaration;
          if (helper && ts.isFunctionDeclaration(helper) && helper.body) {
            for (const [index, argument] of expression.arguments.entries()) {
              if (!ts.isArrowFunction(argument) || !ts.isCallExpression(argument.body)
                || !ts.isIdentifier(argument.body.expression) || argument.body.expression.text !== 'executeHostChild') continue;
              const parameter = helper.parameters[index];
              if (!parameter || !ts.isIdentifier(parameter.name) || !parameter.type || !ts.isFunctionTypeNode(parameter.type)) continue;
              const selected: string[] = [];
              let unknown = false;
              function calls(candidate: ts.Node): void {
                if (ts.isCallExpression(candidate) && ts.isIdentifier(candidate.expression)
                  && symbol(candidate.expression) === symbol(parameter.name)) {
                  const ids = candidate.arguments[0] ? strings(checker.getTypeAtLocation(candidate.arguments[0])) : [];
                  if (!ids.length || ids.some(id => !allActionIds.has(id))) unknown = true;
                  else selected.push(...ids);
                }
                ts.forEachChild(candidate, calls);
              }
              calls(helper.body);
              if (unknown || !selected.length) continue;
              for (let parent = node.parent; parent && !ts.isFunctionLike(parent); parent = parent.parent) {
                if (!ts.isIfStatement(parent) || parent.thenStatement.pos > node.pos || parent.thenStatement.end < node.end) continue;
                const boundary = selection(parent.expression);
                if (!boundary.finite) continue;
                for (const id of boundary.ids) {
                  const required = children.get(id) ?? new Set<string>();
                  for (const child of selected) required.add(child);
                  children.set(id, required);
                  if (!requirements.has(id)) requirements.set(id, new Set());
                }
                break;
              }
            }
          }
        }
      }
      if (ts.isIfStatement(node) && ts.isPrefixUnaryExpression(node.expression)
        && node.expression.operator === ts.SyntaxKind.ExclamationToken) {
        const choices = dependencyChoices(node.expression.operand);
        const refusal = node.thenStatement.getText(source);
        if (choices.length && (refusal.includes('clientActionUnavailable(') || refusal.includes('unsupported_action'))) {
          let selected = new Set(allActionIds);
          let finite = false;
          // A family dispatcher may reject other Actions before its dependency
          // guard rather than wrapping the body in a positive family branch.
          if (ts.isBlock(node.parent)) for (const previous of node.parent.statements) {
            if (previous === node) break;
            if (!ts.isIfStatement(previous) || previous.elseStatement
              || !ts.isPrefixUnaryExpression(previous.expression)
              || previous.expression.operator !== ts.SyntaxKind.ExclamationToken) continue;
            const exits = ts.isReturnStatement(previous.thenStatement)
              || ts.isBlock(previous.thenStatement) && previous.thenStatement.statements.length === 1
                && ts.isReturnStatement(previous.thenStatement.statements[0]);
            const boundary = selection(previous.expression.operand);
            if (exits && boundary.finite) {
              selected = new Set([...selected].filter(id => boundary.ids.has(id)));
              finite = true;
            }
          }
          for (let parent = node.parent; parent && !ts.isFunctionLike(parent); parent = parent.parent) {
            if (!ts.isIfStatement(parent) || parent.thenStatement.pos > node.pos || parent.thenStatement.end < node.end) continue;
            const selectors = new Set<OwnerSymbol>();
            function selectorsIn(candidate: ts.Node): void {
              const found = selector(candidate) && symbol(candidate);
              if (found) selectors.add(found);
              ts.forEachChild(candidate, selectorsIn);
            }
            selectorsIn(parent.expression);
            if (selectors.size) {
              const boundary = selection(parent.expression);
              selected = new Set([...selected].filter(id => boundary.ids.has(id)));
              finite = boundary.finite;
              if (finite) break;
            }
          }
          // Earlier exact Action cases that return have already consumed that
          // Action. A later family fallback must not add a second required
          // transport to a dispatch path it can never receive.
          for (let child: ts.Node = node; child.parent && !ts.isFunctionLike(child.parent); child = child.parent) {
            if (!ts.isBlock(child.parent)) continue;
            for (const previous of child.parent.statements) {
              if (previous === child) break;
              if (!ts.isIfStatement(previous) || previous.elseStatement) continue;
              const condition = unwrap(previous.expression);
              if (!ts.isBinaryExpression(condition)
                || ![ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.EqualsEqualsEqualsToken].includes(condition.operatorToken.kind)
                || !selector(condition.left) && !selector(condition.right)) continue;
              const terminal = ts.isReturnStatement(previous.thenStatement) || ts.isBlock(previous.thenStatement)
                && previous.thenStatement.statements.length > 0
                && ts.isReturnStatement(previous.thenStatement.statements[previous.thenStatement.statements.length - 1]);
              const boundary = selection(condition);
              if (terminal && boundary.finite) selected = new Set([...selected].filter(id => !boundary.ids.has(id)));
            }
          }
          if (!finite) {
            // A generic family dispatcher can guard its port before branching.
            // Its declared ActionId subset is authoritative; a full ActionId
            // parameter supplies no evidence about which callers reach it.
            function declared(candidate: ts.Node): void {
              if (finite || ts.isFunctionLike(candidate)) return;
              const declaration = selector(candidate) && symbol(candidate)?.valueDeclaration;
              if (declaration && (ts.isVariableDeclaration(declaration) || ts.isParameter(declaration))) {
                const ids = strings(checker.getTypeAtLocation(declaration.name));
                if (ids.length && ids.length < allActionIds.size) {
                  selected = new Set(ids); finite = true;
                }
              }
              ts.forEachChild(candidate, declared);
            }
            declared(node.thenStatement);
          }
          // A missing-port guard alone does not install an effect. Require an
          // invocation of that real dependency in the containing dispatch
          // branch (or the family function after its early exclusion).
          let scope: ts.Node = node.parent;
          for (let parent = node.parent; parent; parent = parent.parent) {
            scope = parent;
            if (ts.isFunctionLike(parent)) break;
            if (ts.isIfStatement(parent) && parent.thenStatement.pos <= node.pos
              && parent.thenStatement.end >= node.end && selection(parent.expression).finite) break;
          }
          const invoked = new Set<string>();
          const inspected = new Set<ts.Node>();
          function invocation(candidate: ts.Node): void {
            if (candidate !== scope && ts.isFunctionLike(candidate) && !reachable.has(candidate)) return;
            if (ts.isCallExpression(candidate)) {
              function receiver(expression: ts.Node): void {
                if (ts.isExpression(expression)) for (const choice of dependencyChoices(expression, selected)) invoked.add(choice.port);
                if (ts.isPropertyAccessExpression(expression)) receiver(expression.expression);
              }
              receiver(candidate.expression);
              // A family dispatcher may forward its guarded dependency into
              // an installed helper which performs the actual invocation.
              // Follow that call only when its real operands carry this port.
              const forwarded = new Set<string>();
              function operand(node: ts.Node): void {
                if (ts.isFunctionLike(node)) return;
                if (ts.isExpression(node)) for (const choice of dependencyChoices(node, selected)) forwarded.add(choice.port);
                ts.forEachChild(node, operand);
              }
              for (const argument of candidate.arguments) operand(argument);
              if (choices.some(choice => forwarded.has(choice.port)) && ts.isIdentifier(candidate.expression)) {
                const helper = symbol(candidate.expression)?.valueDeclaration;
                if (helper && ts.isFunctionDeclaration(helper) && helper.body && reachable.has(helper) && !inspected.has(helper)) {
                  inspected.add(helper);
                  invocation(helper.body);
                }
              }
            }
            ts.forEachChild(candidate, invocation);
          }
          invocation(scope);
          for (const id of finite ? selected : []) {
            const ports = requirements.get(id) ?? new Set<string>();
            for (const choice of choices) if (choice.ids.has(id) && invoked.has(choice.port)) ports.add(choice.port);
            if (ports.size) requirements.set(id, ports);
          }
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  for (const [id, ports] of completedCases) if (!requirements.has(id)) requirements.set(id, ports);
  return { requirements: Object.fromEntries([...requirements].map(([id, ports]) => [id, [...ports].sort()])),
    children: Object.fromEntries([...children].map(([id, ids]) => [id, [...ids].sort()])),
    ...compositionGraph };
}

/** Each declared surface is accounted for; unknown mappings remain findings. */
export function collectActionDispatchParity(graph: ActionDispatchGraph, specs: readonly DispatchSpec[],
  discovery: Readonly<Partial<Record<Surface, ReadonlySet<string>>>>,
  registeredRpcMethods: ReadonlySet<string>, rpcCoverage?: ReadonlySet<string>,
  uiMachineActionIds: ReadonlySet<string> = new Set(), hostMachineActionIds: ReadonlySet<string> = new Set()) {
  const findings: { actionId: string; surface: Surface | 'rpc'; reason: string; operation?: string; executor?: 'ui' | 'host' }[] = [];
  const uiPorts = new Set(graph.uiPorts);
  const hostPorts = new Set(graph.hostPorts);
  const mcpPorts = graph.mcpPorts ? new Set(graph.mcpPorts.filter(port => hostPorts.has(port))) : hostPorts;
  const daemonPorts = new Set(graph.daemonPorts);
  for (const spec of specs) {
    function checkChildren(parent: string, surface: Surface | 'rpc', host: 'ui' | 'host',
      nativePorts: ReadonlySet<string>, visited = new Set<string>()): void {
      if (visited.has(`${host}:${parent}`)) return;
      visited.add(`${host}:${parent}`);
      for (const child of graph.children?.[parent] ?? []) {
        const definition = specs.find(spec => spec.id === child);
        const reverse = host === 'host' && definition?.executionPlacement === 'client';
        const destination = reverse ? 'ui' : host;
        const destinationPorts = reverse ? uiPorts : nativePorts;
        const requirements = graph.requirements[child];
        if (!definition || !requirements) findings.push({ actionId: spec.id, surface,
          executor: destination, reason: 'dispatch_child_unmapped', operation: child });
        if (reverse && !nativePorts.has('clientActionExecute')) findings.push({ actionId: spec.id, surface,
          executor: 'host', reason: 'callable_port_missing', operation: 'clientActionExecute' });
        for (const port of requirements ?? []) if (!destinationPorts.has(port)) findings.push({ actionId: spec.id,
          surface, executor: destination, reason: 'callable_port_missing', operation: port });
        checkChildren(child, surface, destination, destinationPorts, visited);
      }
    }
    for (const surface of ['ui', 'agent', 'mcp', 'cli', 'voice'] as const) {
      if (spec.surfaces[surface] !== true) continue;
      if (!discovery[surface]?.has(spec.id)) findings.push({ actionId: spec.id, surface, reason: 'surface_undiscoverable' });
      if (surface === 'voice' && graph.voiceDispatch === false) findings.push({ actionId: spec.id, surface, reason: 'voice_forwarding_unverified' });
      if (surface === 'cli' && graph.cliDispatch === false) findings.push({ actionId: spec.id, surface, reason: 'cli_forwarding_unverified' });
      if ((surface === 'mcp' || surface === 'agent') && graph.sessionToolDispatch === false) findings.push({ actionId: spec.id, surface,
        reason: 'session_tool_forwarding_unverified' });
      if (surface === 'mcp' && graph.standaloneToolDispatch === false) findings.push({ actionId: spec.id, surface,
        reason: 'standalone_tool_forwarding_unverified' });
      const executors = surface === 'voice' ? ['ui', 'host'] as const : [surface === 'ui' ? 'ui' : 'host'] as const;
      for (const executor of executors) {
        const nativePorts = executor === 'ui' ? uiPorts : surface === 'mcp' ? mcpPorts : hostPorts;
        const required = graph.requirements[spec.id];
        const clientReverse = spec.executionPlacement === 'client' && executor === 'host';
        if (clientReverse && graph.clientReverseDispatch === false) findings.push({ actionId: spec.id, surface,
          executor: 'ui', reason: 'client_reverse_forwarding_unverified' });
        if (clientReverse && graph.hostClientDispatch === false) findings.push({ actionId: spec.id, surface,
          executor: 'host', reason: 'host_client_forwarding_unverified' });
        const machineForward = executor === 'ui' ? uiMachineActionIds.has(spec.id) : hostMachineActionIds.has(spec.id);
        if (machineForward && !(executor === 'ui' ? graph.uiMachineDispatch : graph.hostMachineDispatch)) findings.push({ actionId: spec.id, surface,
          executor, reason: 'machine_forwarding_unverified' });
        const ports = clientReverse ? ['clientActionExecute'] : required;
        const executionPorts = machineForward || clientReverse && graph.hostClientDispatch === true ? daemonPorts : nativePorts;
        if (!ports) findings.push({ actionId: spec.id, surface, executor, reason: 'dispatch_unmapped' });
        for (const port of ports ?? []) if (!executionPorts.has(port)) {
          findings.push({ actionId: spec.id, surface, executor, reason: 'callable_port_missing', operation: port });
        }
        // Client placement travels through the host reverse transport and then
        // the real UI executor, even when UI discovery itself is disabled.
        if (clientReverse) {
          if (!required) findings.push({ actionId: spec.id, surface, executor: 'ui', reason: 'dispatch_unmapped' });
          for (const port of required ?? []) if (!uiPorts.has(port)) findings.push({ actionId: spec.id,
            surface, executor: 'ui', reason: 'callable_port_missing', operation: port });
        }
        checkChildren(spec.id, surface, clientReverse ? 'ui' : machineForward ? 'host' : executor,
          clientReverse ? uiPorts : executionPorts);
      }
    }
    if (spec.surfaces.rpc === true) {
      // Registration alone does not make a receiver executable. Its native
      // dependencies must also exist in the production daemon composition;
      // the registration census intentionally never supplies effect ports.
      const required = graph.requirements[spec.id];
      if (!required) findings.push({ actionId: spec.id, surface: 'rpc', reason: 'dispatch_unmapped' });
      for (const port of required ?? []) if (!daemonPorts.has(port)) findings.push({ actionId: spec.id,
        surface: 'rpc', executor: 'host', reason: 'callable_port_missing', operation: port });
      checkChildren(spec.id, 'rpc', 'host', daemonPorts);
      const methods = [spec.bindings?.rpcMethod, ...(spec.bindings?.rpcMethodAliases ?? [])].filter((method): method is string => !!method);
      if (!methods.length) {
        findings.push({ actionId: spec.id, surface: 'rpc', reason: 'rpc_binding_missing' });
      }
      for (const method of methods) if (!registeredRpcMethods.has(method)) {
        findings.push({ actionId: spec.id, surface: 'rpc', reason: !rpcCoverage || rpcCoverage.has(spec.id)
          ? 'rpc_method_missing' : 'rpc_receiver_unverified', operation: method });
      }
    }
  }
  return findings;
}
