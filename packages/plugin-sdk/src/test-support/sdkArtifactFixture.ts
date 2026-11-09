import { access, cp, mkdir, readFile, symlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = fileURLToPath(new URL('../..', import.meta.url));
const pluginUiPackageRoot = join(packageRoot, '..', 'plugin-ui');
type InstalledPackageJson = Readonly<{ dependencies?: Readonly<Record<string, string>> }>;

export async function requireBuiltSdkArtifact(path: string, description: string): Promise<void> {
    try {
        await access(path);
    } catch {
        throw new Error(`Real built Plugin SDK closure is missing ${description}: ${path}`);
    }
}

async function readSdkBundledDependencyNames(): Promise<readonly string[]> {
    const packageJson = JSON.parse(
        await readFile(join(packageRoot, 'package.json'), 'utf8'),
    ) as Readonly<{ bundledDependencies?: readonly string[] }>;
    const bundled = packageJson.bundledDependencies ?? [];
    if (bundled.length === 0) {
        throw new Error('Real built Plugin SDK closure declares no bundledDependencies');
    }
    return bundled;
}

export async function copyBuiltSdkArtifact(targetRoot: string): Promise<void> {
    await Promise.all([
        requireBuiltSdkArtifact(join(packageRoot, 'package.json'), 'package.json'),
        requireBuiltSdkArtifact(join(packageRoot, 'dist'), 'dist'),
    ]);
    await mkdir(dirname(targetRoot), { recursive: true });
    await cp(join(packageRoot, 'package.json'), join(targetRoot, 'package.json'), { force: true });
    await cp(join(packageRoot, 'dist'), join(targetRoot, 'dist'), { force: true, recursive: true });
    // `bundledDependencies` ship inside the SDK tarball, so npm unpacks them
    // under the installed SDK and never at the author's own root. Nesting them
    // the same way here is what makes this fixture able to observe the author's
    // real inference surface: a declaration the SDK reaches through a bundled
    // package is unnameable from the author's package, and TypeScript stops the
    // author's declaration build with TS2883 instead of emitting a specifier
    // their own consumers cannot resolve. Hoisting them to the shared closure
    // silently makes every such reference resolvable and hides the defect.
    await linkInstalledPackages(targetRoot, packageRoot, await readSdkBundledDependencyNames());
}

export async function copyBuiltPluginUiArtifact(targetRoot: string): Promise<void> {
    await Promise.all([
        requireBuiltSdkArtifact(join(pluginUiPackageRoot, 'package.json'), 'Plugin UI package.json'),
        requireBuiltSdkArtifact(join(pluginUiPackageRoot, 'dist'), 'Plugin UI dist'),
    ]);
    await mkdir(dirname(targetRoot), { recursive: true });
    await cp(join(pluginUiPackageRoot, 'package.json'), join(targetRoot, 'package.json'), { force: true });
    await cp(join(pluginUiPackageRoot, 'dist'), join(targetRoot, 'dist'), { force: true, recursive: true });
}

function packagePathParts(packageName: string): readonly string[] {
    const parts = packageName.split('/');
    if (packageName.startsWith('@') ? parts.length !== 2 : parts.length !== 1) {
        throw new Error(`Unsupported package name in real built Plugin SDK closure: ${packageName}`);
    }
    return parts;
}

async function findInstalledDependencyRoot(sourcePackageRoot: string, packageName: string): Promise<string> {
    const packageParts = packagePathParts(packageName);
    let lookupRoot = sourcePackageRoot;
    while (true) {
        const candidate = join(lookupRoot, 'node_modules', ...packageParts);
        try {
            await access(join(candidate, 'package.json'));
            return candidate;
        } catch {
            const parent = dirname(lookupRoot);
            if (parent === lookupRoot) {
                throw new Error(
                    `Real built Plugin SDK closure cannot resolve ${packageName} from ${sourcePackageRoot}`,
                );
            }
            lookupRoot = parent;
        }
    }
}

export async function linkBuiltRuntimeDependencyClosure(
    closureRoot: string,
    sourcePackageRoot: string,
): Promise<void> {
    const packageJson = JSON.parse(
        await readFile(join(sourcePackageRoot, 'package.json'), 'utf8'),
    ) as InstalledPackageJson;
    // Only the SDK itself needs two independent physical package roots. Link
    // its direct, installed dependencies instead of recursively dereferencing
    // every workspace package and its transient build directories. Node then
    // resolves each package's own real closure from its installed location.
    //
    // `bundledDependencies` are deliberately excluded: npm unpacks those inside
    // the installed SDK, not at the author's root, and `copyBuiltSdkArtifact`
    // nests them there. Hoisting them here would make Protocol resolvable from
    // the author's own package and defeat the portability assertions below.
    const bundledDependencyNames = new Set(await readSdkBundledDependencyNames());
    const hoistedDependencyNames = Object.keys(packageJson.dependencies ?? {})
        .filter((packageName) => !bundledDependencyNames.has(packageName));
    await Promise.all(hoistedDependencyNames.sort().map(async (packageName) => {
        const sourceDependencyRoot = await findInstalledDependencyRoot(sourcePackageRoot, packageName);
        const targetDependencyRoot = join(closureRoot, 'node_modules', ...packagePathParts(packageName));
        await mkdir(dirname(targetDependencyRoot), { recursive: true });
        await symlink(
            sourceDependencyRoot,
            targetDependencyRoot,
            process.platform === 'win32' ? 'junction' : 'dir',
        );
    }));
}

export async function linkInstalledPackages(
    closureRoot: string,
    sourcePackageRoot: string,
    packageNames: readonly string[],
): Promise<void> {
    await Promise.all(packageNames.map(async (packageName) => {
        const sourceDependencyRoot = await findInstalledDependencyRoot(sourcePackageRoot, packageName);
        const targetDependencyRoot = join(closureRoot, 'node_modules', ...packagePathParts(packageName));
        await mkdir(dirname(targetDependencyRoot), { recursive: true });
        await symlink(
            sourceDependencyRoot,
            targetDependencyRoot,
            process.platform === 'win32' ? 'junction' : 'dir',
        );
    }));
}

