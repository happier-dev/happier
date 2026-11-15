import ts from 'typescript';
import { SOURCE_PARITY_EXCLUSIONS } from './uiActionParityExclusions.ts';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, posix, resolve as resolvePath } from 'node:path';

export type UiParitySource = Readonly<{ filePath: string; content: string }>;
type Surfaces = Readonly<{ ui?: boolean; agent?: boolean; mcp?: boolean; cli?: boolean }>;
type Spec = Readonly<{ id: string; surfaces: Surfaces; cli?: Readonly<{ commands?: readonly unknown[] }> }>;
type Setting = Readonly<{ anchor: string; surfaces?: Surfaces; storage?: Readonly<{
  scope: string; key?: string; path?: readonly string[]; access?: string;
}> }>;
type Site = Readonly<{ filePath: string; line: number }>;
export type UiParityFinding = Site & Readonly<{
  code: 'unregistered_action' | 'agent_unavailable' | 'mcp_unavailable' | 'cli_command_missing'
    | 'dynamic_action' | 'setting_unmapped' | 'dynamic_setting' | 'direct_settings_write' | 'direct_external_link' | 'direct_occurrence_write'
    | 'direct_pending_content_write' | 'direct_external_follow_write' | 'direct_clipboard_write' | 'direct_reviewed_mark_write'
    | 'direct_desktop_window_write' | 'direct_message_pin_write' | 'direct_view_control_write' | 'direct_session_runner_restart'
    | 'direct_project_trust_write' | 'direct_saved_secret_repair' | 'direct_session_draft_open';
  operation: string;
}>;
type Discovery = Readonly<{ agentIds?: ReadonlySet<string>; mcpIds?: ReadonlySet<string>;
  cliIds?: ReadonlySet<string>; cliCommandIds?: ReadonlySet<string>;
  agentExclusionReasons?: ReadonlyMap<string, string>;
  settingBindings?: ReadonlyMap<string, readonly string[]>; sourceRoot?: string }>;

function unwrap(node: ts.Expression): ts.Expression {
  if (ts.isAsExpression(node) || ts.isSatisfiesExpression(node) || ts.isParenthesizedExpression(node)
    || ts.isTypeAssertionExpression(node) || ts.isNonNullExpression(node)) return unwrap(node.expression);
  return node;
}

export function readUiActionParitySources(root: string): UiParitySource[] {
  const output: UiParitySource[] = [];
  function walk(directory: string): void {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.[cm]?[jt]sx?$/.test(entry.name) && !/\.(test|spec|testHarness|testkit|fixture)\./.test(entry.name)
        && !/(?:TestHarness|Testkit)\.[cm]?[jt]sx?$/.test(entry.name)
        && !entry.name.endsWith('.d.ts') && !/[\\/]dev[\\/]testkit[\\/]|[\\/]__tests__[\\/]/.test(path)) {
        output.push({ filePath: relative(root, path).replaceAll('\\', '/'), content: readFileSync(path, 'utf8') });
      }
    }
  }
  walk(join(root, 'apps/ui/sources'));
  return output;
}

/** Source inventory, not a second catalog. Unknown/dynamic operations remain findings. */
export function collectUiActionParity(files: readonly UiParitySource[], specs: readonly Spec[],
  declarations: readonly Setting[], discovery: Discovery = {}) {
  const catalog = new Map(specs.map(spec => [spec.id, spec]));
  const actions: (Site & { actionId: string })[] = [];
  const settings: (Site & { key: string; scope: string })[] = [];
  const findings: UiParityFinding[] = [];
  const exclusions: (Site & { reason: string })[] = [];
  function exclude(operation: string, site: Site): boolean {
    const exclusion = SOURCE_PARITY_EXCLUSIONS.find(entry => entry.filePath === site.filePath && entry.operation === operation);
    if (!exclusion) return false;
    exclusions.push({ ...site, reason: exclusion.reason });
    return true;
  }
  const contents = new Map(files.map(file => [file.filePath, file.content]));
  // Resolve first-party source operands without loading the framework type graph.
  const root = discovery.sourceRoot ?? resolvePath('/__ui_action_parity__');
  const relativePath = (path: string) => relative(root, resolvePath(root, path)).replaceAll('\\', '/');
  const options: ts.CompilerOptions = { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler, jsx: ts.JsxEmit.Preserve,
    strict: true, noEmit: true, skipLibCheck: true, baseUrl: root,
    paths: { '@/*': ['apps/ui/sources/*'], '@happier-dev/protocol': ['packages/protocol/src/index.ts'],
      '@happier-dev/protocol/*': ['packages/protocol/src/*'] } };
  const host = ts.createCompilerHost(options, true);
  const readExternal = host.readFile;
  const externalExists = host.fileExists;
  const mayReadExternal = (path: string) => !!discovery.sourceRoot
    && (relativePath(path).startsWith('packages/') || relativePath(path).startsWith('apps/ui/sources/'));
  host.getCurrentDirectory = () => root;
  host.fileExists = path => contents.has(relativePath(path)) || mayReadExternal(path) && externalExists(path);
  host.readFile = path => contents.get(relativePath(path)) ?? (mayReadExternal(path) ? readExternal(path) : undefined);
  const directories = new Set<string>();
  for (const path of contents.keys()) {
    let parent = posix.dirname(path);
    while (parent !== '.') { directories.add(parent); parent = posix.dirname(parent); }
  }
  const directoryExists = new Map<string, boolean>();
  host.directoryExists = path => {
    if (!directoryExists.has(path)) directoryExists.set(path, directories.has(relativePath(path))
      || !!discovery.sourceRoot && ts.sys.directoryExists(path));
    return directoryExists.get(path)!;
  };
  const resolutionCache = ts.createModuleResolutionCache(root, path => path, options);
  const modules = new Map<string, { source: ts.SourceFile; values: Map<string, ts.Expression>;
    types: Map<string, ts.TypeNode>; imports: Map<string, { path: string; name: string }>; exports: string[];
    actionArguments: Map<string, number> }>();
  function module(path: string) {
    path = relativePath(path);
    const cached = modules.get(path);
    if (cached) return cached;
    const content = host.readFile(resolvePath(root, path));
    if (content === undefined) return undefined;
    const source = ts.createSourceFile(path, content, ts.ScriptTarget.Latest, true);
    const result = { source, values: new Map<string, ts.Expression>(),
      types: new Map<string, ts.TypeNode>(), imports: new Map<string, { path: string; name: string }>(), exports: [] as string[],
      actionArguments: new Map<string, number>() };
    modules.set(path, result);
    for (const statement of source.statements) {
      if (ts.isFunctionDeclaration(statement) && statement.name && /^(execute|invoke|dispatch|call.*Action)/.test(statement.name.text)) {
        // Resource adapters put the Action after their scope/input. Follow the
        // authored family type, including a generic constrained to that family.
        const actionType = (type: ts.TypeNode | undefined) => !!type && ts.isTypeReferenceNode(type)
          && ts.isIdentifier(type.typeName) && /ActionId$/.test(type.typeName.text);
        const actionRequestType = (type: ts.TypeNode | undefined): boolean => {
          if (type && ts.isTypeReferenceNode(type) && type.typeName.getText() === 'Readonly') return actionRequestType(type.typeArguments?.[0]);
          return !!type && ts.isTypeLiteralNode(type)
            && type.members.some(member => ts.isPropertySignature(member) && member.name.getText() === 'actionId' && actionType(member.type)
              && member.type && ts.isTypeReferenceNode(member.type)
              && symbol(path, member.type.typeName.getText(), 'types')?.getSourceFile().fileName.startsWith('packages/protocol/src/actions/'))
            && type.members.some(member => ts.isPropertySignature(member) && member.name.getText() === 'input');
        };
        const index = statement.parameters.findIndex(parameter => {
          const type = parameter.type;
          return actionType(type) || actionRequestType(type) || type && ts.isTypeReferenceNode(type) && statement.typeParameters?.some(generic =>
            generic.name.text === type.typeName.getText() && actionType(generic.constraint));
        });
        if (index >= 0) result.actionArguments.set(statement.name.text, index);
      }
      if (ts.isVariableStatement(statement)) for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.initializer) result.values.set(declaration.name.text, declaration.initializer);
        if (ts.isIdentifier(declaration.name) && declaration.type) result.types.set(declaration.name.text, declaration.type);
      }
      if (ts.isTypeAliasDeclaration(statement)) result.types.set(statement.name.text, statement.type);
      if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
        const specifier = statement.moduleSpecifier.text;
        const targetPath = ts.resolveModuleName(specifier, resolvePath(root, path), options, host, resolutionCache).resolvedModule?.resolvedFileName;
        const target = targetPath && relativePath(targetPath);
        const bindings = statement.importClause?.namedBindings;
        if (target && bindings && ts.isNamedImports(bindings)) for (const binding of bindings.elements) {
          result.imports.set(binding.name.text, { path: target, name: binding.propertyName?.text ?? binding.name.text });
        }
      }
      if (ts.isExportDeclaration(statement) && statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)) {
        const targetPath = ts.resolveModuleName(statement.moduleSpecifier.text, resolvePath(root, path), options, host, resolutionCache).resolvedModule?.resolvedFileName;
        const target = targetPath && relativePath(targetPath);
        if (target && !statement.exportClause) result.exports.push(target);
        if (target && statement.exportClause && ts.isNamedExports(statement.exportClause)) for (const binding of statement.exportClause.elements) {
          result.imports.set(binding.name.text, { path: target, name: binding.propertyName?.text ?? binding.name.text });
        }
      }
    }
    return result;
  }
  function actionArgument(path: string, name: string, seen = new Set<string>()): number | undefined {
    const key = `${path}:${name}`;
    if (seen.has(key)) return undefined;
    seen.add(key);
    const owner = module(path);
    const local = owner?.actionArguments.get(name);
    if (local !== undefined) return local;
    const imported = owner?.imports.get(name);
    if (imported) return actionArgument(imported.path, imported.name, seen);
    for (const path of owner?.exports ?? []) {
      const index = actionArgument(path, name, seen);
      if (index !== undefined) return index;
    }
    return undefined;
  }
  function symbol(path: string, name: string, kind: 'values' | 'types', seen = new Set<string>()): ts.Expression | ts.TypeNode | undefined {
    const key = `${path}:${name}:${kind}`;
    if (seen.has(key)) return undefined;
    seen.add(key);
    const owner = module(path);
    const local = owner?.[kind].get(name);
    if (local) return local;
    const imported = owner?.imports.get(name);
    if (imported) return symbol(imported.path, imported.name, kind, seen);
    for (const path of owner?.exports ?? []) {
      const exported = symbol(path, name, kind, seen);
      if (exported) return exported;
    }
    return undefined;
  }
  function property(node: ts.Expression, key: string): ts.Expression | undefined {
    node = resolve(node);
    if (!ts.isObjectLiteralExpression(node)) return undefined;
    const value = node.properties.find(value => (ts.isPropertyAssignment(value) || ts.isShorthandPropertyAssignment(value))
      && value.name.getText().replaceAll(/['"]/g, '') === key);
    return value && ts.isPropertyAssignment(value) ? value.initializer
      : value && ts.isShorthandPropertyAssignment(value) ? value.name : undefined;
  }
  function resolve(node: ts.Expression, seen = new Set<ts.Node>()): ts.Expression {
    node = unwrap(node);
    if (seen.has(node)) return node;
    seen.add(node);
    if (ts.isIdentifier(node)) {
      const value = symbol(node.getSourceFile().fileName, node.text, 'values');
      if (value && ts.isExpression(value)) return resolve(value, seen);
    }
    if (ts.isPropertyAccessExpression(node)) {
      const object = resolve(node.expression, seen);
      if (ts.isObjectLiteralExpression(object)) {
        const field = property(object, node.name.text);
        if (field) return resolve(field, seen);
      }
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && node.expression.expression.getText() === 'Object' && node.expression.name.text === 'freeze' && node.arguments[0]) {
      return resolve(node.arguments[0], seen);
    }
    return node;
  }
  function scalar(node: ts.Expression | undefined): string | undefined {
    if (!node) return undefined;
    const value = resolve(node);
    return ts.isStringLiteralLike(value) ? value.text : undefined;
  }
  function pageAnchor(input: ts.Expression, settingId: string): string | undefined {
    const pageId = scalar(property(input, 'pageId'));
    const subpage = property(input, 'subpage');
    const subId = subpage && scalar(property(subpage, 'id'));
    const prefix = subpage && subId && scalar(property(subpage, 'anchors')) !== 'page' ? `${pageId}.${subId}` : pageId;
    const sections = property(input, 'sections');
    const resolvedSections = sections && resolve(sections);
    let explicit: string | undefined;
    if (resolvedSections && ts.isObjectLiteralExpression(resolvedSections)) {
      for (const section of resolvedSections.properties) {
        if (!ts.isPropertyAssignment(section)) continue;
        const settings = property(section.initializer, 'settings');
        const row = settings && property(settings, settingId);
        explicit = row && scalar(property(row, 'anchor'));
        if (explicit) break;
      }
    }
    const candidate = explicit ?? `${prefix}.${settingId}`;
    return declarations.some(declaration => declaration.anchor === candidate) ? candidate : undefined;
  }
  // Infer semantic binding root writes only from actual page-attached storage callbacks.
  const semanticWrites = new Map<string, Set<string>>();
  for (const file of files) {
    const dependency = modules.has(file.filePath);
    const source = module(file.filePath)!.source;
    function bindings(node: ts.Node): void {
      if (ts.isPropertyAssignment(node) && node.name.getText(source).replaceAll(/['"]/g, '') === 'storage') {
        const setting = node.parent.parent;
        let page: ts.Node | undefined = node.parent;
        while (page && !(ts.isCallExpression(page) && ts.isIdentifier(page.expression) && page.expression.text === 'defineSettingsPage')) page = page.parent;
        const settingAnchor = page && ts.isCallExpression(page) && page.arguments[0] && ts.isPropertyAssignment(setting)
          ? pageAnchor(page.arguments[0], setting.name.getText(source).replaceAll(/['"]/g, '')) : undefined;
        const declaration = declarations.find(declaration => declaration.anchor === settingAnchor);
        const storage = resolve(node.initializer);
        const scope = scalar(property(storage, 'scope'));
        if (settingAnchor && declaration?.surfaces?.agent !== false && declaration?.storage?.access === 'read_write'
          && scope && scalar(property(storage, 'access')) === 'read_write') {
          for (const callbackName of ['mutate', 'commit']) {
            const callback = property(storage, callbackName);
            const fn = callback && resolve(callback);
            if (fn && (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn))) {
              const writer = callbackName === 'commit' ? fn.parameters[2]?.name.getText() : undefined;
              const add = (expression: ts.Expression) => {
                expression = unwrap(expression);
                if (ts.isConditionalExpression(expression)) { add(expression.whenTrue); add(expression.whenFalse); }
                else if (ts.isObjectLiteralExpression(expression)) for (const field of expression.properties) {
                  if (ts.isPropertyAssignment(field) || ts.isShorthandPropertyAssignment(field)) {
                    const key = ts.isComputedPropertyName(field.name) ? scalar(field.name.expression)
                      : field.name.getText().replaceAll(/['"]/g, '');
                    if (key) {
                      const anchors = semanticWrites.get(`${scope}:${key}`) ?? new Set<string>();
                      anchors.add(settingAnchor);
                      semanticWrites.set(`${scope}:${key}`, anchors);
                    }
                  }
                }
              };
              function writes(child: ts.Node): void {
                if (ts.isFunctionLike(child)) return;
                if (callbackName === 'mutate' && ts.isReturnStatement(child) && child.expression) add(child.expression);
                if (writer && ts.isCallExpression(child) && ts.isIdentifier(child.expression)
                  && child.expression.text === writer && child.arguments[0]) add(child.arguments[0]);
                ts.forEachChild(child, writes);
              }
              if (callbackName === 'mutate' && ts.isArrowFunction(fn) && !ts.isBlock(fn.body)) add(fn.body);
              writes(fn.body);
            }
          }
        }
      }
      ts.forEachChild(node, bindings);
    }
    bindings(source);
    if (!dependency) modules.delete(file.filePath);
  }

  function checkAction(actionId: string, site: Site): void {
    if (actionId === 'composer.attachments.pick' && site.filePath.startsWith('apps/ui/sources/embed/')) {
      exclusions.push({ ...site, reason: 'OS file picker in embed frames (WAVE5)' });
      return;
    }
    actions.push({ ...site, actionId });
    if (exclude(actionId, site)) return;
    const spec = catalog.get(actionId);
    const exclusionReason = discovery.agentExclusionReasons?.get(actionId);
    if (spec && !spec.surfaces.agent && exclusionReason) {
      exclusions.push({ ...site, reason: exclusionReason });
      return;
    }
    const finding = (code: UiParityFinding['code']) => findings.push({ ...site, code, operation: actionId });
    if (!spec) finding('unregistered_action');
    else if (!spec.surfaces.agent || (discovery.agentIds && !discovery.agentIds.has(actionId))) finding('agent_unavailable');
    else if (spec.surfaces.mcp && discovery.mcpIds && !discovery.mcpIds.has(actionId)) finding('mcp_unavailable');
    else if (spec.surfaces.cli && discovery.cliIds && !discovery.cliIds.has(actionId)) finding('cli_command_missing');
    else if (spec.cli?.commands?.length && discovery.cliCommandIds && !discovery.cliCommandIds.has(actionId)) finding('cli_command_missing');
  }

  function checkSetting(key: string, scope: string, site: Site, directWriter?: string): void {
    settings.push({ ...site, key, scope });
    if (exclude(`${scope}:${key}`, site)) return;
    if (directWriter) {
      findings.push({ ...site, code: 'direct_settings_write', operation: directWriter });
      return;
    }
    if (scope === 'account' && key === 'preferredLanguage'
      && declarations.some(declaration => declaration.anchor === 'language.appLanguage'
        && declaration.storage?.access === 'read_only')) {
      exclusions.push({ ...site, reason: 'language read-only exclusion (WAVE5 coordination ruling)' });
      return;
    }
    // A declaration for one nested field cannot prove an arbitrary whole-object setter.
    const matching = declarations.filter(setting => setting.storage?.scope === scope && setting.storage.key === key
      && !setting.storage.path?.length && setting.storage.access !== 'read_only');
    const admittedSemanticBinding = discovery.settingBindings?.get(`${scope}:${key}`)?.some(anchor =>
      declarations.some(declaration => declaration.anchor === anchor && declaration.surfaces?.agent !== false
        && declaration.storage?.access === 'read_write'));
    if (!matching.some(setting => setting.surfaces?.agent !== false)
      && !semanticWrites.has(`${scope}:${key}`) && !admittedSemanticBinding) {
      findings.push({ ...site, code: 'setting_unmapped', operation: `${scope}:${key}` });
    } else checkAction('settings.set', site);
  }

  function checkAnchor(anchor: string, site: Site): void {
    settings.push({ ...site, key: anchor, scope: 'declaration' });
    const declaration = declarations.find(setting => setting.anchor === anchor);
    if (!declaration?.storage || declaration.storage.access === 'read_only') {
      findings.push({ ...site, code: 'setting_unmapped', operation: anchor });
    } else if (declaration.surfaces?.agent === false) {
      findings.push({ ...site, code: 'agent_unavailable', operation: `settings.set:${anchor}` });
    } else checkAction('settings.set', site);
  }

  for (const file of files) {
    // WAVE5's pre-sign-in bootstrap exclusion. Authenticated onboarding is still walked.
    if (file.filePath.includes('/onboarding/preAuth/')) {
      exclusions.push({ filePath: file.filePath, line: 1, reason: 'pre-sign-in bootstrap (WAVE5)' });
      continue;
    }
    // Keep operand dependencies, but release census-only syntax trees after each file.
    const dependency = modules.has(file.filePath);
    const source = module(file.filePath)!.source;
    const aliases = new Map<string, string>();
    const currentUiContextLocalCommandHooks = new Set<string>();
    type Binding = Readonly<{ initializer?: ts.Expression; annotation?: ts.TypeNode; parameter?: boolean; writer?: string; dispatch?: boolean; actionArgument?: number;
      iterations?: readonly ts.Expression[];
      mutable?: Readonly<{ key: ts.Expression; scope: string }> }>;
    const bindings = new Map<ts.Node, Map<string, Binding>>();
    const mutableNames = new Set<string>();
    const isScope = (node: ts.Node) => ts.isSourceFile(node) || ts.isBlock(node) || ts.isFunctionLike(node) || ts.isForOfStatement(node);
    function declare(node: ts.Node, identifier: string, binding: Binding): void {
      let scope = node.parent;
      while (scope && !isScope(scope)) scope = scope.parent;
      if (!scope) return;
      let locals = bindings.get(scope);
      if (!locals) { locals = new Map(); bindings.set(scope, locals); }
      locals.set(identifier, binding);
    }
    function lookup(node: ts.Node, identifier: string): Binding | undefined {
      let scope: ts.Node | undefined = node;
      while (scope) {
        const binding = bindings.get(scope)?.get(identifier);
        if (binding) return binding;
        scope = scope.parent;
      }
      return undefined;
    }
    const location = (node: ts.Node): Site => {
      const owner = node.getSourceFile();
      return { filePath: relativePath(owner.fileName), line: owner.getLineAndCharacterOfPosition(node.getStart(owner)).line + 1 };
    };
    function name(node: ts.Expression): string {
      if (ts.isIdentifier(node)) return aliases.get(node.text) ?? node.text;
      return ts.isPropertyAccessExpression(node) ? node.name.text : '';
    }
    // Contextually typed wrappers move operand checking to their callers. Only
    // the unchanged operand on that same executor is a redundant inner site.
    function executorAnnotation(node: ts.ArrowFunction | ts.FunctionExpression): ts.QualifiedName | undefined {
      const parent = node.parent;
      const type = ts.isVariableDeclaration(parent) ? parent.type
        : ts.isCallExpression(parent) && /^(useCallback|useMemo)$/.test(name(parent.expression))
          ? parent.typeArguments?.[0] : undefined;
      if (!type || !ts.isTypeQueryNode(type) || !ts.isQualifiedName(type.exprName)) return undefined;
      const target = type.exprName;
      return target.right.text === 'execute' && ts.isIdentifier(target.left)
        && /(?:[Aa]ction|executor)/.test(target.left.text) ? target : undefined;
    }
    function isExecutorForward(node: ts.CallExpression): boolean {
      const callback = ts.findAncestor(node, ts.isFunctionLike);
      if (!callback || !(ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))) return false;
      const target = executorAnnotation(callback);
      const parameter = callback.parameters[0];
      const operand = node.arguments[0] && unwrap(node.arguments[0]);
      const callee = unwrap(node.expression);
      return !!target && !!parameter && ts.isIdentifier(parameter.name) && !!operand && ts.isIdentifier(operand)
        && operand.text === parameter.name.text && lookup(operand, operand.text)?.parameter === true
        && lookup(operand, operand.text) === lookup(parameter.name, parameter.name.text)
        && ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression)
        && ts.isIdentifier(target.left) && callee.expression.text === target.left.text
        && callee.name.text === target.right.text
        && lookup(callee.expression, callee.expression.text) === lookup(target, target.left.text);
    }
    function complete(parts: (string[] | undefined)[]): string[] | undefined {
      return parts.every(part => part !== undefined) ? [...new Set(parts.flat())] : undefined;
    }
    function queryValue(type: ts.TypeQueryNode): ts.Expression | undefined {
      function value(name: ts.EntityName): ts.Expression | undefined {
        if (ts.isIdentifier(name)) {
          const found = symbol(type.getSourceFile().fileName, name.text, 'values');
          return found && ts.isExpression(found) ? resolve(found) : undefined;
        }
        const owner = value(name.left);
        const field = owner && property(owner, name.right.text);
        return field && resolve(field);
      }
      return value(type.exprName);
    }
    function elements(expression: ts.Expression, seen: Set<ts.Node>): string[] | undefined {
      const value = resolve(expression);
      if (ts.isCallExpression(value) && ts.isPropertyAccessExpression(value.expression)
        && value.expression.expression.getText() === 'Object' && value.expression.name.text === 'values'
        && value.arguments[0]) return elements(value.arguments[0], seen);
      if (ts.isArrayLiteralExpression(value)) return complete(value.elements.map(element =>
        ts.isSpreadElement(element) ? elements(element.expression, seen) : finiteStrings(element, new Set(seen))));
      if (ts.isObjectLiteralExpression(value)) return complete(value.properties.map(field =>
        ts.isPropertyAssignment(field) ? elements(field.initializer, new Set(seen))
          : ts.isShorthandPropertyAssignment(field) ? elements(field.name, new Set(seen)) : undefined));
      return finiteStrings(value, seen);
    }
    function typeDefinition(type: ts.TypeNode, seen = new Set<ts.Node>()): ts.TypeNode {
      if (seen.has(type)) return type;
      seen.add(type);
      if (ts.isTypeReferenceNode(type) && ts.isIdentifier(type.typeName)) {
        if (type.typeName.text === 'Readonly' && type.typeArguments?.[0]) return typeDefinition(type.typeArguments[0], seen);
        // A forwarding adapter's generic belongs to its lexical declaration,
        // ahead of any same-named module alias. Check the whole finite family;
        // an unconstrained/open generic must remain unresolved.
        const parameterName = type.typeName.text;
        const owner = ts.findAncestor(type, node => (ts.isFunctionLike(node) || ts.isTypeAliasDeclaration(node)
          || ts.isInterfaceDeclaration(node) || ts.isClassDeclaration(node))
          && !!node.typeParameters?.some(parameter => parameter.name.text === parameterName));
        if (owner && (ts.isFunctionLike(owner) || ts.isTypeAliasDeclaration(owner)
          || ts.isInterfaceDeclaration(owner) || ts.isClassDeclaration(owner))) {
          const parameter = owner.typeParameters?.find(parameter => parameter.name.text === parameterName);
          return parameter?.constraint ? typeDefinition(parameter.constraint, seen) : type;
        }
        const definition = symbol(type.getSourceFile().fileName, type.typeName.text, 'types');
        if (definition && ts.isTypeNode(definition) && definition !== type) return typeDefinition(definition, seen);
      }
      return type;
    }
    function expressionType(expression: ts.Expression): ts.TypeNode | undefined {
      expression = unwrap(expression);
      if (ts.isIdentifier(expression)) {
        const local = lookup(expression, expression.text);
        if (local) return local.annotation;
        const type = symbol(expression.getSourceFile().fileName, expression.text, 'types');
        return type && ts.isTypeNode(type) ? type : undefined;
      }
      if (ts.isPropertyAccessExpression(expression)) {
        const owner = expressionType(expression.expression);
        const type = owner && typeDefinition(owner);
        if (type && ts.isTypeLiteralNode(type)) {
          const member = type.members.find(member => ts.isPropertySignature(member)
            && member.name.getText().replaceAll(/['"]/g, '') === expression.name.text);
          return member && ts.isPropertySignature(member) ? member.type : undefined;
        }
      }
      return undefined;
    }
    function typeStrings(type: ts.TypeNode, seen = new Set<ts.Node>()): string[] | undefined {
      if (seen.has(type)) return undefined;
      seen.add(type);
      if (ts.isLiteralTypeNode(type) && ts.isStringLiteralLike(type.literal)) return [type.literal.text];
      if (ts.isUnionTypeNode(type)) return complete(type.types.map(member => typeStrings(member, new Set(seen))));
      if (ts.isParenthesizedTypeNode(type)) return typeStrings(type.type, seen);
      if (ts.isTypeReferenceNode(type) && ts.isIdentifier(type.typeName)) {
        if ((type.typeName.text === 'Exclude' || type.typeName.text === 'Extract') && type.typeArguments?.length === 2) {
          const all = typeStrings(type.typeArguments[0], new Set(seen));
          const selected = typeStrings(type.typeArguments[1], new Set(seen));
          return all && selected ? all.filter(value => selected.includes(value) === (type.typeName.getText() === 'Extract')) : undefined;
        }
        const definition = typeDefinition(type);
        return definition !== type ? typeStrings(definition, seen) : undefined;
      }
      if (ts.isTypeOperatorNode(type) && type.operator === ts.SyntaxKind.KeyOfKeyword) {
        if (ts.isTypeQueryNode(type.type)) {
          const value = queryValue(type.type);
          return value && ts.isObjectLiteralExpression(value) ? complete(value.properties.map(field =>
            ts.isPropertyAssignment(field) || ts.isShorthandPropertyAssignment(field)
              ? [field.name.getText().replaceAll(/['"]/g, '')] : undefined)) : undefined;
        }
        const object = typeDefinition(type.type);
        // Schema-derived keyof types retain the authored strict-object keys.
        if (ts.isTypeReferenceNode(object) && ts.isQualifiedName(object.typeName)
          && object.typeName.left.getText() === 'z' && object.typeName.right.text === 'infer'
          && object.typeArguments?.[0] && ts.isTypeQueryNode(object.typeArguments[0])) {
          let schema = queryValue(object.typeArguments[0]);
          if (schema && ts.isCallExpression(schema) && schema.expression.getText() === 'lazyZodSchema'
            && schema.arguments[0] && ts.isArrowFunction(schema.arguments[0]) && ts.isExpression(schema.arguments[0].body)) schema = schema.arguments[0].body;
          if (schema && ts.isCallExpression(schema) && schema.expression.getText() === 'z.strictObject'
            && schema.arguments[0]) {
            const shape = resolve(schema.arguments[0]);
            if (ts.isObjectLiteralExpression(shape)) return complete(shape.properties.map(field =>
              ts.isPropertyAssignment(field) && !ts.isComputedPropertyName(field.name)
                ? [field.name.getText().replaceAll(/['"]/g, '')] : undefined));
          }
        }
        return ts.isTypeLiteralNode(object) ? complete(object.members.map(member =>
          ts.isPropertySignature(member) && !ts.isComputedPropertyName(member.name)
            ? [member.name.getText().replaceAll(/['"]/g, '')] : undefined)) : undefined;
      }
      if (ts.isIndexedAccessTypeNode(type)) {
        let objectType = type.objectType;
        while (ts.isParenthesizedTypeNode(objectType)) objectType = objectType.type;
        if (ts.isIndexedAccessTypeNode(objectType) && type.indexType.kind === ts.SyntaxKind.NumberKeyword) return typeStrings(objectType, seen);
        if (!ts.isTypeQueryNode(objectType)) return undefined;
        const value = queryValue(objectType);
        if (!value) return undefined;
        if (type.indexType.kind === ts.SyntaxKind.NumberKeyword && ts.isArrayLiteralExpression(value)) return elements(value, seen);
        if (type.indexType.kind === ts.SyntaxKind.NumberKeyword && ts.isIdentifier(objectType.exprName)) {
          const declared = symbol(objectType.getSourceFile().fileName, objectType.exprName.text, 'types');
          const array = declared && ts.isTypeOperatorNode(declared) && declared.operator === ts.SyntaxKind.ReadonlyKeyword
            ? declared.type : declared;
          if (array && ts.isArrayTypeNode(array)) return typeStrings(array.elementType, seen);
        }
        const keys = typeStrings(type.indexType, new Set(seen));
        return keys ? complete(keys.map(key => {
          const field = property(value, key);
          return field && elements(field, new Set(seen));
        })) : undefined;
      }
      return undefined;
    }
    function finiteStrings(node: ts.Expression, seen = new Set<ts.Node>(), typed = true): string[] | undefined {
      node = unwrap(node);
      if (seen.has(node)) return undefined;
      seen.add(node);
      if (ts.isStringLiteralLike(node)) return [node.text];
      if (ts.isConditionalExpression(node)) return complete([
        finiteStrings(node.whenTrue, new Set(seen), typed), finiteStrings(node.whenFalse, new Set(seen), typed),
      ]);
      if (ts.isIdentifier(node)) {
        const local = lookup(node, node.text);
        if (local?.iterations) return complete(local.iterations.map(value => finiteStrings(value, new Set(seen), typed)));
        if (local?.initializer) return finiteStrings(local.initializer, seen, typed);
        if (local) return typed && local.annotation ? typeStrings(local.annotation) : undefined;
      }
      const fields = iterationFields(node);
      if (fields) return complete(fields.map(value => value && finiteStrings(value, new Set(seen), typed)));
      const resolved = resolve(node);
      if (resolved !== node) return finiteStrings(resolved, seen, typed);
      if (ts.isElementAccessExpression(node) && node.argumentExpression) {
        const keys = finiteStrings(node.argumentExpression, new Set(seen), typed);
        if (keys) return complete(keys.map(key => {
          const field = property(node.expression, key);
          return field && finiteStrings(field, new Set(seen), typed);
        }));
        // Indexing an authored immutable map cannot introduce a value outside
        // its closed literal values. Spreads/open fields still fail resolution.
        const object = resolve(node.expression);
        return ts.isObjectLiteralExpression(object) && ts.isAsExpression(object.parent)
          && object.parent.type.getText() === 'const' ? elements(object, seen) : undefined;
      }
      const type = typed && expressionType(node);
      return type ? typeStrings(type) : undefined;
    }
    function strings(node: ts.Expression, seen = new Set<ts.Node>(), typed = true): string[] {
      return finiteStrings(node, seen, typed) ?? [];
    }
    function localValue(node: ts.Expression, seen = new Set<ts.Node>()): ts.Expression {
      node = unwrap(node);
      if (seen.has(node)) return node;
      seen.add(node);
      if (ts.isIdentifier(node)) {
        const local = lookup(node, node.text);
        if (local) return local.initializer ? localValue(local.initializer, seen) : node;
      }
      return resolve(node);
    }
    function isCurrentUiContextCommandInvoke(expression: ts.Expression): boolean {
      const callee = localValue(expression);
      if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== 'invoke') return false;
      const owner = localValue(callee.expression);
      if (!ts.isCallExpression(owner)) return false;
      const hook = localValue(owner.expression);
      return ts.isIdentifier(hook) && currentUiContextLocalCommandHooks.has(hook.text) && !lookup(hook, hook.text);
    }
    function iterationFields(node: ts.Expression): (ts.Expression | undefined)[] | undefined {
      if (!ts.isPropertyAccessExpression(node) || !ts.isIdentifier(node.expression)) return undefined;
      return lookup(node.expression, node.expression.text)?.iterations?.map(value => property(value, node.name.text));
    }
    function settingField(expression: ts.Expression, key: string, seen: Set<ts.Node>): string[] | undefined {
      const value = localValue(expression);
      if (seen.has(value)) return undefined;
      seen = new Set([...seen, value]);
      if (ts.isObjectLiteralExpression(value)) {
        // Later fields/spreads own the value, matching object spread semantics.
        for (const field of [...value.properties].reverse()) {
          if (ts.isSpreadAssignment(field)) {
            const anchors = settingField(field.expression, key, seen);
            if (anchors === undefined || anchors.length) return anchors;
          } else if ((ts.isPropertyAssignment(field) || ts.isShorthandPropertyAssignment(field))
            && field.name.getText().replaceAll(/['"]/g, '') === key) {
            return settingAnchors(ts.isPropertyAssignment(field) ? field.initializer : field.name, seen);
          }
        }
        return [];
      }
      if (ts.isPropertyAccessExpression(value) && value.name.text === 'settings') {
        const page = localValue(value.expression);
        if (ts.isCallExpression(page) && name(page.expression) === 'defineSettingsPage' && page.arguments[0]) {
          const anchor = pageAnchor(page.arguments[0], key);
          return anchor ? [anchor] : undefined;
        }
      }
      return undefined;
    }
    function settingAnchors(node: ts.Expression, seen = new Set<ts.Node>()): string[] | undefined {
      const fields = iterationFields(node);
      if (fields) return complete(fields.map(value => value && settingAnchors(value, new Set(seen))));
      const value = localValue(node);
      if (seen.has(value)) return undefined;
      seen = new Set([...seen, value]);
      if (ts.isIdentifier(value) && lookup(value, value.text)?.parameter) return undefined;
      const direct = scalar(property(value, 'anchor'));
      if (direct) return [direct];
      if (ts.isPropertyAccessExpression(value) || ts.isElementAccessExpression(value)) {
        let keys = ts.isPropertyAccessExpression(value) ? [value.name.text]
          : value.argumentExpression ? finiteStrings(value.argumentExpression) : undefined;
        if (!keys) {
          const object = localValue(value.expression);
          if (ts.isObjectLiteralExpression(object) && ts.isAsExpression(object.parent)
            && object.parent.type.getText() === 'const') keys = complete(object.properties.map(field =>
              ts.isPropertyAssignment(field) || ts.isShorthandPropertyAssignment(field)
                ? [field.name.getText().replaceAll(/['"]/g, '')] : undefined));
        }
        return keys ? complete(keys.map(key => settingField(value.expression, key, seen))) : undefined;
      }
      return undefined;
    }
    function rpcReference(node: ts.Expression, seen = new Set<ts.Node>()): boolean {
      node = unwrap(node);
      if (seen.has(node)) return false;
      seen.add(node);
      if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) return rpcReference(node.expression, seen);
      if (!ts.isIdentifier(node)) return false;
      const local = lookup(node, node.text);
      if (local?.initializer) return rpcReference(local.initializer, seen);
      if (local?.parameter) return false;
      const value = symbol(node.getSourceFile().fileName, node.text, 'values');
      const declaration = value?.parent;
      return !!value && value.getSourceFile().fileName.startsWith('packages/protocol/src/rpc/')
        && !!declaration && ts.isVariableDeclaration(declaration) && ts.isIdentifier(declaration.name)
        && /^(RPC_METHODS|SESSION_RPC_METHODS)$/.test(declaration.name.text);
    }
    function readonlyType(type: ts.TypeNode | undefined): boolean {
      return !!type && (ts.isTypeOperatorNode(type) && type.operator === ts.SyntaxKind.ReadonlyKeyword
        || ts.isTypeReferenceNode(type) && /^(Readonly|ReadonlyArray)$/.test(type.typeName.getText()));
    }
    function iterationValues(expression: ts.Expression): readonly ts.Expression[] | undefined {
      const receiver = localValue(expression);
      const immutable = ts.isAsExpression(receiver.parent)
        && (receiver.parent.type.getText() === 'const' || readonlyType(receiver.parent.type))
        || readonlyType(expressionType(expression));
      return immutable && ts.isArrayLiteralExpression(receiver)
        && receiver.elements.every(element => !ts.isSpreadElement(element)) ? [...receiver.elements] : undefined;
    }
    function collect(node: ts.Node): void {
      if (ts.isImportSpecifier(node)) {
        const imported = node.propertyName?.text ?? node.name.text;
        aliases.set(node.name.text, imported);
        const statement = node.parent.parent.parent;
        if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)
          && statement.moduleSpecifier.text === '@/components/appShell/currentUiContext/CurrentUiContextCommands'
          && imported === 'useCurrentUiContextLocalCommands') currentUiContextLocalCommandHooks.add(node.name.text);
      }
      if (ts.isFunctionDeclaration(node) && node.name) declare(node, node.name.text, {
        actionArgument: ts.isSourceFile(node.parent) ? actionArgument(file.filePath, node.name.text) : undefined,
      });
      if (ts.isParameter(node) && ts.isIdentifier(node.name)) {
        const callback = node.parent;
        const call = callback.parent;
        const receiver = ts.isCallExpression(call) && call.arguments[0] === callback
          && ts.isPropertyAccessExpression(call.expression) && /^(map|flatMap|forEach)$/.test(call.expression.name.text)
          && callback.parameters[0] === node ? localValue(call.expression.expression) : undefined;
        const receiverType = ts.isCallExpression(call) && ts.isPropertyAccessExpression(call.expression)
          ? expressionType(call.expression.expression) : undefined;
        const readonlyType = (type: ts.TypeNode | undefined) => !!type && (
          ts.isTypeOperatorNode(type) && type.operator === ts.SyntaxKind.ReadonlyKeyword
          || ts.isTypeReferenceNode(type) && /^(Readonly|ReadonlyArray)$/.test(type.typeName.getText()));
        const immutable = receiver && (
          ts.isAsExpression(receiver.parent) && (receiver.parent.type.getText() === 'const' || readonlyType(receiver.parent.type))
          || readonlyType(receiverType)
          || ts.isCallExpression(call) && ts.isPropertyAccessExpression(call.expression) && unwrap(call.expression.expression) === receiver);
        const iterations = receiver && ts.isArrayLiteralExpression(receiver)
          && immutable && receiver.elements.every(element => !ts.isSpreadElement(element)) ? [...receiver.elements] : undefined;
        let annotation = node.type;
        if (!annotation && ts.isVariableDeclaration(callback.parent) && callback.parent.type) {
          const expected = typeDefinition(callback.parent.type);
          if (ts.isFunctionTypeNode(expected)) annotation = expected.parameters[callback.parameters.indexOf(node)]?.type;
        }
        // useMemo<Callback | undefined>(() => available ? callback : undefined)
        // contextually types the returned callback's parameters.
        let returned: ts.Node = callback;
        while (returned.parent && ts.isConditionalExpression(returned.parent)) returned = returned.parent;
        const factory = returned.parent;
        const memo = factory?.parent;
        if (!annotation && factory && ts.isArrowFunction(factory) && factory.body === returned
          && memo && ts.isCallExpression(memo) && name(memo.expression) === 'useMemo' && memo.arguments[0] === factory) {
          const expected = memo.typeArguments?.[0];
          const types = expected && ts.isUnionTypeNode(expected) ? expected.types : expected ? [expected] : [];
          const functions = types.map(type => typeDefinition(type)).filter(ts.isFunctionTypeNode);
          if (functions.length === 1) annotation = functions[0].parameters[callback.parameters.indexOf(node)]?.type;
        }
        declare(node, node.name.text, { annotation, parameter: true, iterations });
      }
      if (ts.isVariableDeclaration(node) && ts.isVariableDeclarationList(node.parent)
        && ts.isForOfStatement(node.parent.parent) && node.parent.flags & ts.NodeFlags.Const) {
        const expression = node.parent.parent.expression;
        const entries = ts.isCallExpression(expression) && ts.isPropertyAccessExpression(expression.expression)
          && expression.expression.name.text === 'entries' && !expression.arguments.length;
        const iterations = iterationValues(entries ? expression.expression.expression : expression);
        const binding = entries && ts.isArrayBindingPattern(node.name) ? node.name.elements[1] : undefined;
        if (ts.isIdentifier(node.name)) declare(node, node.name.text, { iterations });
        else if (binding && ts.isBindingElement(binding) && ts.isIdentifier(binding.name)) {
          declare(binding, binding.name.text, { iterations });
        }
      }
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
        const init = unwrap(node.initializer);
        const writer = ts.isCallExpression(init) && /^(useApplySettings|useApplyLocalSettings)$/.test(name(init.expression))
          ? name(init.expression) === 'useApplyLocalSettings' ? 'local' : 'account'
          : ts.isCallExpression(init) && /^(useSettingActionWriter|useSettingActionFeedback)$/.test(name(init.expression)) ? 'anchor' : undefined;
        const callback = ts.isArrowFunction(init) || ts.isFunctionExpression(init) ? init
          : ts.isCallExpression(init) && /^(useCallback|useMemo)$/.test(name(init.expression))
            && init.arguments[0] && (ts.isArrowFunction(init.arguments[0]) || ts.isFunctionExpression(init.arguments[0]))
            ? init.arguments[0] : undefined;
        const dispatch = !!callback && !!executorAnnotation(callback)
          || ts.isCallExpression(init) && /(?:ActionExecutor|ActionExecute)$/.test(name(init.expression));
        declare(node, node.name.text, { initializer: node.initializer, annotation: node.type, writer, dispatch });
      }
      if (ts.isCallExpression(node) && /^(createFrontDoorActionExecute|createFrontDoorUiActionExecutor)$/.test(name(node.expression))) {
        // A factory result may pass through a memo hook, but constructing one
        // inside a domain callback does not turn that callback into an executor.
        let child: ts.Node = node;
        let ancestor: ts.Node | undefined = node.parent;
        while (ancestor) {
          if (ts.isVariableDeclaration(ancestor) && ts.isIdentifier(ancestor.name) && ancestor.initializer === child) {
            declare(ancestor, ancestor.name.text, { ...lookup(ancestor.name, ancestor.name.text), dispatch: true });
            break;
          }
          const transparent = ts.isParenthesizedExpression(ancestor) || ts.isAsExpression(ancestor)
            || ts.isSatisfiesExpression(ancestor) || ts.isNonNullExpression(ancestor)
            || ts.isArrowFunction(ancestor) && ancestor.body === child
            || ts.isCallExpression(ancestor) && /^(useMemo|useCallback)$/.test(name(ancestor.expression))
              && ancestor.arguments.some(argument => argument === child);
          if (!transparent) break;
          child = ancestor;
          ancestor = ancestor.parent;
        }
      }
      if (ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name) && node.initializer
        && ts.isCallExpression(node.initializer) && name(node.initializer.expression) === 'useSettingActionFeedback') {
        for (const element of node.name.elements) {
          if (ts.isIdentifier(element.name) && (element.propertyName?.getText(source) ?? element.name.text) === 'setSetting') {
            declare(node, element.name.text, { writer: 'anchor' });
          }
        }
      }
      if (ts.isVariableDeclaration(node) && ts.isArrayBindingPattern(node.name) && node.initializer
        && ts.isCallExpression(node.initializer) && /^(useSettingMutable|useLocalSettingMutable)$/.test(name(node.initializer.expression))) {
        const setter = node.name.elements[1];
        const key = node.initializer.arguments[0];
        if (key && setter && ts.isBindingElement(setter) && ts.isIdentifier(setter.name)) {
          mutableNames.add(setter.name.text);
          declare(setter, setter.name.text, { mutable: { key,
            scope: name(node.initializer.expression) === 'useLocalSettingMutable' ? 'local' : 'account' } });
        }
      }
      ts.forEachChild(node, collect);
    }
    collect(source);
    // Explicit link handlers must enter the Action front door. Scope this to
    // synchronous user intents: authentication continuations that await their
    // owning Action keep that Action's admission rather than becoming a second
    // independent URL operation.
    const externalOpenNames = new Set<string>();
    const nativeLinkNames = new Set<string>();
    const occurrenceSyncNames = new Set<string>();
    const occurrenceWriters = new Set<string>();
    const occurrenceNamespaces = new Set<string>();
    const externalFollowWriterNames = new Set<string>();
    const nativeWindowWriterNames = new Set<string>();
    const nativeCaptureWriters = new Map<string, string>();
    const runnerRestartWriters = new Map<string, string>();
    const nativePathInvokers = new Set<string>();
    const localRuntimeExecutionHooks = new Set<string>();
    const projectTrustWriters = new Set<string>();
    const savedSecretRepairWriters = new Set<string>();
    const sessionDraftOpeners = new Set<string>();
    const clipboardWriters = new Map<string, string>();
    const clipboardNamespaces = new Set<string>();
    const reviewedPortFactories = new Set<string>();
    const messagePinWriters = new Set<string>();
    const messagePinNamespaces = new Set<string>();
    for (const statement of source.statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
      const bindings = statement.importClause?.namedBindings;
      const occurrenceApi = /(?:^|\/)apiAutomations(?:\.[cm]?[jt]s)?$/.test(statement.moduleSpecifier.text);
      if (occurrenceApi && bindings && ts.isNamespaceImport(bindings)) occurrenceNamespaces.add(bindings.name.text);
      if (statement.moduleSpecifier.text === '@/sync/domains/state/sessionMessagePinsPersistence'
        && bindings && ts.isNamespaceImport(bindings)) messagePinNamespaces.add(bindings.name.text);
      if (statement.moduleSpecifier.text === 'expo-clipboard' && bindings && ts.isNamespaceImport(bindings)) {
        clipboardNamespaces.add(bindings.name.text);
      }
      if (bindings && ts.isNamedImports(bindings)) for (const binding of bindings.elements) {
        const imported = binding.propertyName?.text ?? binding.name.text;
        if (/(?:^|\/)newSessionSeedComposer(?:\.[cm]?[jt]s)?$/.test(statement.moduleSpecifier.text)
          && imported === 'seedAndOpenNewSession') sessionDraftOpeners.add(binding.name.text);
        if (statement.moduleSpecifier.text === '@/utils/platform/desktopHost' && imported === 'invokeDesktopHost') {
          nativePathInvokers.add(binding.name.text);
        }
        if (statement.moduleSpecifier.text === '@/components/approvals/useLocalRuntimeActionExecution'
          && imported === 'useLocalRuntimeActionExecution') localRuntimeExecutionHooks.add(binding.name.text);
        if (statement.moduleSpecifier.text === '@/sync/api/account/apiProjectTrust' && imported === 'rememberReviewedProjectEffect') {
          projectTrustWriters.add(binding.name.text);
        }
        if (statement.moduleSpecifier.text === '@/sync/ops/settings/savedSecretResourceOperations'
          && imported === 'repairApprovedSavedSecretResourceEnvelopesBestEffort') savedSecretRepairWriters.add(binding.name.text);
        if (statement.moduleSpecifier.text === '@/sync/ops/sessionRunnerRestart'
          && /^(restartSessionRunnerForProviderBindingChange|restartSessionRunnerOnCurrentRuntime)$/.test(imported)) {
          runnerRestartWriters.set(binding.name.text, imported);
        }
        if (occurrenceApi && imported === 'mutateAutomationOccurrence') occurrenceWriters.add(binding.name.text);
        if (statement.moduleSpecifier.text === '@/sync/domains/state/sessionMessagePinsPersistence'
          && imported === 'savePersistedSessionMessagePins') messagePinWriters.add(binding.name.text);
        if (statement.moduleSpecifier.text === '@/utils/platform/desktopWindowBridge' && imported === 'setDesktopNativeTitleBar') {
          nativeWindowWriterNames.add(binding.name.text);
        }
        if (statement.moduleSpecifier.text === '@/desktop/capture/nativeCapture'
          && /^(pauseNativeRecording|resumeNativeRecording|stopNativeRecording|writeNativeRecordingDocument)$/.test(imported)) {
          nativeCaptureWriters.set(binding.name.text, imported);
        }
        if (statement.moduleSpecifier.text === '@/utils/ui/clipboard' && imported === 'setClipboardStringSafe'
          || statement.moduleSpecifier.text === 'expo-clipboard' && /^(setString|setStringAsync)$/.test(imported)) {
          clipboardWriters.set(binding.name.text, imported);
        }
        if (/^@happier-dev\/protocol(?:\/scm(?:\/reviewedMarks)?)?$/.test(statement.moduleSpecifier.text)
          && imported === 'createScmReviewedMarksRecordPort') reviewedPortFactories.add(binding.name.text);
        if (/(?:^|\/)openExternalUrl(?:\.[cm]?[jt]s)?$/.test(statement.moduleSpecifier.text)
          && imported === 'openExternalUrl') externalOpenNames.add(binding.name.text);
        if (statement.moduleSpecifier.text === 'react-native' && imported === 'Linking') nativeLinkNames.add(binding.name.text);
        if (statement.moduleSpecifier.text === '@/sync/sync' && imported === 'sync') occurrenceSyncNames.add(binding.name.text);
        if (statement.moduleSpecifier.text === '@/sync/ops/machineExternalSessions'
          && imported === 'machineExternalSessionFollowPolicySet') externalFollowWriterNames.add(binding.name.text);
      }
    }
    const nativeLinkMethod = (node: ts.Expression, method: string) => ts.isPropertyAccessExpression(node)
      && ts.isIdentifier(node.expression) && nativeLinkNames.has(node.expression.text) && node.name.text === method;
    const isExternalOpen = (node: ts.Expression) => ts.isIdentifier(node) && externalOpenNames.has(node.text)
      || nativeLinkMethod(node, 'openURL');
    const checkedExternalOpens = new Set<number>();
    const externalHandlerName = /^(onPress|onOpenUrl|onOpenLink|onDecorationPress)$/;
    function inspectExternalHandler(expression: ts.Expression, seen = new Set<ts.Node>()): void {
      expression = unwrap(expression);
      if (seen.has(expression)) return;
      seen.add(expression);
      if (ts.isIdentifier(expression)) {
        const initializer = lookup(expression, expression.text)?.initializer;
        if (initializer) inspectExternalHandler(initializer, seen);
        return;
      }
      if (ts.isConditionalExpression(expression)) {
        inspectExternalHandler(expression.whenTrue, seen);
        inspectExternalHandler(expression.whenFalse, seen);
        return;
      }
      // Row factories return a callback; follow their local body as well as direct handlers.
      if (ts.isCallExpression(expression) && ts.isIdentifier(expression.expression)) {
        const initializer = lookup(expression.expression, expression.expression.text)?.initializer;
        if (initializer) inspectExternalHandler(initializer, seen);
      }
      if (ts.isCallExpression(expression) && name(expression.expression) === 'useCallback' && expression.arguments[0]) {
        inspectExternalHandler(expression.arguments[0], seen);
        return;
      }
      if (!ts.isArrowFunction(expression) && !ts.isFunctionExpression(expression)) return;
      let awaitedOwner = false;
      const walk = (node: ts.Node): void => {
        if (ts.isAwaitExpression(node) && ts.isCallExpression(node.expression)
          && !isExternalOpen(node.expression.expression) && !nativeLinkMethod(node.expression.expression, 'canOpenURL')) awaitedOwner = true;
        if (ts.isCallExpression(node) && isExternalOpen(node.expression)
          && !awaitedOwner && !checkedExternalOpens.has(node.pos)) {
          checkedExternalOpens.add(node.pos);
          findings.push({ ...location(node), code: 'direct_external_link', operation: 'openExternalUrl' });
        }
        ts.forEachChild(node, walk);
      };
      walk(expression.body);
    }
    function collectExternalHandlers(node: ts.Node): void {
      if (ts.isJsxAttribute(node) && externalHandlerName.test(node.name.getText(source))
        && node.initializer && ts.isJsxExpression(node.initializer) && node.initializer.expression) {
        inspectExternalHandler(node.initializer.expression);
      }
      if (ts.isPropertyAssignment(node) && (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name))
        && externalHandlerName.test(node.name.text)) inspectExternalHandler(node.initializer);
      if (ts.isShorthandPropertyAssignment(node) && externalHandlerName.test(node.name.text)) {
        inspectExternalHandler(node.name);
      }
      ts.forEachChild(node, collectExternalHandlers);
    }
    if (externalOpenNames.size || nativeLinkNames.size) collectExternalHandlers(source);
    function isSignedOutRuntimeDraft(node: ts.Node): boolean {
      for (let ancestor = node.parent; ancestor; ancestor = ancestor.parent) {
        if (!ts.isArrowFunction(ancestor) && !ts.isFunctionExpression(ancestor)) continue;
        const call = ancestor.parent;
        if (!ts.isCallExpression(call) || !call.arguments.includes(ancestor)
          || !ts.isPropertyAccessExpression(call.expression) || call.expression.name.text !== 'runSignedOutDraft') continue;
        const owner = localValue(call.expression.expression);
        if (ts.isCallExpression(owner) && ts.isIdentifier(owner.expression)
          && localRuntimeExecutionHooks.has(owner.expression.text) && !lookup(owner.expression, owner.expression.text)) return true;
      }
      return false;
    }
    const checked = new Set<number>();
    const checkedSettings = new Set<ts.Expression>();
    function dynamicSetting(node: ts.Node, operation = ts.SyntaxKind[node.kind]): void {
      if (!exclude(`${ts.SyntaxKind[node.kind]}: ${node.getText()}`, location(node))) {
        findings.push({ ...location(node), code: 'dynamic_setting', operation });
      }
    }
    function delta(expression: ts.Expression, scope: string, directWriter?: string, seen = new Set<ts.Node>(), previous = new Set<Binding>()): void {
      expression = unwrap(expression);
      if (seen.has(expression)) {
        dynamicSetting(expression, 'cyclic setting delta');
        return;
      }
      seen.add(expression);
      const local = ts.isIdentifier(expression) ? lookup(expression, expression.text)?.initializer : undefined;
      const value = local ? unwrap(local) : resolve(expression);
      if (value !== expression) { delta(value, scope, directWriter, seen, previous); return; }
      if (ts.isConditionalExpression(value)) {
        delta(value.whenTrue, scope, directWriter, new Set(seen), previous); delta(value.whenFalse, scope, directWriter, new Set(seen), previous);
      } else if (ts.isArrowFunction(value) && !ts.isBlock(value.body)) {
        const parameter = value.parameters[0];
        const binding = parameter && ts.isIdentifier(parameter.name) ? lookup(parameter.name, parameter.name.text) : undefined;
        delta(value.body, scope, directWriter, seen, binding ? new Set([...previous, binding]) : previous);
      }
      else if (ts.isObjectLiteralExpression(value)) {
        for (const field of value.properties) {
          if (ts.isPropertyAssignment(field) || ts.isShorthandPropertyAssignment(field)) {
            const keys = ts.isComputedPropertyName(field.name) ? strings(field.name.expression)
              : [field.name.getText(source).replaceAll(/['"]/g, '')];
            for (const key of keys) checkSetting(key, scope, location(field), directWriter);
            if (!keys.length) dynamicSetting(field);
          } else if (ts.isSpreadAssignment(field)) {
            const prior = ts.isIdentifier(field.expression) ? lookup(field.expression, field.expression.text) : undefined;
            if (!prior || !previous.has(prior)) delta(field.expression, scope, directWriter, new Set(seen), previous);
          }
          else dynamicSetting(field);
        }
      } else dynamicSetting(expression);
    }
    function dispatch(node: ts.Expression): void {
      if (checked.has(node.pos)) return;
      checked.add(node.pos);
      const request = localValue(node);
      const requestAction = property(request, 'actionId');
      if (requestAction && property(request, 'input')) { dispatch(requestAction); return; }
      const operand = unwrap(node);
      let rootOperand = operand;
      while (ts.isPropertyAccessExpression(rootOperand)) rootOperand = rootOperand.expression;
      const binding = ts.isIdentifier(rootOperand) ? lookup(rootOperand, rootOperand.text) : undefined;
      const annotation = expressionType(operand);
      const definition = annotation && typeDefinition(annotation);
      // A whole-catalog transport parameter does not assert a concrete UI
      // capability. Its literal/family callers are still walked independently.
      if (binding?.parameter && definition?.getSourceFile().fileName === 'packages/protocol/src/actions/actionIds.ts'
        && ts.isIndexedAccessTypeNode(definition) && ts.isTypeQueryNode(definition.objectType)
        && definition.objectType.exprName.getText() === 'ACTION_IDS' && definition.indexType.kind === ts.SyntaxKind.NumberKeyword) {
        exclusions.push({ ...location(node), reason: 'canonical ActionId forwarding parameter; concrete callers remain walked' });
      } else {
        const ids = strings(node);
        if (ids.length) for (const id of ids) checkAction(id, location(node));
        else if (!exclude(`${ts.SyntaxKind[node.kind]}: ${node.getText()}`, location(node))) findings.push({ ...location(node), code: 'dynamic_action', operation: `${ts.SyntaxKind[node.kind]}: ${node.getText()}` });
      }
    }
    function visit(node: ts.Node): void {
      if (ts.isIdentifier(node) && mutableNames.has(node.text) && !(ts.isBindingElement(node.parent) && node.parent.name === node)
        && !(ts.isPropertyAccessExpression(node.parent) && node.parent.name === node)
        && !(ts.isPropertyAssignment(node.parent) && node.parent.name === node)) {
        const mutable = lookup(node, node.text)?.mutable;
        if (mutable && !checkedSettings.has(mutable.key)) {
          checkedSettings.add(mutable.key);
          const keys = strings(mutable.key);
          if (keys.length) for (const key of keys) checkSetting(key, mutable.scope, location(mutable.key));
          else dynamicSetting(mutable.key);
        }
      }
      if (ts.isPropertyAssignment(node)) {
        const property = node.name.getText(source).replaceAll(/['"]/g, '');
        const registration = ts.isObjectLiteralExpression(node.parent) && ts.isCallExpression(node.parent.parent)
          && /^(register.*Action|defineAction)/.test(name(node.parent.parent.expression));
        const request = ts.isObjectLiteralExpression(node.parent) && ts.isCallExpression(node.parent.parent)
          && node.parent.parent.arguments[0] === node.parent
          && /^(execute|executeAction|invoke|dispatch)$/.test(name(node.parent.parent.expression));
        const bridgeCall = ts.isObjectLiteralExpression(node.parent) && ts.isCallExpression(node.parent.parent)
          && node.parent.parent.arguments[0] === node.parent ? node.parent.parent : undefined;
        const bridge = bridgeCall && ts.isIdentifier(bridgeCall.expression) && !lookup(bridgeCall.expression, bridgeCall.expression.text)
          ? module(file.filePath)?.imports.get(bridgeCall.expression.text) : undefined;
        // Public Actions use the existing desktop transport alongside private navigation intents.
        // Follow the consumed canonical bridge binding; an arbitrary metadata field is not dispatch.
        const desktopAction = property === 'actionIdentifier'
          && bridge?.path === 'apps/ui/sources/utils/platform/desktopWindowActionBridge.ts'
          && bridge.name === 'executeDesktopWindowActionWithResult'
          && strings(node.initializer, new Set(), false).some(id => catalog.has(id));
        // Descriptors, approval presentation and Action-policy targets carry
        // actionId as data. Only consumed requests/registrations are ingress;
        // a later descriptor.actionId invocation is resolved at that call.
        if ((property === 'actionId' && (request || registration))
          || (property === 'id' && registration) || desktopAction) dispatch(node.initializer);
      }
      if (ts.isCallExpression(node)) {
        const called = name(node.expression);
        const effectOwner = file.filePath.startsWith('apps/ui/sources/sync/ops/actions/');
        const directRunnerRestart = !effectOwner && ts.isIdentifier(node.expression)
          && runnerRestartWriters.has(node.expression.text) && !lookup(node.expression, node.expression.text);
        // Explicit view commands need admission even though their terminal state is local.
        // Hydration, geometry and registered Action terminals remain direct writers.
        const fileViewConsumer = file.filePath.startsWith('apps/ui/sources/components/workspaces/files/');
        const viewIngress = ts.findAncestor(node, ancestor =>
          fileViewConsumer && ts.isVariableDeclaration(ancestor) && ts.isIdentifier(ancestor.name)
            && /^(onDisplayMode|onChangesScopeChange)$/.test(ancestor.name.text)
          || ts.isPropertyAssignment(ancestor)
            && (fileViewConsumer && ancestor.name.getText(source).replaceAll(/['"]/g, '') === 'toggleBlame'
              || /^(panes\.main\.toggle|panes\.side\.toggle)$/.test(ancestor.name.getText(source).replaceAll(/['"]/g, '')))
          || ts.isJsxAttribute(ancestor) && ancestor.name.getText(source) === 'onPress'
            && file.filePath.includes('/panes/') && called === 'setHidden');
        const directViewControlWrite = !effectOwner && viewIngress
          && /^(setHidden|toggle|setSideVisible|patchFileView|setDisplayMode)$/.test(called);
        const directClipboardWrite = !effectOwner && file.filePath !== 'apps/ui/sources/utils/ui/clipboard.ts'
          && (ts.isIdentifier(node.expression) && clipboardWriters.has(node.expression.text) && !lookup(node.expression, node.expression.text)
            || ts.isPropertyAccessExpression(node.expression) && ts.isIdentifier(node.expression.expression)
              && clipboardNamespaces.has(node.expression.expression.text) && !lookup(node.expression.expression, node.expression.expression.text)
              && /^(setString|setStringAsync)$/.test(called));
        const reviewedReceiver = ts.isPropertyAccessExpression(node.expression) ? localValue(node.expression.expression) : null;
        const directReviewedWrite = !effectOwner && reviewedReceiver && ts.isCallExpression(reviewedReceiver)
          && ts.isIdentifier(reviewedReceiver.expression) && reviewedPortFactories.has(reviewedReceiver.expression.text)
          && !lookup(reviewedReceiver.expression, reviewedReceiver.expression.text)
          && /^(setReviewed|setReviewedKeys|clear)$/.test(called);
        const directMessagePinWrite = !effectOwner && (ts.isIdentifier(node.expression)
          && messagePinWriters.has(node.expression.text) && !lookup(node.expression, node.expression.text)
          || ts.isPropertyAccessExpression(node.expression) && ts.isIdentifier(node.expression.expression)
            && messagePinNamespaces.has(node.expression.expression.text) && !lookup(node.expression.expression, node.expression.expression.text)
            && called === 'savePersistedSessionMessagePins');
        // A matching setting declaration proves discoverability, never executor ingress.
        // Raw writers belong below the Action boundary; rendered controls and hooks must
        // use the declared writer even when their delta names a known storage key.
        const consumer = /\/(?:components|hooks)\//.test(file.filePath) || /\/use[^/]*\.[cm]?[jt]sx?$/.test(file.filePath);
        const importedWriter = ts.isIdentifier(node.expression)
          ? module(file.filePath)?.imports.get(node.expression.text)?.name : undefined;
        const directProjectWrite = consumer && (called === 'mutateProjectAtmosphereSetting'
          || importedWriter === 'mutateProjectAtmosphereSetting');
        const directSettingsWrite = consumer && ts.isPropertyAccessExpression(node.expression)
          && /^(applySettings|applyLocalSettings|mutateAccountSettingsOnce)$/.test(called);
        const occurrenceCallee = consumer && !effectOwner && (occurrenceWriters.size || occurrenceNamespaces.size)
          ? localValue(node.expression) : node.expression;
        const occurrenceReceiver = ts.isPropertyAccessExpression(occurrenceCallee) ? localValue(occurrenceCallee.expression) : null;
        const rawOccurrenceWrite = ts.isIdentifier(occurrenceCallee)
          && occurrenceWriters.has(occurrenceCallee.text) && !lookup(occurrenceCallee, occurrenceCallee.text)
          || ts.isPropertyAccessExpression(occurrenceCallee) && occurrenceCallee.name.text === 'mutateAutomationOccurrence'
            && occurrenceReceiver && ts.isIdentifier(occurrenceReceiver) && occurrenceNamespaces.has(occurrenceReceiver.text)
            && !lookup(occurrenceReceiver, occurrenceReceiver.text);
        const directOccurrenceWrite = !effectOwner && consumer && (rawOccurrenceWrite || ts.isPropertyAccessExpression(node.expression)
          && ts.isIdentifier(node.expression.expression) && occurrenceSyncNames.has(node.expression.expression.text)
          && /^(cancelAutomationRun|retryAutomationReplyHandoff|deliverAutomationResultAgain|pauseAutomation|resumeAutomation)$/.test(called));
        const directPendingWrite = consumer && ts.isPropertyAccessExpression(node.expression)
          && ts.isIdentifier(node.expression.expression) && occurrenceSyncNames.has(node.expression.expression.text)
          && /^(updatePendingMessage|sendPendingMessageNow|deletePendingMessage|deleteDiscardedPendingMessage|restoreDiscardedPendingMessage)$/.test(called);
        const directExternalFollowWrite = consumer && ts.isIdentifier(node.expression)
          && externalFollowWriterNames.has(node.expression.text);
        const directNativeWindowWrite = consumer
          && file.filePath !== 'apps/ui/sources/components/settings/desktop/desktopWindowChromeBinding.ts'
          && ts.isIdentifier(node.expression) && nativeWindowWriterNames.has(node.expression.text)
          && !lookup(node.expression, node.expression.text);
        const directCaptureWrite = consumer && ts.isIdentifier(node.expression)
          && nativeCaptureWriters.has(node.expression.text) && !lookup(node.expression, node.expression.text);
        const directNativePathWrite = consumer && ts.isIdentifier(node.expression)
          && nativePathInvokers.has(node.expression.text) && !lookup(node.expression, node.expression.text)
          && node.arguments[0] && ts.isStringLiteral(node.arguments[0])
          && /^(system_tasks_open_log_path|system_tasks_reveal_output_path)$/.test(node.arguments[0].text)
          && !isSignedOutRuntimeDraft(node);
        const directProjectTrustWrite = consumer && ts.isIdentifier(node.expression)
          && projectTrustWriters.has(node.expression.text) && !lookup(node.expression, node.expression.text);
        const directSavedSecretRepair = consumer && ts.isIdentifier(node.expression)
          && savedSecretRepairWriters.has(node.expression.text) && !lookup(node.expression, node.expression.text);
        const directSessionDraftOpen = consumer && !effectOwner && ts.isIdentifier(node.expression)
          && sessionDraftOpeners.has(node.expression.text) && !lookup(node.expression, node.expression.text);
        const callable = ts.isIdentifier(node.expression) ? lookup(node.expression, node.expression.text)
          : ts.isPropertyAccessExpression(node.expression) && ts.isIdentifier(node.expression.expression)
            ? lookup(node.expression, node.expression.expression.text) : undefined;
        const adapterArgument = ts.isIdentifier(node.expression)
          ? callable?.actionArgument ?? (!callable ? actionArgument(file.filePath, node.expression.text) : undefined) : undefined;
        const first = node.arguments[adapterArgument ?? (/^executeOn(Machine|Session|Source)$/.test(called) ? 1 : 0)];
        const writer = callable?.writer ?? (ts.isPropertyAccessExpression(node.expression)
          && /^(applySettings|applyLocalSettings)$/.test(called) ? called === 'applyLocalSettings' ? 'local' : 'account' : undefined);
        if (directNativePathWrite) {
          findings.push({ ...location(node), code: 'direct_desktop_window_write', operation: (node.arguments[0] as ts.StringLiteral).text });
        } else if (directSavedSecretRepair) {
          findings.push({ ...location(node), code: 'direct_saved_secret_repair', operation: 'repairApprovedSavedSecretResourceEnvelopesBestEffort' });
        } else if (directProjectTrustWrite) {
          findings.push({ ...location(node), code: 'direct_project_trust_write', operation: 'rememberReviewedProjectEffect' });
        } else if (directRunnerRestart) {
          findings.push({ ...location(node), code: 'direct_session_runner_restart',
            operation: runnerRestartWriters.get((node.expression as ts.Identifier).text)! });
        } else if (directViewControlWrite) {
          findings.push({ ...location(node), code: 'direct_view_control_write', operation:
            /^(patchFileView|setDisplayMode)$/.test(called) ? 'file.view.set' : 'shell.column.set' });
        } else if (directMessagePinWrite) {
          findings.push({ ...location(node), code: 'direct_message_pin_write', operation: 'savePersistedSessionMessagePins' });
        } else if (directClipboardWrite) {
          const operation = ts.isIdentifier(node.expression) ? clipboardWriters.get(node.expression.text)! : called;
          if (!exclude(operation, location(node))) findings.push({ ...location(node), code: 'direct_clipboard_write', operation });
        } else if (directCaptureWrite) {
          findings.push({ ...location(node), code: 'direct_desktop_window_write', operation:
            nativeCaptureWriters.get(ts.isIdentifier(node.expression) ? node.expression.text : called)! });
        } else if (directNativeWindowWrite) {
          findings.push({ ...location(node), code: 'direct_desktop_window_write', operation: 'setDesktopNativeTitleBar' });
        } else if (directReviewedWrite) {
          findings.push({ ...location(node), code: 'direct_reviewed_mark_write', operation: called });
        } else if (directPendingWrite) {
          findings.push({ ...location(node), code: 'direct_pending_content_write', operation: called });
        } else if (directExternalFollowWrite) {
          findings.push({ ...location(node), code: 'direct_external_follow_write', operation: 'machineExternalSessionFollowPolicySet' });
        } else if (directSessionDraftOpen) {
          findings.push({ ...location(node), code: 'direct_session_draft_open', operation: 'seedAndOpenNewSession' });
        } else if (directOccurrenceWrite) {
          findings.push({ ...location(node), code: 'direct_occurrence_write', operation: rawOccurrenceWrite ? 'mutateAutomationOccurrence' : called });
        } else if (directProjectWrite) {
          const pictureOperation = ts.findAncestor(node, ancestor => ts.isFunctionDeclaration(ancestor)
            && ancestor.name?.text === 'invokeAtmospherePictureOperation');
          if (!pictureOperation || !exclude('project:invokeAtmospherePictureOperation', location(node))) {
            findings.push({ ...location(node), code: 'direct_settings_write', operation: 'mutateProjectAtmosphereSetting' });
          }
        } else if (directSettingsWrite) {
          // Resolve each key through the same exemption owner before rejecting raw
          // ingress. An exempt local field cannot bless other fields in the delta.
          if (first) delta(first, writer ?? 'account', called);
          else findings.push({ ...location(node), code: 'direct_settings_write', operation: called });
        } else if (first && /^(useSettingMutable|useLocalSettingMutable)$/.test(called)) {
          // The tuple is also used as a reader. Its setter's live references above own mutation coverage.
        } else if (first && writer && (ts.isIdentifier(node.expression) || /^(setSetting|applySettings|applyLocalSettings)$/.test(called))) {
          const operand = unwrap(first);
          if (writer === 'anchor') {
            const values = settingAnchors(operand) ?? [];
            if (values.length) for (const value of values) checkAnchor(value, location(first));
            else dynamicSetting(first);
          } else delta(operand, writer);
        } else if (first && !isExecutorForward(node) && !isCurrentUiContextCommandInvoke(node.expression)
          && !/^(getActionSpec|isActionSpec|resolveAction|readAction)/.test(called)) {
          // The canonical mounted-command hook admits its own Action; its invoke operand is an opaque local key.
          // Literal ids also find thin family clients whose method is simply named `run`.
          const conventional = /^(execute|executeAction|invoke|dispatch|executeOnMachine|executeOnSession|executeOnSource|useAction)$/.test(called);
          const receiver = ts.isPropertyAccessExpression(node.expression) ? node.expression.expression.getText(source) : '';
          const isDispatch = adapterArgument !== undefined || callable?.dispatch || called === 'useAction' || /^executeOn(Machine|Session|Source)$/.test(called)
            || ts.isCallExpression(node.expression) && /^(createFrontDoorActionExecute|createFrontDoorUiActionExecutor)$/.test(name(node.expression.expression))
            || (conventional && /(?:[Aa]ction|executor|^actions$)/.test(receiver));
          const candidates = strings(first, new Set(), !!isDispatch || conventional);
          if (!isDispatch && rpcReference(first)) {
            ts.forEachChild(node, visit);
            return;
          }
          if (isDispatch && property(localValue(first), 'actionId') && property(localValue(first), 'input')) dispatch(first);
          else if ((isDispatch || conventional) && candidates.some(id => id.includes('.'))) dispatch(first);
          // Catalog ids passed to feature/binding readers or membership checks
          // are data. Thin `read`, `mutate` and `prepare` clients remain walked.
          else if (!/^(get|is|has|includes|useFeature)/.test(called) && candidates.some(id => catalog.has(id))) dispatch(first);
          else if (isDispatch && !candidates.length && !ts.isObjectLiteralExpression(unwrap(first))
            && !(expressionType(first) && ts.isTypeLiteralNode(typeDefinition(expressionType(first)!)))) dispatch(first);
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
    if (!dependency) modules.delete(file.filePath);
  }
  return { actions, settings, findings, exclusions };
}
