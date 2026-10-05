import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { dirname, join, relative } from 'node:path';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve as resolveMetro, type ResolutionContext } from 'metro-resolver';
import ts from 'typescript';

const uiDir = fileURLToPath(new URL('../../..', import.meta.url));
const require = createRequire(import.meta.url);
const config = require(join(uiDir, 'metro.config.js'));
const hostPath = join(uiDir, 'sources/voice/registry/bundledConversationRuntimeHost.ts');

function runtimeDependencies(filePath: string): string[] {
  const source = ts.createSourceFile(filePath, readFileSync(filePath, 'utf8'), ts.ScriptTarget.Latest, true);
  const dependencies = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && !node.importClause?.isTypeOnly && ts.isStringLiteral(node.moduleSpecifier)) {
      dependencies.add(node.moduleSpecifier.text);
    } else if (ts.isExportDeclaration(node) && !node.isTypeOnly && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      dependencies.add(node.moduleSpecifier.text);
    } else if (ts.isCallExpression(node)
      && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
      && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) {
      dependencies.add(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return [...dependencies];
}

function resolveDependency(originModulePath: string, specifier: string, platform: string): string {
  const context: ResolutionContext = {
    ...config.resolver,
    allowHaste: false,
    assetExts: new Set(config.resolver.assetExts),
    customResolverOptions: Object.create(null),
    dev: true,
    mainFields: config.resolver.resolverMainFields,
    nodeModulesPaths: config.resolver.nodeModulesPaths ?? [],
    originModulePath,
    preferNativePlatform: platform !== 'web',
    resolveRequest: resolveMetro,
    doesFileExist: existsSync,
    fileSystemLookup(filePath) {
      if (!existsSync(filePath)) return { exists: false };
      return { exists: true, type: statSync(filePath).isDirectory() ? 'd' : 'f', realPath: realpathSync(filePath) };
    },
    getPackage(filePath) {
      return existsSync(filePath) ? JSON.parse(readFileSync(filePath, 'utf8')) : null;
    },
    getPackageForModule(filePath) {
      for (let dir = dirname(filePath); dirname(dir) !== dir; dir = dirname(dir)) {
        const manifest = join(dir, 'package.json');
        if (existsSync(manifest)) return { rootPath: dir, packageRelativePath: relative(dir, filePath), packageJson: JSON.parse(readFileSync(manifest, 'utf8')) };
        if (dir.endsWith('node_modules')) break;
      }
      return null;
    },
    resolveAsset: () => null,
    resolveHasteModule: () => null,
    resolveHastePackage: () => null,
    redirectModulePath: (modulePath) => modulePath,
    unstable_logWarning: (message) => { throw new Error(message); },
  };
  // Babel's module-resolver rewrites the app alias before Metro resolves it.
  const metroSpecifier = specifier.startsWith('@/')
    ? join(uiDir, 'sources', specifier.slice(2))
    : specifier;
  const result = config.resolver.resolveRequest(context, metroSpecifier, platform);
  if (result.type !== 'sourceFile') throw new Error(`Expected source resolution for ${specifier}`);
  return result.filePath;
}

function bootstrapPackages(platform: string): Set<string> {
  // Resolve the real host's bootstrap import with the app's Metro config, then
  // traverse its local runtime graph. Packages are the external boundary here.
  const bootstrapImport = runtimeDependencies(hostPath).find((specifier) => specifier.endsWith('/nativeWebRtcRuntime'));
  if (!bootstrapImport) throw new Error('Host bootstrap import missing');
  const pending = [resolveDependency(hostPath, bootstrapImport, platform)];
  const visited = new Set<string>();
  const packages = new Set<string>();
  while (pending.length) {
    const filePath = pending.pop()!;
    if (visited.has(filePath)) continue;
    visited.add(filePath);
    for (const specifier of runtimeDependencies(filePath)) {
      if (specifier.startsWith('.') || specifier.startsWith('@/')) {
        pending.push(resolveDependency(filePath, specifier, platform));
      } else {
        packages.add(specifier);
      }
    }
  }
  return packages;
}

describe('Voice WebRTC Metro platform graph', () => {
  it('keeps native LiveKit out of the web host bootstrap graph', () => {
    expect([...bootstrapPackages('web')].filter((name) => name.startsWith('@livekit/'))).toEqual([]);
  });

  it.each(['ios', 'android'])('retains both native LiveKit boundaries on %s', (platform) => {
    expect(bootstrapPackages(platform)).toEqual(new Set([
      'react-native', '@livekit/react-native', '@livekit/react-native-webrtc',
    ]));
  });

  it('retains the browser peer-connection and microphone paths', () => {
    const connection = resolveDependency(hostPath, '@/voice/runtime/connection/createHostWebRtcConnection', 'web');
    expect(runtimeDependencies(connection)).toContain('./VoiceRealtimeConnection');
    const microphone = resolveDependency(hostPath, '@/voice/runtime/mic/createRealtimeMicSession', 'web');
    const liveMic = resolveDependency(microphone, './createLiveMicSession', 'web');
    expect(runtimeDependencies(liveMic)).toContain('./WebMicSession.web');
  });
});
