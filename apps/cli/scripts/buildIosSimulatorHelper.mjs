#!/usr/bin/env node
// buildIosSimulatorHelper.mjs
//
// Build + sign + notarize + staple + vendor pipeline for the first-party
// `happier-ios-simulator-helper` binary used by the iOS simulator device-preview adapter.
//
// This is the PRODUCER of the external signed/notarized artifact the daemon resolver verifies. It
// is intentionally fail-loud: it refuses to vendor (and refuses to pin a non-placeholder digest)
// unless a real Developer ID identity signed the binary AND notarization succeeded. There is no
// "pass when codesign/notarytool unavailable" path — absence is a hard error, which preserves the
// runtime fail-closed posture (the resolver keeps returning helper_artifact_missing).
//
// Usage:
//   node apps/cli/scripts/buildIosSimulatorHelper.mjs \
//     --version <semver> \
//     --signing-identity "Developer ID Application: ... (TEAMID)" \
//     --notary-profile <notarytool-keychain-profile> \
//     [--skip-notarize]   (DEV ONLY: produces a development-build, never vendored as production)
//
// On success it writes:
//   apps/cli/assets/ios/simulator-helper/happier-ios-simulator-helper        (signed+notarized+stapled)
//   apps/cli/assets/ios/simulator-helper/happier-ios-simulator-helper.json   (version sidecar)
//   apps/cli/assets/ios/simulator-helper/manifest.json                       (version/sha256/status/evidence)
//
// and prints the real version + sha256 so PINNED_IOS_SIMULATOR_HELPER_ARTIFACT can be updated.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = join(SCRIPT_DIR, '..');
const NATIVE_PKG_DIR = join(CLI_ROOT, 'native', 'simulator', 'ios-helper');
const ASSET_DIR = join(CLI_ROOT, 'assets', 'ios', 'simulator-helper');
const ARTIFACT_NAME = 'happier-ios-simulator-helper';
const ARTIFACT_PATH = join(ASSET_DIR, ARTIFACT_NAME);
const SIDECAR_PATH = `${ARTIFACT_PATH}.json`;
const MANIFEST_PATH = join(ASSET_DIR, 'manifest.json');

function fail(message) {
    console.error(`[buildIosSimulatorHelper] ${message}`);
    process.exit(1);
}

function parseArgs(argv) {
    const args = { skipNotarize: false };
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        if (arg === '--version') args.version = argv[++i];
        else if (arg === '--signing-identity') args.signingIdentity = argv[++i];
        else if (arg === '--notary-profile') args.notaryProfile = argv[++i];
        else if (arg === '--skip-notarize') args.skipNotarize = true;
        else fail(`unknown argument: ${arg}`);
    }
    return args;
}

function run(command, commandArgs, options = {}) {
    return execFileSync(command, commandArgs, {
        stdio: ['ignore', 'pipe', 'inherit'],
        encoding: 'utf8',
        ...options,
    });
}

function main() {
    if (process.platform !== 'darwin') {
        fail('iOS simulator helper can only be built/signed/notarized on macOS.');
    }

    const args = parseArgs(process.argv.slice(2));
    if (!args.version || args.version === '0.0.0-unavailable') {
        fail('a real --version (semver) is required; refusing to pin the placeholder version.');
    }
    if (!args.signingIdentity) {
        fail('a Developer ID --signing-identity is required; refusing to vendor an unsigned helper.');
    }
    if (!args.skipNotarize && !args.notaryProfile) {
        fail('a --notary-profile is required for notarization (or pass --skip-notarize for a non-vendorable dev build).');
    }

    // 1. Build the universal release binary via SwiftPM.
    console.error('[buildIosSimulatorHelper] building release binary (arm64 + x86_64)...');
    run('swift', ['build', '-c', 'release', '--arch', 'arm64', '--arch', 'x86_64'], {
        cwd: NATIVE_PKG_DIR,
        env: { ...process.env, HAPPIER_IOS_HELPER_VERSION: args.version },
    });
    const binPath = run('swift', ['build', '-c', 'release', '--arch', 'arm64', '--arch', 'x86_64', '--show-bin-path'], {
        cwd: NATIVE_PKG_DIR,
    }).trim();
    const builtBinary = join(binPath, ARTIFACT_NAME);

    mkdirSync(ASSET_DIR, { recursive: true });
    copyFileSync(builtBinary, ARTIFACT_PATH);

    // 2. Sign with hardened runtime + secure timestamp.
    console.error('[buildIosSimulatorHelper] codesigning...');
    run('codesign', [
        '--force', '--timestamp', '--options', 'runtime',
        '--sign', args.signingIdentity, ARTIFACT_PATH,
    ]);
    run('codesign', ['--verify', '--strict', '--deep', ARTIFACT_PATH]);

    // 3. Notarize + staple (skipped only for explicit dev builds — never production-vendored).
    let notarizationSubmissionId = null;
    let helperDistribution = 'development-build';
    if (!args.skipNotarize) {
        console.error('[buildIosSimulatorHelper] notarizing (this can take several minutes)...');
        const zipPath = `${ARTIFACT_PATH}.zip`;
        run('ditto', ['-c', '-k', '--keepParent', ARTIFACT_PATH, zipPath]);
        const submitOutput = run('xcrun', [
            'notarytool', 'submit', zipPath,
            '--keychain-profile', args.notaryProfile,
            '--wait', '--output-format', 'json',
        ]);
        try {
            const parsed = JSON.parse(submitOutput);
            notarizationSubmissionId = parsed.id ?? null;
            if (parsed.status !== 'Accepted') {
                fail(`notarization not accepted: status=${parsed.status} id=${parsed.id}`);
            }
        } catch (error) {
            fail(`could not parse notarytool output: ${error instanceof Error ? error.message : String(error)}`);
        }
        run('xcrun', ['stapler', 'staple', ARTIFACT_PATH]);
        run('xcrun', ['stapler', 'validate', ARTIFACT_PATH]);
        run('spctl', ['--assess', '--type', 'execute', '--verbose=2', ARTIFACT_PATH]);
        helperDistribution = 'prebuilt-signed';
    }

    // 4. Compute digest + write sidecar + manifest evidence.
    const bytes = readFileSync(ARTIFACT_PATH);
    const sha256 = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

    writeFileSync(SIDECAR_PATH, `${JSON.stringify({ version: args.version, digest: sha256 }, null, 2)}\n`);

    const status = helperDistribution === 'prebuilt-signed'
        ? 'pinned_signed_notarized_helper'
        : 'blocked_missing_signed_notarized_helper';
    const manifest = {
        artifact: ARTIFACT_NAME,
        status,
        signature: 'developer_id_notarized_required',
        helperDistribution,
        version: args.version,
        sha256: helperDistribution === 'prebuilt-signed' ? sha256 : null,
        evidence: {
            signingIdentity: args.signingIdentity,
            notarizationSubmissionId,
            stapled: helperDistribution === 'prebuilt-signed',
            builtAt: new Date().toISOString(),
        },
    };
    writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`);

    console.error('[buildIosSimulatorHelper] done.');
    console.error(`  version: ${args.version}`);
    console.error(`  sha256:  ${sha256}`);
    console.error(`  status:  ${status}`);
    if (helperDistribution === 'prebuilt-signed') {
        // No source edit required: the daemon pin (PINNED_IOS_SIMULATOR_HELPER_ARTIFACT in
        // apps/cli/src/daemon/devices/simulator/ios/discovery.ts) is derived from this manifest.json
        // via resolveIosSimulatorHelperPin(). The version + sha256 just written become the
        // launch-time pin automatically; the resolver re-hashes the bytes on disk and verifies they
        // match before the helper is ever launched.
        console.error('  manifest.json updated — the daemon pin is derived from it automatically.');
        console.error('  Run the iOS argent QA gate on a booted simulator before relying on the flip.');
    } else {
        console.error('  Development build only — NOT vendorable as production (manifest stays blocked).');
    }
}

main();
