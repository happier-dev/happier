// This source audit follows the catalog, the default dependency object, and its consumers.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { listActionSpecsForSurface } from '../../../../../../packages/protocol/src/actions/actionSpecs.ts';
import * as actionIds from '../../../../../../packages/protocol/src/actions/actionIds.ts';
import { isUiMachineOwnedAdmissionAction } from './executeMachineActionAtDaemon.ts';
import { isHostExternalSessionActionId } from '../../../../../../packages/protocol/src/actions/executor/actionFamilies.ts';
import { MachinePoolActionIdV1Schema } from '../../../../../../packages/protocol/src/machines/pools/actionsV1.ts';

process.chdir(fileURLToPath(new URL('../../../../../../', import.meta.url)));
const require = createRequire(import.meta.url);
const ts = require('typescript');
const catalog = listActionSpecsForSurface('ui');
const ids = catalog.map(({ id }) => id);
const rows = new Map(ids.map(id => [id, { sites: new Set(), missing: new Set(), bound: new Set(), inline: new Set() }]));
const protocol = 'packages/protocol/src/actions';
const app = 'apps/ui/sources/sync/ops/actions/defaultActionExecutor.ts';
const specialized = new Map();
const specializedPorts = new Set();
function walk(n, visit) {
    visit(n);
    ts.forEachChild(n, child => walk(child, visit));
}
function source(file) {
    return ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
}
function readDispatchers(dir) {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
        const full = path.join(dir, entry.name);
        return entry.isDirectory() ? readDispatchers(full)
            : /\.ts$/.test(full) && !/\.(test|spec|d)\.ts$/.test(full) ? [full] : [];
    });
}
const sourceCache = new Map();
function parsedFile(file) {
    if (!sourceCache.has(file)) sourceCache.set(file, source(file));
    return sourceCache.get(file);
}
// The exemptions come from the Action call next to the owner's actual scoped
// executor binding. Neither this audit nor a port table supplies the Action ID.
function recordSpecialized(call, operand, port) {
    const id = ts.isStringLiteralLike(operand) ? operand.text : actionIds[operand.getText()];
    if (!rows.has(id)) return false;
    const owners = specialized.get(id) ?? [];
    owners.push({ port, site: origin(call) });
    specialized.set(id, owners);
    specializedPorts.add(port);
    return true;
}
for (const [file, port] of [
    ['hooks/session/useConnectTerminal.ts', 'accountTerminalsApproveAction'],
    ['components/account/restore/RestoreScanComputerQrView.tsx', 'accountDevicesApproveAction'],
    ['sync/ops/workspaceSync.ts', 'workspaceSyncConflictResolve'],
]) {
    const tree = parsedFile('apps/ui/sources/' + file);
    let found = false;
    walk(tree, n => {
        if (!ts.isVariableDeclaration(n) || n.name.getText() !== 'executor' || !n.initializer
            || !ts.isCallExpression(n.initializer)
            || !/^create(?:Default)?ActionExecutor$/.test(n.initializer.expression.getText())) return;
        const [deps] = n.initializer.arguments;
        if (!deps || !ts.isObjectLiteralExpression(deps) || !deps.properties.some(p => p.name?.getText() === port)) return;
        let scope = n.parent;
        while (scope && !ts.isBlock(scope)) scope = scope.parent;
        if (!scope) return;
        walk(scope, call => {
            if (!ts.isCallExpression(call) || call.expression.getText() !== 'executor.execute' || call.pos < n.end) return;
            found = recordSpecialized(call, call.arguments[0], port) || found;
        });
    });
    if (!found) throw new Error('No UI Action found for specialized owner ' + file + ' (' + port + ')');
}
for (const [file, port, adapter] of [
    ['components/settings/externalSessions/externalSessionsIntegrationController.ts', 'pluginSessionHookManagementAction', 'executeHookMutation'],
    ['components/secrets/useSharedSavedSecretReveal.ts', 'savedSecretRevealAction', 'runTeamAction'],
]) {
    const tree = parsedFile('apps/ui/sources/' + file);
    if (!tree.text.includes(port + ':')) throw new Error('Missing specialized binding ' + port);
    let found = false;
    walk(tree, n => {
        if (!ts.isCallExpression(n) || n.expression.getText() !== adapter) return;
        const [arg] = n.arguments;
        if (!arg) return;
        const operand = ts.isObjectLiteralExpression(arg)
            ? arg.properties.find(p => ts.isPropertyAssignment(p) && p.name.getText() === 'actionId')?.initializer
            : arg;
        if (operand) found = recordSpecialized(n, operand, port) || found;
    });
    if (!found) throw new Error('No UI Action found for specialized owner ' + file + ' (' + port + ')');
}
const bindings = new Map();
const unresolvedSpreads = new Set();
const bindingStack = new Set();
function origin(node) {
    const tree = node.getSourceFile();
    return tree.fileName + ':' + (tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1);
}
function unwrap(node) {
    while (ts.isAsExpression(node) || ts.isParenthesizedExpression(node) || ts.isNonNullExpression(node)
        || ts.isSatisfiesExpression(node) || ts.isAwaitExpression(node)) node = node.expression;
    return node;
}
function resolveBinding(node) {
    let nearest;
    for (let scope = node.parent; scope; scope = scope.parent) {
        if (!ts.isBlock(scope) && !ts.isSourceFile(scope)) continue;
        for (const statement of scope.statements) {
            if (statement.getStart() >= node.getStart()) break;
            if (ts.isVariableStatement(statement)) for (const decl of statement.declarationList.declarations) {
                if (ts.isIdentifier(decl.name) && decl.name.text === node.text && decl.initializer) nearest = decl.initializer;
            }
            if (ts.isExpressionStatement(statement) && ts.isBinaryExpression(statement.expression)
                && statement.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken
                && statement.expression.left.getText() === node.text) nearest = statement.expression.right;
        }
        if (nearest) return nearest;
    }
}
function collectAssignments(identifier) {
    let scope = identifier.parent;
    while (scope && !ts.isBlock(scope)) scope = scope.parent;
    if (!scope) return;
    function visit(node) {
        if (node.getStart() >= identifier.getStart() || ts.isFunctionLike(node)) return;
        if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
            && ts.isIdentifier(node.left) && node.left.text === identifier.text) {
            collectBindings(node.right);
            return;
        }
        ts.forEachChild(node, visit);
    }
    visit(scope);
}
function resolveModule(file, specifier) {
    if (specifier.startsWith('@happier-dev/')) {
        try {
            return require.resolve(specifier);
        } catch {
            return undefined;
        }
    }
    const base = specifier.startsWith('@/') ? path.join('apps/ui/sources', specifier.slice(2))
        : specifier.startsWith('.') ? path.join(path.dirname(file), specifier) : null;
    return base && [base.replace(/\.js$/, '.ts'), base + '.ts', base + '.tsx', path.join(base, 'index.ts')]
        .find(candidate => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
}
function resolveExport(tree, name) {
    for (const statement of tree.statements) {
        if (ts.isFunctionDeclaration(statement) && statement.name?.text === name) return statement;
        if (ts.isVariableStatement(statement)) {
            const declaration = statement.declarationList.declarations.find(d => d.name.getText() === name && d.initializer);
            if (declaration) return unwrap(declaration.initializer);
        }
        if (!ts.isExportDeclaration(statement) || !statement.moduleSpecifier || !statement.exportClause
            || !ts.isNamedExports(statement.exportClause)) continue;
        const binding = statement.exportClause.elements.find(e => e.name.text === name);
        if (!binding) continue;
        const target = resolveModule(tree.fileName, statement.moduleSpecifier.text);
        if (target) return resolveExport(parsedFile(target), binding.propertyName?.text ?? name);
    }
}
function resolveFunction(node) {
    const tree = node.getSourceFile();
    const name = node.getText();
    const local = tree.statements.find(s => ts.isFunctionDeclaration(s) && s.name?.text === name);
    if (local) return local;
    for (const statement of tree.statements) {
        if (!ts.isImportDeclaration(statement) || !statement.importClause?.namedBindings
            || !ts.isNamedImports(statement.importClause.namedBindings)) continue;
        const binding = statement.importClause.namedBindings.elements.find(e => e.name.text === name);
        if (!binding) continue;
        const target = resolveModule(tree.fileName, statement.moduleSpecifier.text);
        return target && resolveExport(parsedFile(target), binding.propertyName?.text ?? name);
    }
    const variable = resolveBinding(node);
    return variable && unwrap(variable);
}
function collectFunctionReturns(fn, collect) {
    if (!fn?.body) return false;
    if (!ts.isBlock(fn.body)) {
        collect(fn.body);
        return true;
    }
    function scan(node) {
        if (ts.isFunctionLike(node)) return;
        if (ts.isReturnStatement(node) && node.expression) collect(node.expression);
        else ts.forEachChild(node, scan);
    }
    scan(fn.body);
    return true;
}
function collectBindings(node) {
    node = unwrap(node);
    if (bindingStack.has(node)) return;
    bindingStack.add(node);
    try {
        if (ts.isObjectLiteralExpression(node)) {
            for (const property of node.properties) {
                if (ts.isSpreadAssignment(property)) collectBindings(property.expression);
                else if (property.name && !ts.isComputedPropertyName(property.name)) {
                    const key = property.name.getText();
                    if (!bindings.has(key)) bindings.set(key, new Set());
                    bindings.get(key).add(origin(property));
                }
            }
        } else if (ts.isConditionalExpression(node)) {
            collectBindings(node.whenTrue); collectBindings(node.whenFalse);
        } else if (ts.isBinaryExpression(node) && [ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken].includes(node.operatorToken.kind)) {
            collectBindings(node.left); collectBindings(node.right);
        } else if (ts.isIdentifier(node) && node.text !== 'undefined') {
            const resolved = resolveBinding(node);
            if (resolved) {
                collectBindings(resolved);
                collectAssignments(node);
            }
            else unresolvedSpreads.add(origin(node) + ' ' + node.getText());
        } else if (ts.isCallExpression(node)) {
            const callee = unwrap(node.expression);
            const fn = ts.isArrowFunction(callee) ? callee : ts.isIdentifier(callee) ? resolveFunction(callee) : undefined;
            if (!collectFunctionReturns(fn, collectBindings)) unresolvedSpreads.add(origin(node) + ' ' + node.expression.getText());
        } else if (node.kind !== ts.SyntaxKind.NullKeyword) {
            unresolvedSpreads.add(origin(node) + ' ' + node.getText().slice(0, 120));
        }
    } finally {
        bindingStack.delete(node);
    }
}
let dependencyObject;
walk(parsedFile(app), n => {
    if (ts.isCallExpression(n) && n.expression.getText() === 'createActionExecutor') dependencyObject = n.arguments[0];
});
if (!dependencyObject) throw new Error('Cannot find default UI Action executor dependency object');
collectBindings(dependencyObject);
const availableNames = new Set([...bindings.keys()].filter(port => !specializedPorts.has(port)));
// A specialized family can also expose an exact default leaf. Count only the
// variants accepted by its Action-id refusal guard, not every family member.
const defaultVariants = new Map();
walk(parsedFile(app), n => {
    if (!ts.isPropertyAssignment(n) || !specializedPorts.has(n.name.getText())) return;
    const initializer = unwrap(n.initializer);
    if (!ts.isBinaryExpression(initializer) || initializer.operatorToken.kind !== ts.SyntaxKind.QuestionQuestionToken) return;
    const fallback = unwrap(initializer.right);
    if (!ts.isArrowFunction(fallback) || !ts.isBlock(fallback.body)) return;
    const guard = fallback.body.statements[0];
    if (!guard || !ts.isIfStatement(guard) || !ts.isBinaryExpression(guard.expression)) return;
    const { left, right, operatorToken } = guard.expression;
    if (left.getText() !== 'actionId' || !ts.isStringLiteral(right)
        || operatorToken.kind !== ts.SyntaxKind.ExclamationEqualsEqualsToken
        || !/unsupported_action/.test(guard.thenStatement.getText())) return;
    defaultVariants.set(n.name.getText(), right.text);
});
const hasDefaultPort = (id, port) => availableNames.has(port) || defaultVariants.get(port) === id;

const unresolved = new Set();
const moduleCache = new Map();
function moduleFor(full) {
    if (!moduleCache.has(full)) moduleCache.set(full, import(pathToFileURL(path.resolve(full)).href).catch(() => ({})));
    return moduleCache.get(full);
}

for (const file of [protocol + '/actionExecutor.ts', ...readDispatchers(protocol + '/executor')]) {
    const tree = source(file);
    const imported = {};
    const variables = new Map();
    for (const statement of tree.statements) {
        if (!ts.isImportDeclaration(statement) || !statement.importClause || statement.importClause.isTypeOnly) continue;
        const { namedBindings } = statement.importClause;
        if (!namedBindings || !ts.isNamedImports(namedBindings)) continue;
        const full = path.join(path.dirname(file), statement.moduleSpecifier.text.replace(/\.js$/, '.ts'));
        if (!statement.moduleSpecifier.text.startsWith('.') || !fs.existsSync(full)) continue;
        const module = await moduleFor(full);
        for (const { name, propertyName, isTypeOnly } of namedBindings.elements) {
            if (!isTypeOnly) imported[name.text] = module[propertyName?.text ?? name.text];
        }
    }
    walk(tree, n => {
        if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) {
            if (!variables.has(n.name.text)) variables.set(n.name.text, []);
            variables.get(n.name.text).push(n);
        }
    });
    function enclosedBy(decl, node) {
        let block = decl;
        while (block.parent && !ts.isBlock(block) && !ts.isSourceFile(block)) block = block.parent;
        return node.pos >= block.pos && node.end <= block.end;
    }
    function envAt(node, id) {
        const UNRESOLVED = Symbol('unknown');
        function evaluate(expression, local = {}) {
            if (!expression) return UNRESOLVED;
            if (ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression) || ts.isNonNullExpression(expression)) return evaluate(expression.expression, local);
            if (ts.isIdentifier(expression)) {
                const name = expression.text;
                if (name === 'actionId') return id;
                if (name === 'ctx') return { surface: 'ui', actionCaller: { kind: 'host' } };
                if (name === 'undefined') return undefined;
                if (Object.hasOwn(local, name)) return local[name];
                if (imported[name] !== undefined) return imported[name];
                const decl = variables.get(name)?.findLast(candidate => candidate.end < expression.pos && enclosedBy(candidate, node));
                if (decl) return evaluate(decl.initializer, local);
                // This argument is selected by the caller before entering dispatchMachineControls2.
                if (name === 'machinePoolActionId') return MachinePoolActionIdV1Schema.options.includes(id) ? id : null;
                return UNRESOLVED;
            }
            if (ts.isStringLiteralLike(expression)) return expression.text;
            if (ts.isNumericLiteral(expression)) return Number(expression.text);
            if (expression.kind === ts.SyntaxKind.NullKeyword) return null;
            if (expression.kind === ts.SyntaxKind.TrueKeyword) return true;
            if (expression.kind === ts.SyntaxKind.FalseKeyword) return false;
            if (ts.isPrefixUnaryExpression(expression) && expression.operator === ts.SyntaxKind.ExclamationToken) {
                const value = evaluate(expression.operand, local);
                return value === UNRESOLVED ? value : !value;
            }
            if (ts.isConditionalExpression(expression)) {
                const test = evaluate(expression.condition, local);
                return test === UNRESOLVED ? test : evaluate(test ? expression.whenTrue : expression.whenFalse, local);
            }
            if (ts.isBinaryExpression(expression)) {
                const left = evaluate(expression.left, local);
                const right = evaluate(expression.right, local);
                switch (expression.operatorToken.kind) {
                    case ts.SyntaxKind.AmpersandAmpersandToken: return left === UNRESOLVED
                        ? right === false ? false : UNRESOLVED : left && right;
                    case ts.SyntaxKind.BarBarToken: return left === UNRESOLVED
                        ? right === true ? true : UNRESOLVED : left || right;
                    case ts.SyntaxKind.EqualsEqualsEqualsToken: return left === UNRESOLVED || right === UNRESOLVED ? UNRESOLVED : left === right;
                    case ts.SyntaxKind.ExclamationEqualsEqualsToken: return left === UNRESOLVED || right === UNRESOLVED ? UNRESOLVED : left !== right;
                    case ts.SyntaxKind.InKeyword: return left === UNRESOLVED || right === UNRESOLVED || right === null || typeof right !== 'object' ? UNRESOLVED : left in right;
                }
            }
            if (ts.isArrayLiteralExpression(expression)) {
                const result = expression.elements.map(child => evaluate(child, local));
                return result.includes(UNRESOLVED) ? UNRESOLVED : result;
            }
            if (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) {
                if (expression.getText() === 'Object.hasOwn') return Object.hasOwn;
                if (ts.isPropertyAccessExpression(expression) && expression.name.text === 'actionId'
                    && ts.isIdentifier(expression.expression) && expression.expression.text === 'inv') return id;
                const parent = evaluate(expression.expression, local);
                const key = ts.isPropertyAccessExpression(expression) ? expression.name.text : evaluate(expression.argumentExpression, local);
                if (parent === UNRESOLVED || key === UNRESOLVED || parent == null) return UNRESOLVED;
                const value = parent[key];
                return typeof value === 'function' ? value.bind(parent) : value;
            }
            if (ts.isArrowFunction(expression) && expression.parameters.length === 1 && ts.isIdentifier(expression.parameters[0].name)
                && !ts.isBlock(expression.body)) {
                return value => evaluate(expression.body, { ...local, [expression.parameters[0].name.text]: value }) === true;
            }
            if (ts.isCallExpression(expression)) {
                const name = expression.expression.getText();
                // Evaluate only pure Action predicates and finite catalog lookups.
                if (!/^(?:is[A-Z]\w*|read[A-Z]\w*ActionId\w*|resolve[A-Z]\w*ActionId\w*|Object\.hasOwn)$|\.(?:includes|some|find|has|startsWith|safeParse)$/.test(name))
                    return UNRESOLVED;
                const callable = evaluate(expression.expression, local);
                const args = expression.arguments.map(child => evaluate(child, local));
                if (name === 'isActionFamilyId' && args[1]?.options && args[0] !== UNRESOLVED) return args[1].options.includes(args[0]);
                if (typeof callable !== 'function' || args.includes(UNRESOLVED)) return UNRESOLVED;
                try { return callable(...args); } catch { return UNRESOLVED; }
            }
            return UNRESOLVED;
        }
        return evaluate;
    }
    function dispatchFunction(node) {
        for (let scope = node.parent; scope && scope !== tree; scope = scope.parent) {
            if (ts.isFunctionDeclaration(scope) && /^(dispatch[A-Z]|executeWorkspaceSync$)/.test(scope.name?.text ?? '')) return true;
            if (ts.isVariableDeclaration(scope) && scope.name.getText() === 'executeCore') return true;
        }
        return false;
    }
    const branches = [];
    walk(tree, n => {
        if (!dispatchFunction(n)) return;
        if (ts.isIfStatement(n)) {
            if (ts.isReturnStatement(n.thenStatement) && n.thenStatement.expression?.kind === ts.SyntaxKind.NullKeyword
                && ts.isBlock(n.parent)) {
                branches.push({ node: n, condition: n.expression, body: n.parent, inverted: true });
            } else branches.push({ node: n, condition: n.expression, body: n.thenStatement });
        }
        if (ts.isCaseClause(n) && n.parent.parent.expression.getText() === 'actionId') branches.push({ node: n, case: n.expression, body: n });
    });
    function location(n) { return file + ':' + (tree.getLineAndCharacterOfPosition(n.getStart(tree)).line + 1); }
    function dependencyReads(node) {
        const ports = new Set();
        walk(node, n => {
            if (ts.isPropertyAccessExpression(n) && ['deps', 'inv.deps'].includes(n.expression.getText())) ports.add(n.name.text);
            if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.arguments.some(arg => arg.getText() === 'deps'
                || ts.isObjectLiteralExpression(arg) && arg.properties.some(p => ts.isShorthandPropertyAssignment(p) && p.name.text === 'deps'))) {
                const fn = imported[n.expression.text];
                if (typeof fn !== 'function') return;
                for (const [, port] of Function.prototype.toString.call(fn).matchAll(/\bdeps\.(\w+)/g)) ports.add(port);
            }
        });
        return [...ports];
    }
    const dispatch = new Map();
    for (const { node, condition, case: tag, body, inverted } of branches) {
        const cond = condition ?? tag;
        const condText = cond.getText();
        if (!tag && !/\b(?:actionId|\w+Id|\w+Action)\b/.test(condText)) continue;
        // Inverted filters are admission guards, not positive dispatch selectors.
        if (!inverted && !tag && (/^(?:!|[\w.]+\s*!==(?!\s*null))/.test(condText) || /^\w+\s*===\s*null$/.test(condText))) continue;
        const matched = ids.filter(id => {
            const value = envAt(node, id)(cond);
            return tag ? value === id : inverted ? value === false : value === true || value === id;
        });
        if (!matched.length) {
            if (/actionId/.test(condText) && condText.length < 240) unresolved.add(location(node) + ' ' + condText);
            continue;
        }
        if (matched.length === ids.length) continue;
        const loc = location(node);
        const ports = dependencyReads(body);
        if (ports.length === 0 && !/\b(?:return|case)\b/.test(body.getText())) continue;
        dispatch.set(node, matched);
        for (const id of matched) {
            const row = rows.get(id);
            row.sites.add(loc + (ports.length ? ' [' + ports.join(',') + ']' : ''));
            for (const port of ports) if (hasDefaultPort(id, port)) row.bound.add(port);
            if (!ports.length && /\b(?:executeHostChild|searchSerializedActionSpecsForSurface|testAutomationEventV1|getWorkflowStarterExamplesV1|previewActionSessionTargets)\b/.test(body.getText()))
                row.inline.add(loc);
        }
        // An optional-call ternary reports unsupported via its returned value,
        // instead of an explicit !deps.port guard. Resolve the selected arm.
        if (/if\s*\(result === undefined\) return \{ ok: false, errorCode: 'unsupported_action'/.test(body.getText())) {
            walk(body, n => {
                if (!ts.isVariableDeclaration(n) || n.name.getText() !== 'result' || !n.initializer
                    || !ts.isConditionalExpression(n.initializer)) return;
                for (const id of matched) {
                    const value = envAt(n, id)(n.initializer.condition);
                    if (typeof value !== 'boolean') continue;
                    for (const port of dependencyReads(value ? n.initializer.whenTrue : n.initializer.whenFalse)) {
                        if (!hasDefaultPort(id, port)) rows.get(id).missing.add(loc + ' [' + port + ']');
                    }
                }
            });
        }
    }
    const absent = new Set();
    walk(tree, n => {
        if (!ts.isReturnStatement(n) || !dispatchFunction(n) || !n.expression || !/errorCode:\s*['"]unsupported_action['"]/.test(n.expression.getText())) return;
        let missingPorts = [];
        for (let match = n.parent; match && match !== tree; match = match.parent) {
            if (!ts.isIfStatement(match)) continue;
            const expr = match.expression.getText();
            for (const [, port] of expr.matchAll(/!(?:inv\.)?deps\.(\w+)/g)) {
                if (!availableNames.has(port)) missingPorts.push(port);
            }
            if (!missingPorts.length || !dispatch.has(match)) continue;
            const evidence = location(n) + ' [' + [...new Set(missingPorts)].join(',') + ']';
            for (const id of dispatch.get(match)) {
                // UI uses its bound host family. The sibling plugin-caller branch
                // does not run on UI for these same IDs.
                if (missingPorts.every(port => hasDefaultPort(id, port))) continue;
                if (missingPorts.includes('externalSessionAction') && isHostExternalSessionActionId(id)
                    && availableNames.has('hostExternalSessionAction')) continue;
                rows.get(id).missing.add(evidence);
            }
            missingPorts = [];
            break;
        }
        missingPorts.forEach(port => absent.add(location(n) + ' ' + port));
    });
    absent.forEach(site => unresolved.add(site));
}
function native(spec) {
    // Placement conditional on user input remains provisional here.
    if (!spec.executionPlacementForInput) return isUiMachineOwnedAdmissionAction(spec.id, {});
    const parsed = spec.inputSchema.safeParse({});
    return parsed.success && isUiMachineOwnedAdmissionAction(spec.id, parsed.data);
}
const counts = { specs: ids.length, bound_port: 0, shared_dispatch: 0, native_ingress: 0, specialized: 0, unbound: 0, unresolved: 0 };
const missing = [];
for (const spec of catalog) {
    const row = rows.get(spec.id);
    const owner = specialized.get(spec.id)?.some(({ port }) => [...row.sites].some(site => site.includes(port)));
    const classification = owner ? 'specialized' : native(spec) ? 'native_ingress'
        : row.missing.size ? 'unbound' : row.bound.size ? 'bound_port' : row.inline.size ? 'shared_dispatch' : 'unresolved';
    counts[classification]++;
    if (classification === 'unbound' || classification === 'unresolved') missing.push(spec.id);
}
process.stdout.write(JSON.stringify({ counts, missing: missing.sort() }) + '\n');
if (process.argv.includes('--assert-complete') && missing.length) process.exitCode = 1;
