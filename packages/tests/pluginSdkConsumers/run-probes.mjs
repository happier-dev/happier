import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

import { resolveNpmCommandInvocation } from '../../../scripts/workspaces/execYarnCommand.mjs';
import { resolveTypeScriptCliInvocation } from '../../../scripts/workspaces/resolveTypeScriptCliInvocation.mjs';

const repoRoot = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const pluginSdkDir = join(repoRoot, 'packages', 'plugin-sdk');
const rootNodeModules = join(repoRoot, 'node_modules');
const sdkContractPath = join(pluginSdkDir, 'src', 'normalSurfaceContract.ts');
const consumerArg = process.argv.find((arg) => arg.startsWith('--consumer='));
const tarballArg = process.argv.find((arg) => arg.startsWith('--tarball='));
const requestedConsumers = new Set(
  consumerArg ? [consumerArg.slice('--consumer='.length)] : ['nodenext', 'vite'],
);
const suppliedTarballPath = tarballArg
  ? resolve(repoRoot, tarballArg.slice('--tarball='.length))
  : null;

const REMOVED_PACKAGE_PATHS = [
  './acp',
  './agent-runtime-v1',
  './agents',
  './events',
  './distribution',
  './internal/runtime/executionRun',
  './internal/runtime/session',
  './legacy',
  './manifest/agentSettings',
  './experimental/manifest/agentSettings',
  './runtime/session',
  './ui/artifacts',
  './ui/artifactIntegrity',
  './ui/bridgeClient',
  './ui/hostApiClient',
  './ui/hostRuntimeExternalsBuildPlugin',
  './ui/hostedWeb',
  './ui/hostedWebBuild',
  './ui/hostedWebDevServer',
  './ui/hostedWebRuntime',
  './ui/reactNativeBundles',
  './ui/reactNativeDevServer',
  './ui/reactNativeBuild',
  './ui/reactNativeWebBuild',
  './ui/reactNativeRepackStrictSafety',
  './account-usage',
  './hooks',
  './mcp',
  './reviews',
  './scm',
  './sessions',
  './usage',
];

const REMOVED_NORMAL_SYMBOL_IMPORTS = [
  ['.', 'PluginDistributionIdentityV1'],
  ['./manifest', 'PluginAgentAcpTransport'],
  ['./manifest', 'PluginToolContributionV2'],
  ['./runtime', 'PluginActivationApi'],
  ['./runtime', 'PluginExternalSessionCandidate'],
  ['./runtime', 'PluginExternalSessionRef'],
  ['./runtime', 'PluginExternalSessionsService'],
  ['./runtime', 'PluginExternalTranscriptFollowEvent'],
  ['./runtime', 'PluginExternalTranscriptFollowResult'],
  ['./runtime', 'PluginExternalTranscriptItem'],
  ['./runtime', 'PluginLoopbackWebSocketClientSpec'],
  ['./runtime', 'PluginLoopbackWebSocketHandshake'],
  ['./runtime', 'PluginLoopbackWebSocketHeader'],
  ['./runtime', 'PluginProjectsService'],
  ['./runtime', 'PluginProtocolClientKind'],
  ['./runtime', 'RuntimeCoreV1'],
  ['./agent-runtime', 'AcpSessionRuntimeV1'],
  ['./agent-runtime', 'AgentRuntimeV1'],
  ['./agent-runtime', 'AgentAccountUsageService'],
  ['./agent-runtime', 'AgentConfigurationScalar'],
  ['./agent-runtime', 'AgentRuntimeRegistrationOptions'],
  ['./agent-runtime', 'AgentRuntimeSurfaces'],
  ['./agent-runtime', 'AgentSessionAuthService'],
  ['./agent-runtime', 'AgentSessionMcpTransport'],
  ['./agent-runtime', 'AgentTerminalLaunchRequest'],
  ['./ui', 'PluginHostedWebContributionV1'],
  ['./ui', 'PluginUiSurfaceModule'],
  ['./ui/client', 'CreatePluginUiHostApiClientOptions'],
  ['./ui/build', 'PluginUiArtifactPlatform'],
  ['./ui/build', 'PluginUiBuildConfig'],
  ['./ui/build', 'PluginUiBuildTarget'],
  ['./ui/build', 'ReactNativeWebViteBuildPresetInput'],
  ['./ui/build', 'HostedWebViteBuildPresetInputV1'],
  ['./ui/build', 'defineHostedWebViteBuildPreset'],
  ['./testing', 'createPluginContextV1Fixture'],
  ['./testing', 'PluginContextFixtureLogV1'],
  ['./testing', 'PluginContextFixtureOptionsV1'],
  ['./testing', 'PluginContextFixtureRecordsV1'],
  ['./testing', 'PluginContextFixtureServicesV1'],
  ['./testing', 'PluginContextFixtureV1'],
  ['./testing', 'PluginTestkit'],
  ['./testing', 'PluginTestkitInvokeOptions'],
  ['./testing', 'PluginTestkitRegistration'],
];

const PACKED_GENERIC_TYPE_ARGUMENTS = new Map([
  ['PluginProtocolClientHandle', ["'jsonRpc'"]],
  ['PluginProtocolClientSpecByKind', ["'jsonRpc'"]],
]);

function packageSpecifier(entrypoint) {
  return entrypoint === '.'
    ? '@happier-dev/plugin-sdk'
    : `@happier-dev/plugin-sdk${entrypoint.slice(1)}`;
}

function assertOutOfWorkspace(path) {
  const relativePath = relative(repoRoot, path);
  if (
    relativePath === ''
    || (
      !isAbsolute(relativePath)
      && relativePath !== '..'
      && !relativePath.startsWith('../')
      && !relativePath.startsWith('..\\')
    )
  ) {
    throw new Error(`Consumer project must be outside the workspace: ${path}`);
  }
}

function unwrapExpression(expression) {
  if (
    ts.isAsExpression(expression)
    || ts.isSatisfiesExpression(expression)
    || ts.isParenthesizedExpression(expression)
  ) {
    return unwrapExpression(expression.expression);
  }
  return expression;
}

function readStringLiteralArray(expression, variableName) {
  const value = unwrapExpression(expression);
  if (!ts.isArrayLiteralExpression(value)) {
    throw new Error(`${variableName} must be an array literal`);
  }
  return value.elements.map((element) => {
    const literal = unwrapExpression(element);
    if (!ts.isStringLiteral(literal)) {
      throw new Error(`${variableName} must contain only string literals`);
    }
    return literal.text;
  });
}

function readStringLiteralRecord(expression, variableName) {
  const value = unwrapExpression(expression);
  if (!ts.isObjectLiteralExpression(value)) {
    throw new Error(`${variableName} must be an object literal`);
  }
  return Object.fromEntries(value.properties.map((property) => {
    if (!ts.isPropertyAssignment(property)) {
      throw new Error(`${variableName} must contain only property assignments`);
    }
    const key = property.name;
    if (!ts.isStringLiteral(key) && !ts.isIdentifier(key)) {
      throw new Error(`${variableName} contains a non-string key`);
    }
    return [key.text, readStringLiteralArray(property.initializer, variableName)];
  }));
}

function readStringValueRecord(expression, variableName) {
  const value = unwrapExpression(expression);
  if (!ts.isObjectLiteralExpression(value)) {
    throw new Error(`${variableName} must be an object literal`);
  }
  return Object.fromEntries(value.properties.map((property) => {
    if (!ts.isPropertyAssignment(property)) {
      throw new Error(`${variableName} must contain only property assignments`);
    }
    const key = property.name;
    const literal = unwrapExpression(property.initializer);
    if (
      (!ts.isStringLiteral(key) && !ts.isIdentifier(key))
      || !ts.isStringLiteral(literal)
    ) {
      throw new Error(`${variableName} must contain only string entries`);
    }
    return [key.text, literal.text];
  }));
}

export async function readCanonicalNormalSurfaceContract() {
  const sourceText = await readFile(sdkContractPath, 'utf8');
  const sourceFile = ts.createSourceFile(
    sdkContractPath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const declarations = new Map();
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.initializer) {
        declarations.set(declaration.name.text, declaration.initializer);
      }
    }
  }
  const allowlistInitializer = declarations.get('NORMAL_SURFACE_ALLOWLIST');
  const entrypointsInitializer = declarations.get('NORMAL_ENTRYPOINTS');
  if (!allowlistInitializer || !entrypointsInitializer) {
    throw new Error('Canonical normal-surface contract declarations are missing');
  }
  const allowlist = readStringLiteralRecord(
    allowlistInitializer,
    'NORMAL_SURFACE_ALLOWLIST',
  );
  const entrypoints = Object.keys(readStringValueRecord(
    entrypointsInitializer,
    'NORMAL_ENTRYPOINTS',
  ));
  if (JSON.stringify(Object.keys(allowlist)) !== JSON.stringify(entrypoints)) {
    throw new Error('Canonical normal-surface allowlist and entrypoints disagree');
  }
  return { allowlist };
}

export async function classifyPackedNormalSurface(packageRoot, allowlist) {
  const packageJson = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
  const declarationPaths = Object.fromEntries(Object.keys(allowlist).map((entrypoint) => {
    const target = packageJson.exports?.[entrypoint];
    if (!target || typeof target.types !== 'string') {
      throw new Error(`Packed SDK is missing a declaration target for ${entrypoint}`);
    }
    return [entrypoint, resolve(packageRoot, target.types)];
  }));
  const program = ts.createProgram({
    rootNames: Object.values(declarationPaths),
    options: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      strict: true,
      skipLibCheck: false,
    },
  });
  const checker = program.getTypeChecker();
  return Object.fromEntries(Object.entries(allowlist).map(([entrypoint, names]) => {
    const sourceFile = program.getSourceFile(declarationPaths[entrypoint]);
    if (!sourceFile) {
      throw new Error(`Packed SDK declaration is missing for ${entrypoint}`);
    }
    const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
    if (!moduleSymbol) {
      throw new Error(`Packed SDK declaration has no module symbol for ${entrypoint}`);
    }
    const exportsByName = new Map(
      checker.getExportsOfModule(moduleSymbol).map((symbol) => [symbol.name, symbol]),
    );
    const expectedNames = [...names].sort();
    const actualNames = [...exportsByName.keys()].sort();
    const missing = expectedNames.filter((name) => !exportsByName.has(name));
    const extra = actualNames.filter((name) => !expectedNames.includes(name));
    if (missing.length > 0 || extra.length > 0) {
      throw new Error([
        `Packed normal surface mismatch for ${entrypoint}:`,
        missing.length > 0 ? `missing ${missing.join(', ')}` : '',
        extra.length > 0 ? `extra ${extra.join(', ')}` : '',
      ].filter(Boolean).join(' '));
    }
    return [entrypoint, expectedNames.map((name) => {
      const symbol = exportsByName.get(name);
      const target = symbol.flags & ts.SymbolFlags.Alias
        ? checker.getAliasedSymbol(symbol)
        : symbol;
      const runtime = Boolean(target.flags & ts.SymbolFlags.Value);
      const genericDeclaration = runtime
        ? undefined
        : target.declarations?.find((declaration) => declaration.typeParameters?.length);
      const typeArguments = PACKED_GENERIC_TYPE_ARGUMENTS.get(name)
        ?? genericDeclaration?.typeParameters?.map((parameter) => (
          parameter.constraint
            ? checker.typeToString(
              checker.getTypeFromTypeNode(parameter.constraint),
              undefined,
              ts.TypeFormatFlags.NoTruncation,
            )
            : 'unknown'
        )) ?? [];
      return {
        name,
        runtime,
        ...(typeArguments.length > 0 ? { typeArguments } : {}),
      };
    })];
  }));
}

function renderRuntimeBehaviorConsumer(contractKey, reference, index) {
  switch (contractKey) {
    case '@happier-dev/plugin-sdk:PluginError':
      return [
        `const __pluginError${index} = new ${reference}({`,
        '  code: "packed_consumer_probe",',
        '  message: "Packed consumer probe",',
        '  details: { source: "external-nodenext" },',
        '});',
        `if (__pluginError${index}.code !== "packed_consumer_probe" || __pluginError${index}.data.name !== "PluginError") {`,
        '  throw new Error("PluginError contract mismatch");',
        '}',
      ];
    case '@happier-dev/plugin-sdk/agent-runtime:AgentRuntimeJsonValueSchema':
      return [
        `const __jsonValue${index} = ${reference}.parse({ nested: ["value", 1, true, null] });`,
        `if (!__jsonValue${index} || typeof __jsonValue${index} !== "object" || Array.isArray(__jsonValue${index})) {`,
        '  throw new Error("AgentRuntimeJsonValueSchema contract mismatch");',
        '}',
      ];
    case '@happier-dev/plugin-sdk/agent-runtime:AgentSessionRuntimeEventSchema':
      return [
        `const __runtimeEvent${index} = ${reference}.safeParse({`,
        '  kind: "turn-complete",',
        '  sequence: 1,',
        '  sessionId: "packed-consumer-session",',
        '  emittedAtMs: 1,',
        '  turnId: "packed-consumer-turn",',
        '});',
        `if (!__runtimeEvent${index}.success) throw new Error("AgentSessionRuntimeEventSchema contract mismatch");`,
      ];
    case '@happier-dev/plugin-sdk/ui/client:createPluginUiHostApiClient':
      return [
        `let __clientFailure${index}: unknown = null;`,
        `try { await ${reference}(); } catch (error) { __clientFailure${index} = error; }`,
        `if (!(__clientFailure${index} instanceof Error)`,
        `  || !("code" in __clientFailure${index})`,
        `  || __clientFailure${index}.code !== "ui_host_bootstrap_missing") {`,
        '  throw new Error("createPluginUiHostApiClient must fail closed without host bootstrap");',
        '}',
      ];
    case '@happier-dev/plugin-sdk/ui/build:PLUGIN_UI_BUILD_CONFIG_BASENAMES':
      return [
        `if (!Object.isFrozen(${reference})`,
        `  || !${reference}.includes("happier-plugin-ui.config.mjs")) {`,
        '  throw new Error("PLUGIN_UI_BUILD_CONFIG_BASENAMES contract mismatch");',
        '}',
      ];
    case '@happier-dev/plugin-sdk/ui/build:createReactNativeRepackSharedModules':
      return [
        `const __repackShared${index} = ${reference}();`,
        `if (__repackShared${index}["react/jsx-runtime"]?.singleton !== true`,
        `  || __repackShared${index}["react/jsx-runtime"]?.import !== false`,
        `  || __repackShared${index}["react/jsx-dev-runtime"]?.singleton !== true`,
        `  || (__repackShared${index} as Readonly<Record<string, unknown>>)["react/compiler-runtime"] !== undefined`,
        `  || !Object.isFrozen(__repackShared${index})) {`,
        '  throw new Error("createReactNativeRepackSharedModules contract mismatch");',
        '}',
      ];
    case '@happier-dev/plugin-sdk/ui/build:createReactNativeWebVitePlugins':
      return [
        `const __vitePlugins${index} = ${reference}();`,
        `if (__vitePlugins${index}.length !== 1`,
        `  || __vitePlugins${index}[0].name !== "happier-plugin-ui-host-runtime-externals"`,
        `  || __vitePlugins${index}[0].resolveId("react") === null) {`,
        '  throw new Error("createReactNativeWebVitePlugins contract mismatch");',
        '}',
      ];
    case '@happier-dev/plugin-sdk/ui/build:definePluginUiBuildConfig':
      return [
        `const __uiBuildConfig${index} = ${reference}({`,
        '  targets: [{',
        '    rendererId: "packed-consumer",',
        '    entry: "src/main.ts",',
        '    kind: "hostedWeb",',
        '    platforms: ["web"],',
        '  }],',
        '});',
        `if (__uiBuildConfig${index}.targets[0]?.rendererId !== "packed-consumer") {`,
        '  throw new Error("definePluginUiBuildConfig contract mismatch");',
        '}',
      ];
    case '@happier-dev/plugin-sdk/ui/build:defineReactNativeWebViteBuildPreset':
      return [
        `const __rnWebPreset${index} = ${reference}({`,
        '  contributionId: "packed-consumer",',
        '  sourceEntry: "ui/surface.tsx",',
        '  viteVersion: "7.3.1",',
        '  hostUiApiVersion: "1.0.0",',
        '  compatibility: { reactVersion: "19.2.0", reactNativeVersion: "0.83.4" },',
        '});',
        `if (__rnWebPreset${index}.platform !== "web"`,
        `  || __rnWebPreset${index}.output.entry !== "react-native-web/packed-consumer/entry.mjs"`,
        `  || !Object.isFrozen(__rnWebPreset${index})) {`,
        '  throw new Error("defineReactNativeWebViteBuildPreset contract mismatch");',
        '}',
      ];
    case '@happier-dev/plugin-sdk/testing:createPluginTestkit':
      return [
        `const __testkit${index} = await ${reference}({`,
        '  manifest: {',
        '    schemaVersion: 2,',
        '    id: "com.example.packed-consumer",',
        '    version: "1.0.0",',
        '    displayName: "Packed consumer",',
        '    engines: { happier: "^0.2.0" },',
        '    runtime: { apiVersion: 1 },',
        '    activation: { events: [{ kind: "startup" }] },',
        '    hostAccess: { required: [], optional: [] },',
        '    contributes: {},',
        '  },',
        '  module: { activate() {} },',
        '});',
        `if (__testkit${index}.registrations().length !== 0) {`,
        '  throw new Error("createPluginTestkit registration contract mismatch");',
        '}',
        `await __testkit${index}.dispose();`,
      ];
    default:
      throw new Error(`Packed runtime export lacks a behavior consumer: ${contractKey}`);
  }
}

export function renderNormalSurfaceProbeSource(surface) {
  const importLines = [];
  const helperLines = [
    'type __IsAny<T> = 0 extends (1 & T) ? true : false;',
    'type __IsNever<T> = [T] extends [never] ? true : false;',
    'type __IsUnknown<T> = __IsAny<T> extends true',
    '  ? false',
    '  : unknown extends T ? ([keyof T] extends [never] ? true : false) : false;',
    'type __IsConcrete<T> = __IsAny<T> extends true',
    '  ? false',
    '  : __IsNever<T> extends true ? false : __IsUnknown<T> extends true ? false : true;',
    'type __Assert<T extends true> = T;',
  ];
  const contractTypes = [];
  const authoringContractLines = [];
  const runtimeBehaviorLines = [];
  let contractIndex = 0;
  for (const [entrypoint, symbols] of Object.entries(surface)) {
    const specifier = packageSpecifier(entrypoint);
    const typeSymbols = symbols
      .filter(({ runtime }) => !runtime)
      .sort((left, right) => left.name.localeCompare(right.name));
    const typeNames = typeSymbols.map(({ name }) => name);
    const runtimeNames = symbols.filter(({ runtime }) => runtime).map(({ name }) => name).sort();
    if (typeNames.length > 0) {
      importLines.push(`import type { ${typeNames.join(', ')} } from "${specifier}";`);
    }
    const runtimeNamespace = `runtime${contractIndex}`;
    if (runtimeNames.length > 0) {
      importLines.push(`import * as ${runtimeNamespace} from "${specifier}";`);
    }
    for (const { name, typeArguments = [] } of typeSymbols) {
      const typeReference = typeArguments.length > 0
        ? `${name}<${typeArguments.join(', ')}>`
        : name;
      contractTypes.push(`__Assert<__IsConcrete<${typeReference}>>`);
      if (
        entrypoint === './runtime'
        && name === 'PluginConnectedAccountAuthenticationModeRuntime'
      ) {
        authoringContractLines.push(
          'const __manualConnectedAccountAuthenticationMode = {',
          '  kind: "manual",',
          '  async complete() {',
          '    return {',
          '      status: "unavailable",',
          '      diagnostic: {',
          '        code: "packed_connected_account_mode_unavailable",',
          '        severity: "warning",',
          '        message: "Packed Connected Account authentication-mode authoring probe",',
          '      },',
          '    };',
          '  },',
          '} satisfies PluginConnectedAccountAuthenticationModeRuntime;',
          'void __manualConnectedAccountAuthenticationMode;',
        );
      }
      contractIndex += 1;
    }
    for (const name of runtimeNames) {
      contractTypes.push(`__Assert<__IsConcrete<typeof ${runtimeNamespace}.${name}>>`);
      runtimeBehaviorLines.push(
        ...renderRuntimeBehaviorConsumer(
          `${specifier}:${name}`,
          `${runtimeNamespace}.${name}`,
          contractIndex,
        ),
      );
      contractIndex += 1;
    }
  }
  return [
    ...importLines,
    '',
    ...helperLines,
    `type __NormalContracts = readonly [${contractTypes.join(', ')}];`,
    'const __typeContractWitness: __NormalContracts | null = null;',
    'void __typeContractWitness;',
    '',
    ...authoringContractLines,
    '',
    ...runtimeBehaviorLines,
    'console.log("normal-surface:contract-ok");',
    '',
  ].join('\n');
}

export function renderNegativeTypeProbeSource() {
  const lines = [];
  for (const [index, subpath] of REMOVED_PACKAGE_PATHS.entries()) {
    lines.push('// @ts-expect-error -- removed package path must remain unavailable');
    lines.push(
      `import type { RemovedPathSentinel${index} } from `
      + `${JSON.stringify(packageSpecifier(subpath))};`,
    );
  }
  for (const [entrypoint, name] of REMOVED_NORMAL_SYMBOL_IMPORTS) {
    lines.push('// @ts-expect-error -- retired or host-private symbol must remain unavailable');
    lines.push(`import type { ${name} } from ${JSON.stringify(packageSpecifier(entrypoint))};`);
  }
  lines.push('');
  return lines.join('\n');
}

function renderNegativeRuntimeProbeSource() {
  return [
    `const removedSpecifiers = ${JSON.stringify(REMOVED_PACKAGE_PATHS.map(packageSpecifier))};`,
    'for (const specifier of removedSpecifiers) {',
    '  try {',
    '    await import(specifier);',
    '    throw new Error(`removed package path loaded: ${specifier}`);',
    '  } catch (error) {',
    '    if (error instanceof Error && error.message.startsWith("removed package path loaded:")) throw error;',
    '    if (!error || error.code !== "ERR_PACKAGE_PATH_NOT_EXPORTED") throw error;',
    '  }',
    '}',
    'console.log(`negative-paths:${removedSpecifiers.length}`);',
    '',
  ].join('\n');
}

function renderProcessStatus(status) {
  if (status === null) return 'null';
  return Number.isInteger(status) && status >= 0 ? String(status) : 'unknown';
}

function renderProcessSignal(signal) {
  if (signal === null) return 'null';
  return typeof signal === 'string' && /^SIG[A-Z0-9]{1,24}$/u.test(signal)
    ? signal
    : 'unknown';
}

function renderSpawnErrorCode(error) {
  if (!error) return 'none';
  return typeof error.code === 'string' && /^[A-Z][A-Z0-9_]{0,31}$/u.test(error.code)
    ? error.code
    : 'present';
}

export function runCommand(command, args, options = {}) {
  const stage = String(options.stage ?? '');
  if (!/^[a-z][a-z0-9:-]{0,63}$/u.test(stage)) {
    throw new Error('Missing or invalid command stage');
  }
  const spawnSyncImpl = options.spawnSyncImpl ?? spawnSync;
  const env = {
    ...process.env,
    CI: '1',
    npm_config_audit: 'false',
    npm_config_cache: options.npmCacheDir ?? join(tmpdir(), 'happier-plugin-sdk-consumer-npm-cache'),
    npm_config_fund: 'false',
    ...options.env,
  };
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() === 'npm_config_ignore_scripts') delete env[key];
  }
  // Packing must exercise the SDK prepack. Install stages opt out explicitly via --ignore-scripts.
  env.npm_config_ignore_scripts = 'false';
  const invocation = /^(?:npm|npm\.cmd)$/iu.test(command)
    ? resolveNpmCommandInvocation(args, {
      platform: options.platform,
      npmExecPath: env.npm_execpath,
      processExecPath: options.processExecPath,
      comspec: options.comspec,
    })
    : { command, args };
  const result = spawnSyncImpl(invocation.command, invocation.args, {
    cwd: options.cwd ?? repoRoot,
    env,
    encoding: 'utf8',
    timeout: options.timeout ?? 120_000,
    ...(invocation.windowsVerbatimArguments
      ? { windowsVerbatimArguments: invocation.windowsVerbatimArguments }
      : {}),
  });
  if (result.status !== 0) {
    const renderedCommand = [command, ...args].join(' ');
    const errorCode = renderSpawnErrorCode(result.error);
    throw new Error([
      `Command failed at stage: ${stage}`,
      `command: ${renderedCommand}`,
      `cwd: ${options.cwd ?? repoRoot}`,
      `status: ${renderProcessStatus(result.status)}`,
      `signal: ${renderProcessSignal(result.signal)}`,
      `timedOut: ${errorCode === 'ETIMEDOUT' ? 'true' : 'false'}`,
      `error: ${errorCode}`,
      result.stdout ? `stdout:\n${result.stdout}` : '',
      result.stderr ? `stderr:\n${result.stderr}` : '',
    ].filter(Boolean).join('\n'));
  }
  return result;
}

export function runNodeNextTypecheck(consumerDir, options = {}) {
  const invocation = resolveTypeScriptCliInvocation({
    repoRoot,
    workspaceDir: consumerDir,
    processExecPath: process.execPath,
  });
  return runCommand(invocation.command, [...invocation.argsPrefix, '-p', 'tsconfig.json'], {
    cwd: consumerDir,
    stage: 'nodenext-typecheck',
    timeout: 120_000,
    spawnSyncImpl: options.spawnSyncImpl,
  });
}

export function buildNodeNextTsconfig() {
  return {
    compilerOptions: {
      target: 'ES2022',
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      strict: true,
      skipLibCheck: false,
      types: ['node'],
      rootDir: 'src',
      outDir: 'dist',
    },
    include: ['src/**/*.ts'],
  };
}

async function writeProjectFile(root, relativePath, contents) {
  const targetPath = join(root, relativePath);
  await mkdir(dirname(targetPath), { recursive: true });
  await writeFile(targetPath, contents, 'utf8');
}

async function packPluginSdk(workDir) {
  const packDir = join(workDir, 'pack');
  const npmCacheDir = join(workDir, 'npm-cache');
  await mkdir(packDir, { recursive: true });
  runCommand('npm', ['pack', '--silent', pluginSdkDir, '--pack-destination', packDir], {
    cwd: repoRoot,
    npmCacheDir,
    stage: 'npm-pack',
    timeout: 360_000,
  });
  const tarballs = (await readdir(packDir)).filter((entry) => entry.endsWith('.tgz'));
  if (tarballs.length !== 1) {
    throw new Error(`Expected one plugin-sdk tarball, found ${tarballs.length}`);
  }
  return join(packDir, tarballs[0]);
}

async function installConsumerDependency(consumerDir, tarballPath, consumerName) {
  runCommand('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', tarballPath], {
    cwd: consumerDir,
    npmCacheDir: join(consumerDir, '.npm-cache'),
    stage: `install-${consumerName}`,
    timeout: 180_000,
  });
}

async function runNodeNextConsumer(workDir, tarballPath) {
  const consumerDir = join(workDir, 'nodenext-consumer');
  await mkdir(consumerDir, { recursive: true });
  await writeProjectFile(consumerDir, 'package.json', JSON.stringify({
    private: true,
    type: 'module',
    dependencies: {},
    devDependencies: {},
  }, null, 2));
  await installConsumerDependency(consumerDir, tarballPath, 'nodenext');
  const installedSdkRoot = join(
    consumerDir,
    'node_modules',
    '@happier-dev',
    'plugin-sdk',
  );
  const { allowlist } = await readCanonicalNormalSurfaceContract();
  const classifiedSurface = await classifyPackedNormalSurface(installedSdkRoot, allowlist);
  await writeProjectFile(consumerDir, 'tsconfig.json', JSON.stringify(buildNodeNextTsconfig(), null, 2));
  await writeProjectFile(
    consumerDir,
    'src/index.ts',
    renderNormalSurfaceProbeSource(classifiedSurface),
  );
  await writeProjectFile(
    consumerDir,
    'src/negative.ts',
    renderNegativeTypeProbeSource(),
  );
  await writeProjectFile(
    consumerDir,
    'runtime-negative.mjs',
    renderNegativeRuntimeProbeSource(),
  );

  runNodeNextTypecheck(consumerDir);
  const runResult = runCommand(process.execPath, [join(consumerDir, 'dist', 'index.js')], {
    cwd: consumerDir,
    stage: 'nodenext-runtime',
    timeout: 30_000,
  });
  if (!runResult.stdout.includes('normal-surface:contract-ok')) {
    throw new Error(`Unexpected NodeNext consumer output: ${runResult.stdout}`);
  }
  const negativeResult = runCommand(process.execPath, [join(consumerDir, 'runtime-negative.mjs')], {
    cwd: consumerDir,
    stage: 'nodenext-negative-runtime',
    timeout: 30_000,
  });
  if (!negativeResult.stdout.includes(`negative-paths:${REMOVED_PACKAGE_PATHS.length}`)) {
    throw new Error(`Unexpected negative-path consumer output: ${negativeResult.stdout}`);
  }
  console.log('Normal surface type contracts compile and runtime behavior probes PASS');
  console.log(
    `Negative surface ${REMOVED_PACKAGE_PATHS.length} removed paths and `
    + `${REMOVED_NORMAL_SYMBOL_IMPORTS.length} retired/host-private symbols PASS`,
  );
  console.log('NodeNext consumer PASS');
}

async function runViteConsumer(workDir, tarballPath) {
  const consumerDir = join(workDir, 'vite-consumer');
  await mkdir(consumerDir, { recursive: true });
  await writeProjectFile(consumerDir, 'package.json', JSON.stringify({
    private: true,
    type: 'module',
    dependencies: {},
    devDependencies: {},
  }, null, 2));
  await installConsumerDependency(consumerDir, tarballPath, 'vite');
  await writeProjectFile(consumerDir, 'vite.config.mjs', [
    'import { definePluginUiBuildConfig } from "@happier-dev/plugin-sdk/ui/build";',
    '',
    'const pluginUi = definePluginUiBuildConfig({',
    '  targets: [{',
    '    rendererId: "consumer-vite",',
    '    entry: "src/main.ts",',
    '    kind: "hostedWeb",',
    '    platforms: ["web"],',
    '  }],',
    '});',
    '',
    'export default {',
    '  build: {',
    '    emptyOutDir: true,',
    '    minify: false,',
    '    outDir: "dist",',
    '    lib: {',
    '      entry: pluginUi.targets[0].entry,',
    '      formats: ["es"],',
    '      fileName: "index",',
    '    },',
    '  },',
    '};',
    '',
  ].join('\n'));
  await writeProjectFile(consumerDir, 'src/main.ts', [
    'import type { PluginUiRenderSurface } from "@happier-dev/plugin-sdk/ui";',
    'import { createPluginUiHostApiClient } from "@happier-dev/plugin-sdk/ui/client";',
    '',
    'const renderSurface: PluginUiRenderSurface = () => null;',
    'console.log(`vite:${typeof createPluginUiHostApiClient}:${typeof renderSurface}`);',
    '',
  ].join('\n'));

  runCommand(process.execPath, [join(rootNodeModules, 'vite', 'bin', 'vite.js'), 'build', '--config', 'vite.config.mjs'], {
    cwd: consumerDir,
    stage: 'vite-build',
    timeout: 120_000,
  });
  const distEntries = await readdir(join(consumerDir, 'dist'));
  const outputFile = distEntries.find((entry) => /^index\.(?:mjs|js)$/u.test(entry));
  if (!outputFile) {
    throw new Error(`Expected Vite output file dist/index.{mjs,js}; found: ${distEntries.join(', ')}`);
  }
  const runResult = runCommand(process.execPath, [join(consumerDir, 'dist', outputFile)], {
    cwd: consumerDir,
    stage: 'vite-runtime',
    timeout: 30_000,
  });
  if (!runResult.stdout.includes('vite:function:function')) {
    throw new Error(`Unexpected Vite consumer output: ${runResult.stdout}`);
  }
  console.log('Vite consumer PASS');
}

export async function runProbes() {
  const workDir = await mkdtemp(join(tmpdir(), 'happier-plugin-sdk-consumers-'));
  assertOutOfWorkspace(workDir);
  try {
    const tarballPath = suppliedTarballPath ?? await packPluginSdk(workDir);
    if (requestedConsumers.has('nodenext')) {
      await runNodeNextConsumer(workDir, tarballPath);
    }
    if (requestedConsumers.has('vite')) {
      await runViteConsumer(workDir, tarballPath);
    }
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

const invokedAsMain = process.argv[1]
  ? resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;

if (invokedAsMain) {
  await runProbes();
}
