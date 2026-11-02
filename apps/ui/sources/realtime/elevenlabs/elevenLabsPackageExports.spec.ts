import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
// Metro publishes this resolver as an untyped CommonJS boundary.
const { resolvePackageTargetFromExports } = require('metro-resolver/private/PackageExportsResolve') as {
    resolvePackageTargetFromExports: (...args: unknown[]) => { filePath: string };
};

function resolveSdkEntry(packageName: string, platform: string) {
    const packageRoot = dirname(dirname(require.resolve(packageName)));
    const metadata = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
    return resolvePackageTargetFromExports({
        assetExts: new Set(),
        isESMImport: true,
        unstable_conditionNames: ['react-native'],
        unstable_conditionsByPlatform: { web: ['browser'] },
        fileSystemLookup: (filePath: string) => existsSync(filePath)
            ? { exists: true, type: statSync(filePath).isDirectory() ? 'd' : 'f', realPath: realpathSync(filePath) }
            : { exists: false },
    }, packageRoot, packageName, '', metadata.exports, platform).filePath;
}

describe('ElevenLabs platform package entry points', () => {
    it.each(['ios', 'android'])('registers the native setup strategy on %s', (platform) => {
        expect(resolveSdkEntry('@elevenlabs/react-native', platform))
            .toMatch(/[/\\]dist[/\\]index\.react-native\.js$/);
    });

    it('registers browser audio on web', () => {
        expect(resolveSdkEntry('@elevenlabs/client', 'web'))
            .toMatch(/[/\\]dist[/\\]platform[/\\]web[/\\]index\.js$/);
    });
});
