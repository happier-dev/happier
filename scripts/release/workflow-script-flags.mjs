import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import YAML from 'yaml';

// This is a static contract reader: workflow shell and publishing modules are never executed.
function words(source, start = 0) {
  const result = [];
  let word = '';
  let quote = '';
  const stack = [];
  for (let i = start; i < source.length; i++) {
    const c = source[i];
    if (c === '\\' && source[i + 1]) { word += source[++i]; continue; }
    if (!quote && !stack.length && /[\n;|&)<>]/.test(c)) {
      if (word) result.push(word);
      return { result, end: i };
    }
    if (c === '$' && ['{', '('].includes(source[i + 1])) {
      stack.push({ close: source[i + 1] === '{' ? '}' : ')', quote: '' });
      word += c + source[++i];
      continue;
    }
    if (stack.length) {
      word += c;
      const frame = stack.at(-1);
      if (c === '"' || c === "'") frame.quote = frame.quote === c ? '' : frame.quote || c;
      if (!frame.quote) {
        if (c === '(' && frame.close === ')') stack.push({ close: ')', quote: '' });
        else if (c === frame.close) stack.pop();
      }
      continue;
    }
    if (c === '"' || c === "'") {
      if (!quote) { quote = c; continue; }
      if (quote === c) { quote = ''; continue; }
    }
    if (!quote && /\s/.test(c)) {
      if (word) result.push(word);
      word = '';
    } else word += c;
  }
  if (word) result.push(word);
  return { result, end: source.length };
}

function withoutHeredocs(source) {
  const lines = source.split('\n');
  let delimiter;
  return lines.map((line) => {
    if (delimiter) {
      if (line.trim() === delimiter) delimiter = undefined;
      return '';
    }
    const match = line.match(/<<-?\s*['"]?(\w+)['"]?/);
    if (match) delimiter = match[1];
    return line;
  }).join('\n');
}

export function resolveWorkflowScriptPath(scriptPath, workingDirectory = '.', checkoutDirectories = []) {
  const normalize = (value) => value.replaceAll('\\', '/');
  const rawPath = normalize(scriptPath);
  const workspacePath = rawPath.match(/^\$(?:GITHUB_WORKSPACE|\{GITHUB_WORKSPACE\})\/(.*)$/)?.[1];
  const runtimePath = workspacePath ?? path.posix.normalize(path.posix.join(normalize(workingDirectory), rawPath));
  if (runtimePath === '..' || runtimePath.startsWith('../') || runtimePath.startsWith('/')) throw new Error(`Script escapes repository checkouts: ${scriptPath}`);
  const roots = checkoutDirectories.map((directory) => normalize(directory).replace(/^\.\//, '').replace(/\/$/, '')).sort((a, b) => b.length - a.length);
  for (const directory of roots) if (runtimePath.startsWith(`${directory}/`)) return runtimePath.slice(directory.length + 1);
  return runtimePath;
}

export function scriptCalls(run, workingDirectory = '.', checkoutDirectories = []) {
  const source = withoutHeredocs(run).replace(/(?:\\|`)\r?\n/g, ' ');
  const calls = [];
  const pattern = /\bnode\s+(["']?[^\s"';|()<>]*scripts\/[^\s"';|()<>]+\.mjs["']?)/g;
  for (const match of source.matchAll(pattern)) {
    const script = resolveWorkflowScriptPath(match[1].replace(/["']/g, ''), workingDirectory, checkoutDirectories);
    const { result: args } = words(source, match.index + match[0].length);
    const preceding = source.slice(0, match.index);
    const expanded = [];
    for (const arg of args) {
      const arrays = [...arg.matchAll(/\$\{([A-Za-z_]\w*)\[@\]/g)].map((item) => item[1]);
      if (arrays.length) {
        for (const name of new Set(arrays)) {
          const assignments = [...preceding.matchAll(new RegExp(`\\b${name}\\+?=\\(`, 'g'))];
          if (!assignments.length) throw new Error(`${script}: unresolved shell argument array ${name}`);
          // Conditional assignments represent alternative valid paths; validate their union.
          for (const assignment of assignments) expanded.push(...words(preceding, assignment.index + assignment[0].length).result);
        }
      } else if (arg === '$@') {
        for (const assignment of preceding.matchAll(/\bset\s+--\s*/g)) {
          expanded.push(...words(preceding, assignment.index + assignment[0].length).result.filter((item) => item !== '$@'));
        }
      } else {
        expanded.push(arg);
      }
    }
    calls.push({ script, args: expanded });
  }
  return calls;
}

export function releaseScriptCalls(root, entry = '.github/workflows/release.yml') {
  const visited = new Set();
  const calls = [];
  function visit(file) {
    if (visited.has(file)) return;
    visited.add(file);
    const workflow = YAML.parse(fs.readFileSync(path.join(root, file), 'utf8'));
    const checkoutDirectories = Object.values(workflow.jobs ?? {}).flatMap((job) => (job.steps ?? [])
      .filter((step) => step.uses?.startsWith('actions/checkout@') && typeof step.with?.path === 'string')
      .map((step) => step.with.path));
    const steps = [...(workflow.runs?.steps ?? [])];
    for (const [jobName, job] of Object.entries(workflow.jobs ?? {})) {
      if (job.uses?.startsWith('./.github/workflows/')) visit(job.uses.slice(2));
      for (const [index, step] of (job.steps ?? []).entries()) steps.push({ ...step, location: `${jobName}:${step.id ?? index}`, directory: step['working-directory'] ?? job.defaults?.run?.['working-directory'] ?? workflow.defaults?.run?.['working-directory'] ?? '.' });
    }
    for (const [index, step] of steps.entries()) {
      if (step.uses?.startsWith('./.github/actions/')) {
        const directory = step.uses.slice(2);
        const action = ['action.yml', 'action.yaml'].find((name) => fs.existsSync(path.join(root, directory, name)));
        if (!action) throw new Error(`Missing local action ${directory}`);
        visit(`${directory}/${action}`);
      }
      if (step.run) calls.push(...scriptCalls(step.run, step.directory, checkoutDirectories).map((call) => ({ ...call, location: `${file}:${step.location ?? index}` })));
    }
  }
  visit(entry);
  return { calls, files: [...visited] };
}

const literal = (node) => node && ts.isStringLiteralLike(node) ? node.text : undefined;
const propertyName = (node) => node && (ts.isIdentifier(node) || ts.isStringLiteralLike(node)) ? node.text : undefined;

function condition(node, command) {
  if (ts.isParenthesizedExpression(node)) return condition(node.expression, command);
  if (!ts.isBinaryExpression(node)) return undefined;
  const left = node.left;
  const right = node.right;
  if (ts.isIdentifier(left) && left.text === 'subcommand' && literal(right) !== undefined) {
    if (node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken) return command === literal(right);
    if (node.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken) return command !== literal(right);
  }
  const a = condition(left, command);
  const b = condition(right, command);
  if (node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) return a === false || b === false ? false : a === true && b === true ? true : undefined;
  if (node.operatorToken.kind === ts.SyntaxKind.BarBarToken) return a === true || b === true ? true : a === false && b === false ? false : undefined;
  return undefined;
}

function walk(node, callback, command, activeFunctions) {
  if (activeFunctions && ts.isFunctionDeclaration(node) && node.name && !activeFunctions.has(node.name.text)) return;
  if (activeFunctions && (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) && ts.isVariableDeclaration(node.parent) && ts.isIdentifier(node.parent.name) && !activeFunctions.has(node.parent.name.text)) return;
  callback(node);
  if (command && ts.isIfStatement(node)) {
    const selected = condition(node.expression, command);
    if (selected !== undefined) {
      if (selected) walk(node.thenStatement, callback, command, activeFunctions);
      else if (node.elseStatement) walk(node.elseStatement, callback, command, activeFunctions);
      return;
    }
  }
  ts.forEachChild(node, (child) => walk(child, callback, command, activeFunctions));
}

function names(binding) {
  if (ts.isIdentifier(binding)) return [binding.text];
  return binding.elements.flatMap((element) => ts.isBindingElement(element) ? names(element.name) : []);
}

function importedMapParser(root, script, name, seen = new Set()) {
  const key = `${script}:${name}`;
  if (seen.has(key)) return false;
  seen.add(key);
  const tree = ts.createSourceFile(script, fs.readFileSync(path.join(root, script), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  let found = false;
  walk(tree, (node) => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) {
      walk(node, (child) => { if (ts.isNewExpression(child) && child.expression.getText(tree) === 'Map') found = true; });
    }
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && literal(node.moduleSpecifier)?.startsWith('.')) {
      const elements = ts.isImportDeclaration(node) ? node.importClause?.namedBindings?.elements : node.exportClause?.elements;
      for (const element of elements ?? []) {
        if (element.name.text === name) found ||= importedMapParser(root, path.relative(root, path.resolve(root, path.dirname(script), literal(node.moduleSpecifier))), element.propertyName?.text ?? name, seen);
      }
    }
  });
  return found;
}

function selectedString(node, command) {
  if (literal(node) !== undefined) return literal(node);
  if (node && ts.isConditionalExpression(node)) {
    const selected = condition(node.condition, command);
    if (selected !== undefined) return selectedString(selected ? node.whenTrue : node.whenFalse, command);
  }
  return undefined;
}

function declarationValue(name, context) {
  for (let scope = context.parent; scope; scope = scope.parent) {
    for (const statement of scope.statements ?? []) {
      if (!ts.isVariableStatement(statement)) continue;
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.name.text === name) return declaration.initializer;
      }
    }
  }
  return undefined;
}

export function parserFlags(root, script, command, entryFunction) {
  const filename = path.join(root, script);
  const source = fs.readFileSync(filename, 'utf8');
  const tree = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  if (tree.parseDiagnostics.length) throw new Error(`${script}: cannot parse script`);
  const flags = new Set();
  const imports = new Map();
  const importedNames = new Map();
  const utilParsers = new Set();
  const customParsers = new Map();
  const parsedBindings = new Map();
  const functions = new Map();
  let recognized = false;
  let commandFound = !command;
  walk(tree, (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) functions.set(node.name.text, node.initializer);
    if (ts.isImportDeclaration(node) && literal(node.moduleSpecifier) === 'node:util') {
      for (const element of node.importClause?.namedBindings?.elements ?? []) if ((element.propertyName?.text ?? element.name.text) === 'parseArgs') utilParsers.add(element.name.text);
    }
    if (ts.isImportDeclaration(node) && literal(node.moduleSpecifier)?.startsWith('.')) {
      for (const element of node.importClause?.namedBindings?.elements ?? []) {
        imports.set(element.name.text, path.relative(root, path.resolve(path.dirname(filename), literal(node.moduleSpecifier))));
        importedNames.set(element.name.text, element.propertyName?.text ?? element.name.text);
      }
    }
    if (command && ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken && ts.isIdentifier(node.left) && node.left.text === 'subcommand' && literal(node.right) === command) commandFound = true;
    if (ts.isFunctionDeclaration(node) && node.name) {
      functions.set(node.name.text, node);
      let map = false;
      let stripPrefix = false;
      walk(node, (child) => {
        if (ts.isNewExpression(child) && ts.isIdentifier(child.expression) && child.expression.text === 'Map') map = true;
        if (ts.isCallExpression(child) && ts.isPropertyAccessExpression(child.expression) && child.expression.name.text === 'slice' && child.arguments[0]?.getText(tree) === '2') stripPrefix = true;
      });
      if (map && node.parameters.length) customParsers.set(node.name.text, stripPrefix);
    }
  });
  const importedCandidates = new Set();
  walk(tree, (node) => {
    if (ts.isVariableDeclaration(node) && node.initializer && ts.isCallExpression(node.initializer) && ts.isIdentifier(node.initializer.expression) && imports.has(node.initializer.expression.text)) importedCandidates.add(node.initializer.expression.text);
  });
  for (const name of importedCandidates) if (importedMapParser(root, imports.get(name), importedNames.get(name))) customParsers.set(name, false);
  const activeFunctions = new Set(entryFunction ? [entryFunction] : []);
  {
    let previousSize;
    do {
      previousSize = activeFunctions.size;
      walk(tree, (node) => {
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && functions.has(node.expression.text)) activeFunctions.add(node.expression.text);
      }, command, activeFunctions);
    } while (activeFunctions.size !== previousSize);
  }
  const selectedWalk = (callback) => walk(tree, callback, command, activeFunctions);
  selectedWalk((node) => {
    if (ts.isVariableDeclaration(node) && node.initializer && ts.isCallExpression(node.initializer) && ts.isIdentifier(node.initializer.expression) && customParsers.has(node.initializer.expression.text)) {
      for (const name of names(node.name)) parsedBindings.set(name, customParsers.get(node.initializer.expression.text));
      recognized = true;
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && ts.isNewExpression(node.initializer) && node.initializer.expression.getText(tree) === 'Map') {
      let owner = node.parent;
      while (owner && !ts.isFunctionDeclaration(owner)) owner = owner.parent;
      if (owner?.name && customParsers.has(owner.name.text)) parsedBindings.set(node.name.text, customParsers.get(owner.name.text));
    }
  });
  selectedWalk((node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && utilParsers.has(node.expression.text)) {
      const config = node.arguments[0];
      if (config && ts.isObjectLiteralExpression(config)) {
        const options = config.properties.find((item) => propertyName(item.name) === 'options');
        if (options) {
          const definition = ts.isShorthandPropertyAssignment(options) ? declarationValue(options.name.text, node) : ts.isIdentifier(options.initializer) ? declarationValue(options.initializer.text, node) : options.initializer;
          if (!definition || !ts.isObjectLiteralExpression(definition)) throw new Error(`${script}: unrecognized options schema`);
          recognized = true;
          for (const option of definition.properties) {
            if (!ts.isPropertyAssignment(option) || !propertyName(option.name)) throw new Error(`${script}: unrecognized option definition`);
            flags.add(`--${propertyName(option.name)}`);
          }
        }
      }
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const receiver = node.expression.expression;
      const method = node.expression.name.text;
      const value = literal(node.arguments[0]);
      if (value && ts.isIdentifier(receiver) && parsedBindings.has(receiver.text) && ['get', 'has'].includes(method) && (value.startsWith('--') || parsedBindings.get(receiver.text))) flags.add(value.startsWith('--') ? value : `--${value}`);
      if (!value && method === 'has' && ts.isIdentifier(receiver)) {
        const definition = declarationValue(receiver.text, node);
        if (definition && ts.isNewExpression(definition) && definition.expression.getText(tree) === 'Set' && definition.arguments?.[0] && ts.isArrayLiteralExpression(definition.arguments[0])) {
          let owner = node.parent;
          while (owner && !ts.isFunctionDeclaration(owner)) owner = owner.parent;
          if (owner?.name && customParsers.has(owner.name.text)) {
            for (const item of definition.arguments[0].elements) {
              if (!literal(item)) throw new Error(`${script}: unrecognized parser flag set`);
              flags.add(literal(item).startsWith('--') ? literal(item) : `--${literal(item)}`);
            }
            recognized = true;
          }
        }
      }
      if (value?.startsWith('--') && ['includes', 'indexOf'].includes(method) && /^(?:process\.argv|argv|rawArgv|rest)$/.test(receiver.getText(tree))) { flags.add(value); recognized = true; }
    }
    if (ts.isBinaryExpression(node) && [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken].includes(node.operatorToken.kind) && literal(node.right)?.startsWith('--') && ts.isIdentifier(node.left) && /^(?:arg|a|token)$/.test(node.left.text)) {
      flags.add(literal(node.right)); recognized = true;
    }
  });
  if (command) {
    selectedWalk((node) => {
      if (!ts.isCallExpression(node) || !ts.isIdentifier(node.expression)) return;
      const args = node.arguments[0];
      if (!args || !ts.isObjectLiteralExpression(args) || !args.properties.some((item) => propertyName(item.name) === 'args' && /\b(?:passthrough|scriptArgs)\b/.test(item.getText(tree)))) return;
      const fn = functions.get(node.expression.text);
      if (!fn) throw new Error(`${script}: unresolved passthrough owner ${node.expression.text}`);
      walk(fn, (child) => {
        if (!ts.isVariableDeclaration(child) || child.name.getText(tree) !== 'scriptPath' || !child.initializer || !ts.isCallExpression(child.initializer)) return;
        const segments = child.initializer.arguments.slice(1).map((segment) => {
          const selected = selectedString(segment, command);
          return selected ?? (ts.isIdentifier(segment) ? selectedString(declarationValue(segment.text, node), command) : undefined);
        });
        if (!segments.length || segments.some((segment) => segment === undefined)) throw new Error(`${script}: unresolved passthrough script for ${command}`);
        for (const flag of parserFlags(root, segments.join('/'))) flags.add(flag);
        recognized = true;
      });
    });
  }
  if (!commandFound) throw new Error(`${script}: unknown subcommand ${command}`);
  if (!recognized) {
    const delegates = new Set();
    selectedWalk((node) => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && imports.has(node.expression.text)) delegates.add(node.expression.text);
    });
    // Entrypoint wrappers delegate to one imported CLI owner (binary publishers use this).
    if (delegates.size === 1) {
      const name = [...delegates][0];
      return parserFlags(root, imports.get(name), undefined, importedNames.get(name));
    }
    throw new Error(`${script}: unrecognized CLI parser`);
  }
  return flags;
}

export function validateReleaseScriptFlags(root, entry) {
  const inventory = releaseScriptCalls(root, entry);
  const failures = [];
  for (const call of inventory.calls) {
    try {
      if (!fs.existsSync(path.join(root, call.script))) throw new Error(`missing script ${call.script}`);
      const actual = call.args.filter((arg) => arg.startsWith('--')).map((arg) => arg.split('=')[0]);
      const command = call.script === 'scripts/pipeline/run.mjs' ? call.args[0] : undefined;
      if (!actual.length && !command) continue;
      const supported = parserFlags(root, call.script, command);
      for (const flag of actual) if (!supported.has(flag)) failures.push(`${call.location}: ${call.script}${command ? ` ${command}` : ''} does not consume ${flag}`);
    } catch (error) { failures.push(`${call.location}: ${error.message}`); }
  }
  return { ...inventory, failures };
}
