const { execFile } = require('node:child_process');
const { createPrivateKey, createPublicKey, sign } = require('node:crypto');
const { mkdir, readFile, rm, writeFile } = require('node:fs/promises');
const path = require('node:path');
const { createRequire } = require('node:module');
const { promisify } = require('node:util');
const { withDangerousMod: expoWithDangerousMod } = require('@expo/config-plugins');

const execFileAsync = promisify(execFile);
const appConfigRequire = createRequire(__filename);
const BUILD_IDENTITY_FILENAME = 'happier-terminal-native-build-identity.json';

function canonicalJson(value) {
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
    if (value && typeof value === 'object') {
        return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
    }
    return JSON.stringify(value);
}

function resolveTerminalNativePackageRoot(projectRoot, requireResolve = appConfigRequire.resolve) {
    return path.dirname(requireResolve('@happier-dev/terminal-native/package.json', { paths: [projectRoot] }));
}

function resolveTerminalNativeBuildInputMaterializer({
    projectRoot,
    platform,
    nodePath = process.execPath,
    requireResolve = appConfigRequire.resolve,
}) {
    const terminalNativePackageRoot = resolveTerminalNativePackageRoot(projectRoot, requireResolve);
    return {
        command: nodePath,
        args: [
            path.join(terminalNativePackageRoot, 'scripts', 'materializeNativeBuildInputs.mjs'),
            '--platform',
            platform,
        ],
    };
}

async function materializeTerminalNativeBuildIdentity({
    projectRoot,
    platform,
    config,
    buildIdentity,
    env = process.env,
    now = () => new Date(),
    requireResolve = appConfigRequire.resolve,
}) {
    const packageRoot = resolveTerminalNativePackageRoot(projectRoot, requireResolve);
    const outputPath = platform === 'ios'
        ? path.join(packageRoot, 'ios', 'Resources', BUILD_IDENTITY_FILENAME)
        : path.join(packageRoot, 'android', 'src', 'main', 'assets', BUILD_IDENTITY_FILENAME);
    if (!buildIdentity) {
        await rm(outputPath, { force: true });
        return { status: 'not-materialized', outputPath };
    }
    const authorityId = String(env.HAPPIER_TERMINAL_NATIVE_CAPTURE_AUTHORITY_ID ?? '').trim();
    const privateKeyPath = String(env.HAPPIER_TERMINAL_NATIVE_CAPTURE_PRIVATE_KEY_PATH ?? '').trim();
    if (!authorityId || !privateKeyPath) {
        throw new Error('TERM evidence builds require HAPPIER_TERMINAL_NATIVE_CAPTURE_AUTHORITY_ID and HAPPIER_TERMINAL_NATIVE_CAPTURE_PRIVATE_KEY_PATH');
    }
    const applicationId = platform === 'ios' ? config.ios?.bundleIdentifier : config.android?.package;
    const buildNumber = platform === 'ios' ? config.ios?.buildNumber : config.android?.versionCode;
    if (!applicationId || buildNumber === undefined || !config.version) {
        throw new Error(`TERM ${platform} build identity requires application id, version, and build number`);
    }
    const materializationTime = now();
    const unsigned = {
        schemaVersion: 1,
        kind: 'terminal-native-build-identity',
        authorityId,
        platform,
        rendererId: platform === 'ios' ? 'ios-ghosttykit' : 'android-termux',
        buildEvidenceId: buildIdentity.buildEvidenceId,
        applicationId,
        version: String(config.version),
        buildNumber: String(buildNumber),
        sourceStateSha256: buildIdentity.sourceStateSha256,
        dependencyClosureSha256: buildIdentity.dependencyClosureSha256,
        generatedAt: String(env.HAPPIER_TERMINAL_NATIVE_BUILD_IDENTITY_GENERATED_AT ?? materializationTime.toISOString()),
        signatureAlgorithm: 'ed25519',
    };
    const privateKey = createPrivateKey(await readFile(path.resolve(privateKeyPath), 'utf8'));
    const capturePolicy = JSON.parse(await readFile(
        path.join(packageRoot, 'device-evidence-capture-authorities.json'),
        'utf8',
    ));
    const authority = capturePolicy?.schemaVersion === 2 && Array.isArray(capturePolicy.authorities)
        ? capturePolicy.authorities.find((candidate) => candidate?.id === authorityId)
        : null;
    const scope = Array.isArray(authority?.scopes)
        ? authority.scopes.find((candidate) => candidate?.rendererId === unsigned.rendererId)
        : null;
    if (!authority || !scope || !Array.isArray(scope.allowedBuildIds)
        || !scope.allowedBuildIds.includes(unsigned.buildEvidenceId)) {
        throw new Error(`TERM capture authority ${authorityId} is not registered for ${unsigned.rendererId} build ${unsigned.buildEvidenceId}`);
    }
    const generatedAt = Date.parse(unsigned.generatedAt);
    const materializedAt = materializationTime.getTime();
    const validFrom = Date.parse(String(authority.validFrom ?? ''));
    const validUntil = Date.parse(String(authority.validUntil ?? ''));
    if (![generatedAt, materializedAt, validFrom, validUntil].every(Number.isFinite)
        || validFrom > validUntil
        || generatedAt < validFrom || generatedAt > validUntil
        || materializedAt < validFrom || materializedAt > validUntil) {
        throw new Error(`TERM build identity generatedAt ${unsigned.generatedAt} is outside capture authority ${authorityId} validity window`);
    }
    const derivedPublicKey = createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }).toString().trim();
    if (derivedPublicKey !== String(authority.publicKeyPem ?? '').trim()) {
        throw new Error(`TERM capture private key does not match registered authority ${authorityId}`);
    }
    const signature = sign(null, Buffer.from(canonicalJson(unsigned)), privateKey).toString('base64');
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${canonicalJson({ ...unsigned, signature })}\n`, 'utf8');
    return { status: 'materialized', outputPath, manifest: { ...unsigned, signature } };
}

async function materializeTerminalNativeBuildInputs({
    projectRoot,
    platform,
    execFileAsync: run = execFileAsync,
    resolveMaterializer = resolveTerminalNativeBuildInputMaterializer,
}) {
    const invocation = resolveMaterializer({ projectRoot, platform });
    await run(invocation.command, invocation.args, {
        cwd: projectRoot,
        env: process.env,
        maxBuffer: 1024 * 1024,
    });
}

function withTerminalNativeBuildInputs(config, options = {}) {
    const withDangerousMod = options.withDangerousMod ?? expoWithDangerousMod;
    const materialize = options.materialize ?? materializeTerminalNativeBuildInputs;
    const materializeIdentity = options.materializeIdentity ?? materializeTerminalNativeBuildIdentity;
    let nextConfig = config;

    for (const platform of ['ios', 'android']) {
        nextConfig = withDangerousMod(nextConfig, [platform, async (modConfig) => {
            if (modConfig?.modRequest?.introspect) return modConfig;
            await materialize({
                platform,
                projectRoot: modConfig?.modRequest?.projectRoot ?? process.cwd(),
            });
            await materializeIdentity({
                platform,
                projectRoot: modConfig?.modRequest?.projectRoot ?? process.cwd(),
                config: modConfig,
                buildIdentity: options.buildIdentity ?? null,
            });
            return modConfig;
        }]);
    }
    return nextConfig;
}

withTerminalNativeBuildInputs.resolveTerminalNativeBuildInputMaterializer = resolveTerminalNativeBuildInputMaterializer;
withTerminalNativeBuildInputs.materializeTerminalNativeBuildInputs = materializeTerminalNativeBuildInputs;
withTerminalNativeBuildInputs.materializeTerminalNativeBuildIdentity = materializeTerminalNativeBuildIdentity;
withTerminalNativeBuildInputs.resolveTerminalNativePackageRoot = resolveTerminalNativePackageRoot;
withTerminalNativeBuildInputs.canonicalJson = canonicalJson;

module.exports = withTerminalNativeBuildInputs;
