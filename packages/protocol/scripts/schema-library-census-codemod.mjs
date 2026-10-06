// Development-only AST census and scratch-copy migration prototype.
// Census: hstack-exec -- node .../schema-library-census-codemod.mjs census
// Prototype (local source mutation): node .../schema-library-census-codemod.mjs prototype <scratch>
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, cpSync, existsSync, symlinkSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createExternalScratch, requireExternalScratch } from './schemaLibraryScratch.mjs';
const repo = process.cwd();
const req = createRequire(new URL('../package.json', import.meta.url));
const ts = req('typescript');
const mode = process.argv[2];
const externalScratch = value => requireExternalScratch(repo,value);
function parse(path) { return ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true); }
const apiNames = new Set('optional nullable nullish default prefault catch readonly brand array or and pipe transform refine superRefine preprocess lazy discriminatedUnion object strictObject looseObject string number int boolean literal enum nativeEnum union intersection record tuple date coerce min max length nonnegative positive nonpositive negative finite multipleOf safeExtend extend merge pick omit partial required strict passthrough strip catchall keyof trim toLowerCase toUpperCase regex email url uuid datetime describe meta custom check parse safeParse parseAsync safeParseAsync unwrap clone'.split(' '));
function bindings(source) {
  const aliases = new Set(); const vars = new Map();
  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement) && /^zod(?:\/|$)/.test(statement.moduleSpecifier.text)) {
      const clause = statement.importClause;
      if (clause?.name) aliases.add(clause.name.text);
      const binding = clause?.namedBindings;
      if (binding && ts.isNamespaceImport(binding)) aliases.add(binding.name.text);
      if (binding && ts.isNamedImports(binding)) for (const item of binding.elements) if ((item.propertyName?.text ?? item.name.text) === 'z') aliases.add(item.name.text);
    }
  }
  function visit(node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) vars.set(node.name.text, node.initializer);
    if (ts.isParameter(node) && ts.isIdentifier(node.name) && node.type?.getText(source).includes('typeof z')) aliases.add(node.name.text);
    ts.forEachChild(node, visit);
  }
  visit(source);
  function schema(node, seen = new Set()) {
    if (ts.isIdentifier(node)) {
      if (aliases.has(node.text) || /[Ss]chema$/.test(node.text)) return true;
      if (seen.has(node.text)) return false;
      seen.add(node.text); return vars.has(node.text) && schema(vars.get(node.text), seen);
    }
    if (ts.isCallExpression(node)) return schema(node.expression, seen);
    if (ts.isPropertyAccessExpression(node)) return schema(node.expression, seen);
    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node)) return schema(node.expression, seen);
    return false;
  }
  function primitive(node, seen = new Set()) {
    if (ts.isIdentifier(node)) {
      if (seen.has(node.text)) return null; seen.add(node.text);
      return vars.has(node.text) ? primitive(vars.get(node.text), seen) : null;
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const method = node.expression.name.text;
      if (['string','number','array','set','int'].includes(method)) return method === 'int' ? 'number' : method;
      return primitive(node.expression.expression, seen);
    }
    return null;
  }
  return { aliases, vars, schema, primitive };
}
if (mode === 'inventory') {
  const scratch = externalScratch(process.argv[3]);
  const inventory = spawnSync('git', ['ls-files','-co','--exclude-standard','--','apps','packages'], { encoding:'utf8',maxBuffer:32*1024*1024 });
  if (inventory.status !== 0) throw new Error(inventory.stderr);
  const sourceFiles = [...new Set(inventory.stdout.trim().split('\n'))].filter(path => /\.(?:tsx?|mjs|cjs)$/.test(path) && !/\.d\.ts$/.test(path) && !path.includes('/node_modules/') && !path.includes('/dist/') && !path.includes('/.schema-library-scratch-') && existsSync(resolve(repo,path)));
  writeFileSync(resolve(scratch,'source-inventory.json'),JSON.stringify(sourceFiles));
  console.log(JSON.stringify({ sourceFiles:sourceFiles.length,inventory:resolve(scratch,'source-inventory.json') }));
} else if (mode === 'census') {
  const packages = new Map(); const sites = { jsonSchema: [], errorConsumers: [], introspection: [], exportedInfer: [], publicSeam: [] };
  // Git's source inventory excludes ignored build/custody replicas. A filesystem
  // walk here accidentally includes experiment/build copies of the same code.
  const sourceFiles = JSON.parse(readFileSync(resolve(process.argv[3]),'utf8')); const disappearedFiles = [];
  console.error(`Census source files: ${sourceFiles.length}`);
  for (const filePath of sourceFiles) {
    const path = resolve(repo,filePath);
    if (!existsSync(path)) { disappearedFiles.push(filePath); continue; }
    const content = readFileSync(path,'utf8');
    if (!/\bzod\b|toJSONSchema|\.(?:issues|format|flatten)\b/.test(content)) continue;
    const source = ts.createSourceFile(path,content,ts.ScriptTarget.Latest,true); const file = relative(repo, path);
    const owner = file.startsWith('packages/plugins/') ? file.split('/').slice(0,3).join('/') : file.split('/').slice(0,2).join('/');
    const test = /(?:\.test|\.spec|testkit|fixtures|__tests__)/.test(file);
    const bucket = packages.get(owner) ?? { productionFiles: 0, testFiles: 0, api: {}, testApi: {}, infer: 0, exportedInfer: 0, zodTypes: {}, introspection: {} };
    const { aliases, schema } = bindings(source);
    if (aliases.size) bucket[test ? 'testFiles' : 'productionFiles']++;
    const add = (target, name) => target[name] = (target[name] ?? 0) + 1;
    const site = node => `${file}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`;
    function visit(node) {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
        const method = node.expression.name.text;
        if (aliases.size && apiNames.has(method) && schema(node.expression.expression)) add(test ? bucket.testApi : bucket.api, method);
        if (!test && method === 'toJSONSchema') sites.jsonSchema.push({ site: site(node), text: node.getText(source).slice(0,300) });
      }
      if (!test && ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'toJSONSchema') sites.jsonSchema.push({ site: site(node), text: node.getText(source).slice(0,300) });
      if (ts.isPropertyAccessExpression(node)) {
        const key = node.name.text;
        if (!test && ['shape','_def','_zod','options','element','def'].includes(key) && schema(node.expression)) { add(bucket.introspection, key); sites.introspection.push({ site: site(node), key }); }
        if (!test && ['issues','flatten','format'].includes(key) && /(?:error|err|parsed|result|failure)/i.test(node.expression.getText(source))) sites.errorConsumers.push({ site: site(node), expression: node.getText(source).slice(0,220) });
      }
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword && /Zod/.test(node.right.getText(source))) { add(bucket.introspection, 'instanceof'); sites.introspection.push({ site: site(node), key: 'instanceof', text: node.getText(source) }); }
      if (ts.isQualifiedName(node) && aliases.has(node.left.getText(source))) {
        const name = node.right.text;
        if (name === 'infer' || name === 'input' || name === 'output') {
          bucket.infer++;
          let parent = node; while (parent.parent && !ts.isTypeAliasDeclaration(parent)) parent = parent.parent;
          if (!test && ts.isTypeAliasDeclaration(parent) && parent.modifiers?.some(item => item.kind === ts.SyntaxKind.ExportKeyword)) { bucket.exportedInfer++; sites.exportedInfer.push({ site: site(node), type: parent.name.text }); }
        } else if (/^(?:Zod|Refinement)/.test(name)) { add(bucket.zodTypes, name); if (!test) sites.publicSeam.push({ site: site(node), type: name }); }
      }
      ts.forEachChild(node, visit);
    }
    visit(source); if (aliases.size || Object.keys(bucket.api).length || Object.keys(bucket.introspection).length) packages.set(owner, bucket);
  }
  console.log(JSON.stringify({ sourceFiles:sourceFiles.length,disappearedFiles,basis: 'current on-disk tracked+untracked nonignored first-party apps/packages; excludes dependencies, outputs, .d.ts; schema lineage heuristic in Zod-importing files, not a whole-repo typechecker', packages: Object.fromEntries([...packages].sort()), sites }));
} else if (mode === 'prototype') {
  const scratch = externalScratch(process.argv[3]);
  if (!existsSync(resolve(scratch, 'package.json'))) throw new Error('Requires installed scratch-only ts-morph');
  const scratchReq = createRequire(resolve(scratch, 'package.json'));
  const { Project } = scratchReq('ts-morph');
  const paths = [
    'actions/actionSpecs.ts','actions/specs/browser.ts','actions/specs/common.ts','actions/specs/scope.ts','actions/specs/wait.ts',
    'actions/specs/widgets.ts','actions/specs/teams.ts','actions/specs/home.ts','actions/specs/localServices.ts','actions/actionSettings.ts',
    'account/settings/accountSettings.ts','account/settings/sessionReminderPresetsV1.ts','account/settings/sessionAgentSpawnPolicyV1.ts',
    'account/settings/sessionAgentStartAllowListsV1.ts','account/settings/legacyAuthoringMemorySettingsV1.ts',
    'sessions/metadata/sessionMetadataSchemasV1.ts','sessions/metadata/terminalMetadata.ts','sessions/metadata/windowsTerminalWindowName.ts',
    'sessions/metadata/windowsRemoteSessionLaunchMode.ts','sessions/metadata/metadataOverridesV1.ts','sessions/metadata/sessionRollbackRangesV1.ts',
    'daemon/contributionRegistryProjection.ts','plugins/actions/internalProtocolZodAdapter.ts','plugins/manifest/v2.ts',
    'plugins/contributions/settings.ts','connect/connectedServiceSchemas.ts','rpc/providers.ts','workflows/workflowProgressV1.ts',
    'tools/v2/schemas.ts','reviews/comments/v1.ts',
  ];
  const sourceRoot = resolve(repo, 'packages/protocol/src'); const copy = resolve(scratch, 'copy');
  cpSync(sourceRoot, resolve(copy, 'src'), { recursive: true, filter: path => !/\.d\.ts(?:\.map)?$/.test(path) });
  // This is authored ambient input, unlike generated sibling declarations.
  cpSync(resolve(sourceRoot,'auth/tr46.d.ts'),resolve(copy,'src/auth/tr46.d.ts'));
  cpSync(resolve(repo,'packages/protocol/package.json'), resolve(copy,'package.json'));
  // Scratch stays outside every watched checkout. Dependency links below point
  // at the existing workspace installation without copying it or changing it.
  if (!existsSync(resolve(copy,'node_modules'))) symlinkSync(resolve(repo,'node_modules'),resolve(copy,'node_modules'),'junction');
  const project = new Project({ skipAddingFilesFromTsConfig: true });
  const totals = { eligible: 0, converted: 0, unchangedMiniCompatible: 0, manual: {} }; const rows = [];
  const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed });
  for (const path of paths) {
    const original = resolve(sourceRoot, path); if (!existsSync(original)) throw new Error(`Missing representative ${path}`);
    const source = parse(original); const { aliases, schema, primitive } = bindings(source);
    const row = { path, eligible: 0, converted: 0, manual: {} };
    const marker = name => { row.manual[name] = (row.manual[name] ?? 0) + 1; totals.manual[name] = (totals.manual[name] ?? 0) + 1; };
    const zcall = (z, method, args) => ts.factory.createCallExpression(ts.factory.createPropertyAccessExpression(ts.factory.createIdentifier(z), method), undefined, args);
    const transform = context => node => {
      function visit(originalNode) {
        const updated = ts.visitEachChild(originalNode, visit, context);
        if (ts.isPropertyAccessExpression(originalNode) && ts.isPropertyAccessExpression(originalNode.expression) && originalNode.expression.name.text === 'ZodIssueCode' && aliases.has(originalNode.expression.expression.getText(source))) return ts.factory.createStringLiteral(originalNode.name.text);
        if (!ts.isCallExpression(originalNode) || !ts.isPropertyAccessExpression(originalNode.expression)) return updated;
        const receiver = originalNode.expression.expression; const method = originalNode.expression.name.text;
        if (aliases.has(receiver.getText(source))) {
          if (method === 'preprocess') {
            row.eligible++; totals.eligible++; row.converted++; totals.converted++;
            return zcall(receiver.getText(source),'pipe',[zcall(receiver.getText(source),'transform',[updated.arguments[0]]),updated.arguments[1]]);
          }
          if (method === 'nativeEnum') {
            row.eligible++; totals.eligible++; row.converted++; totals.converted++;
            return zcall(receiver.getText(source),'enum',updated.arguments);
          }
          return updated;
        }
        if (!schema(receiver) || !apiNames.has(method)) return updated;
        if (['parse','safeParse','parseAsync','safeParseAsync','brand','clone','check'].includes(method)) { totals.unchangedMiniCompatible++; return updated; }
        row.eligible++; totals.eligible++;
        const args = updated.arguments; const base = updated.expression.expression;
        const z = [...aliases][0] ?? 'z'; let replacement;
        if (['optional','nullable','nullish','default','prefault','catch','readonly','extend','safeExtend','pick','omit','partial','required','keyof','catchall'].includes(method)) replacement = zcall(z, method === 'default' ? '_default' : method, [base, ...args]);
        else if (method === 'array') replacement = zcall(z, 'array', [base]);
        else if (method === 'or') replacement = zcall(z, 'union', [ts.factory.createArrayLiteralExpression([base,...args])]);
        else if (method === 'and') replacement = zcall(z, 'intersection', [base, ...args]);
        else if (method === 'pipe') replacement = zcall(z, 'pipe', [base,...args]);
        else if (method === 'transform') replacement = zcall(z, 'pipe', [base,zcall(z,'transform',args)]);
        else if (['strict','strip','passthrough'].includes(method)) {
          if (ts.isCallExpression(base) && ts.isPropertyAccessExpression(base.expression) && base.expression.name.text === 'object') replacement = zcall(z, method === 'strict' ? 'strictObject' : method === 'passthrough' ? 'looseObject' : 'object', base.arguments);
          else if (method !== 'strip') replacement = zcall(z,'catchall',[base,zcall(z,method === 'strict' ? 'never' : 'unknown',[])]);
          else marker('strip-derived-object');
        } else {
          const names = { min: primitive(receiver) === 'number' ? 'minimum' : 'minLength', max: primitive(receiver) === 'number' ? 'maximum' : 'maxLength', int: 'int', nonnegative: 'nonnegative', positive: 'positive', nonpositive: 'nonpositive', negative: 'negative', length: 'length', trim: 'trim', regex: 'regex', refine: 'refine', superRefine: 'superRefine', describe: 'describe', meta: 'meta', multipleOf: 'multipleOf', email: 'email', url: 'url', uuid: 'uuid', datetime: 'iso.datetime', toLowerCase: 'toLowerCase', toUpperCase: 'toUpperCase' };
          if (method === 'finite') replacement = base;
          else if (['min','max'].includes(method) && !primitive(receiver)) marker(`${method}-unknown-schema-kind`);
          else if (names[method] && !names[method].includes('.')) {
            const check = zcall(z,names[method],args);
            // Collapse adjacent checks: one mini clone retains the ordered checks.
            replacement = ts.isCallExpression(base) && ts.isPropertyAccessExpression(base.expression) && base.expression.name.text === 'check'
              ? ts.factory.updateCallExpression(base, base.expression, base.typeArguments, [...base.arguments,check])
              : ts.factory.createCallExpression(ts.factory.createPropertyAccessExpression(base,'check'), undefined, [check]);
          } else marker(method);
        }
        if (!replacement) return updated;
        row.converted++; totals.converted++; return replacement;
      }
      return ts.visitNode(node, visit);
    };
    const result = ts.transform(source,[transform]);
    let output = printer.printFile(result.transformed[0]); result.dispose();
    // Import edits use ts-morph's structured API (not a regexp over source).
    const file = project.createSourceFile(resolve(copy,'src',path), output, { overwrite: true });
    for (const item of file.getImportDeclarations()) {
      if (!/^zod(?:\/v4)?$/.test(item.getModuleSpecifierValue())) continue;
      const zBinding = item.getNamedImports().find(specifier => specifier.getName() === 'z');
      if (zBinding) { const alias = zBinding.getAliasNode()?.getText() ?? 'z'; if (item.getNamedImports().length > 1) marker('mixed-named-zod-import'); else { item.removeNamedImports(); item.setNamespaceImport(alias); item.setModuleSpecifier('zod/mini'); } }
      else if (item.getNamespaceImport()) item.setModuleSpecifier('zod/mini');
    }
    output = file.getFullText();
    writeFileSync(resolve(copy,'src',path), output); rows.push(row);
  }
  const config = { compilerOptions: { target:'ES2022',module:'ESNext',moduleResolution:'Bundler',lib:['ES2022','DOM'],strict:true,skipLibCheck:true,noEmit:true,types:['node'],paths:{ zod:[resolve(repo,'packages/protocol/node_modules/zod')], 'zod/*':[resolve(repo,'packages/protocol/node_modules/zod/*')], 'zod-to-json-schema':[resolve(repo,'packages/protocol/node_modules/zod-to-json-schema')] } },files: [...paths.map(path => `src/${path}`),'src/auth/tr46.d.ts'] };
  writeFileSync(resolve(copy,'tsconfig.json'),JSON.stringify(config,null,2));
  const report = { scratch,copy, paths, rows,totals,autoConvertedPercent:100 * totals.converted/totals.eligible, basis:'30 selected schema-owner files; syntax conversion only; fluent type seams deliberately not cast away' };
  writeFileSync(resolve(scratch,'prototype-result.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify(report));
} else if (mode === 'baseline' || mode === 'smoke-config') {
  const scratch = externalScratch(process.argv[3]);
  const result = JSON.parse(readFileSync(resolve(scratch,'prototype-result.json'),'utf8'));
  if (mode === 'baseline') {
    cpSync(resolve(scratch,'copy'),resolve(scratch,'baseline'),{recursive:true});
    for (const path of result.paths) cpSync(resolve(repo,'packages/protocol/src',path),resolve(scratch,'baseline/src',path));
    console.log(JSON.stringify({ baseline:resolve(scratch,'baseline'),files:result.paths.length }));
  } else {
    const config = JSON.parse(readFileSync(resolve(scratch,'copy/tsconfig.json'),'utf8'));
    config.files = ['src/sessions/metadata/windowsTerminalWindowName.ts','src/sessions/metadata/windowsRemoteSessionLaunchMode.ts','src/account/settings/sessionReminderPresetsV1.ts'];
    writeFileSync(resolve(scratch,'copy/tsconfig.smoke.json'),JSON.stringify(config,null,2));
    console.log(JSON.stringify({ smokeFiles:config.files }));
  }
} else if (mode === 'slice-typecheck') {
  const scratch = createExternalScratch(repo,'happier-schema-slice-');
  const paths = process.argv.slice(3);
  if (!paths.length || paths.some(path=>!path.startsWith('packages/protocol/src/') || !existsSync(resolve(repo,path)))) throw new Error('Explicit existing Protocol source paths required');
  const config = {compilerOptions:{target:'ES2022',module:'ESNext',moduleResolution:'Bundler',strict:true,skipLibCheck:true,noEmit:true,types:['node'],typeRoots:[resolve(repo,'node_modules/@types')]},files:[...paths.map(path=>resolve(repo,path)),resolve(repo,'packages/protocol/src/auth/tr46.d.ts')]};
  const configPath = resolve(scratch,'tsconfig.json');
  writeFileSync(configPath,JSON.stringify(config,null,2));
  console.log(JSON.stringify({scratch,paths,node:process.version}));
  const result = spawnSync(process.execPath,['scripts/workspaces/runTypeScriptCli.mjs','--project',configPath],{stdio:'inherit'});
  process.exitCode = result.status ?? 1;
} else if (mode === 'validate') {
  // Routed validation creates target-local temporary copies; /tmp is deliberately
  // not synchronized into the local checkout or any remote watched mirror.
  const scratch = createExternalScratch(repo,'happier-schema-library-');
  const run = args => spawnSync(process.execPath,[new URL(import.meta.url).pathname,...args],{encoding:'utf8',maxBuffer:16*1024*1024});
  const install = spawnSync('npm',['install','--prefix',scratch,'--ignore-scripts','--no-audit','--no-fund','ts-morph@28.0.0'],{encoding:'utf8'});
  if (install.status !== 0) throw new Error(install.stderr);
  for (const task of ['prototype','baseline','smoke-config']) {
    const result = run([task,scratch]);
    if (result.status !== 0) throw new Error(result.stderr);
  }
  console.log(JSON.stringify({host:process.env.HOSTNAME,node:process.version,scratch,prototype:JSON.parse(readFileSync(resolve(scratch,'prototype-result.json'),'utf8')).totals}));
  for (const [name,path] of [['baseline','baseline/tsconfig.json'],['converted','copy/tsconfig.json'],['smoke','copy/tsconfig.smoke.json']]) {
    const result = spawnSync(process.execPath,['scripts/workspaces/runTypeScriptCli.mjs','--project',resolve(scratch,path)],{encoding:'utf8',maxBuffer:32*1024*1024});
    const output = result.stdout + result.stderr;
    writeFileSync(resolve(scratch,`${name}-typecheck.log`),output);
    const codes = {}; const matches = [...output.matchAll(/(.+?)\((\d+),(\d+)\): error (TS\d+): (.+)/g)];
    for (const match of matches) codes[match[4]] = (codes[match[4]] ?? 0) + 1;
    console.log(JSON.stringify({name,status:result.status,signal:result.signal,emittedDiagnostics:matches.length,codes,missingModules:[...new Set(matches.filter(match=>match[4]==='TS2307').map(match=>match[5]))],samples:matches.slice(0,8).map(match=>match[0]),log:resolve(scratch,`${name}-typecheck.log`)}));
    if (result.error) throw result.error;
  }
} else throw new Error('Expected census, prototype, baseline, smoke-config or validate');
