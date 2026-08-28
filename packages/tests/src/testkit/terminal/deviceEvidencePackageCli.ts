import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { inspectTerminalNativeAppPackage } from './deviceEvidenceAppPackage';
import { terminalEvidenceCanonicalJson } from './deviceEvidenceCanonical';

type Run = (command: string, args: readonly string[]) => string;

const sha256File = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex');

function option(args: readonly string[], name: string): string | null {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] ?? null : null;
}

function defaultRun(command: string, args: readonly string[]): string {
  const result = spawnSync(command, [...args], {
    encoding: 'utf8',
    timeout: 120_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited ${String(result.status)}: ${String(result.stderr).trim()}`);
  return `${String(result.stdout)}\n${String(result.stderr)}`;
}

function sortedUnique(values: readonly string[]): readonly string[] {
  return [...new Set(values.filter(Boolean))].sort();
}

export function inspectAndroidPackageWithBuildTools(input: Readonly<{
  binaryPath: string;
  aapt2Path: string;
  apksignerPath: string;
  run?: Run;
}>): Readonly<Record<string, unknown>> {
  const run = input.run ?? defaultRun;
  const direct = inspectTerminalNativeAppPackage(input.binaryPath, 'android');
  const badging = run(input.aapt2Path, ['dump', 'badging', input.binaryPath]);
  const packageLine = badging.split('\n').find((line) => line.startsWith('package:')) ?? '';
  const field = (name: string): string => new RegExp(`${name}='([^']*)'`).exec(packageLine)?.[1] ?? '';
  if (field('name') !== direct.applicationId || field('versionName') !== direct.version
    || field('versionCode') !== direct.buildNumber) {
    throw new Error('aapt2 package metadata does not match the directly parsed Android manifest');
  }
  const verification = run(input.apksignerPath, ['verify', '--verbose', '--print-certs', input.binaryPath]);
  if (!/^Verifies\s*$/m.test(verification)) throw new Error('apksigner did not verify the retained APK');
  const signatureSchemes = sortedUnique([...verification.matchAll(/Verified using v(\d(?:\.\d+)?) scheme[^:]*:\s*true/g)]
    .map((match) => `v${match[1]}`));
  const signerCertificateSha256 = sortedUnique([...verification.matchAll(/certificate SHA-256 digest:\s*([a-fA-F0-9]{64})/g)]
    .map((match) => match[1]!.toLowerCase()));
  if (signatureSchemes.length === 0 || signerCertificateSha256.length === 0) {
    throw new Error('apksigner output is missing a verified scheme or signer certificate SHA-256');
  }
  return {
    binarySha256: sha256File(input.binaryPath), format: direct.format,
    applicationId: direct.applicationId, version: direct.version, buildNumber: direct.buildNumber,
    architectures: direct.architectures, metadataSha256: direct.metadataSha256,
    signatureVerified: true, signatureSchemes, signerCertificateSha256,
    inspector: 'android-build-tools/apksigner+aapt2', dexFileCount: direct.dexFileCount,
    nativeLibraryCount: direct.nativeLibraryCount, resourcesPresent: direct.resourcesPresent,
  };
}

export function inspectIosPackageWithXcodeTools(input: Readonly<{
  binaryPath: string;
  signingMode: 'simulator-unsigned' | 'simulator-adhoc' | 'device-development' | 'device-distribution' | 'app-store-export';
  run?: Run;
}>): Readonly<Record<string, unknown>> {
  const run = input.run ?? defaultRun;
  const direct = inspectTerminalNativeAppPackage(input.binaryPath, 'ios');
  if (input.signingMode.startsWith('simulator-') !== (direct.format === 'ios-simulator-app-archive')) {
    throw new Error('iOS signing mode does not match simulator app archive versus device IPA format');
  }
  const root = mkdtempSync(join(tmpdir(), 'term-ios-package-inspection-'));
  try {
    run('unzip', ['-qq', input.binaryPath, '-d', root]);
    const appRoot = direct.identityEntry.slice(0, -'happier-terminal-native-build-identity.json'.length);
    const appPath = resolve(root, appRoot);
    run('plutil', ['-lint', join(appPath, 'Info.plist')]);
    const architectures = sortedUnique(run('lipo', ['-archs', join(appPath, direct.executable!)]).trim().split(/\s+/));
    if (terminalEvidenceCanonicalJson(architectures) !== terminalEvidenceCanonicalJson(direct.architectures)) {
      throw new Error('lipo architecture output does not match the directly parsed Mach-O executable');
    }
    const unsigned = input.signingMode === 'simulator-unsigned';
    const display = unsigned ? '' : (() => {
      run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath]);
      return run('codesign', ['-d', '--verbose=4', appPath]);
    })();
    const adhoc = /^Signature=adhoc\s*$/m.test(display);
    const teamIdentifier = /^TeamIdentifier=(.+)$/m.exec(display)?.[1]?.trim() ?? null;
    if (unsigned && direct.codeSignaturePresent) throw new Error('unsigned simulator mode cannot contain code signature resources');
    if (input.signingMode === 'simulator-adhoc' && !adhoc) throw new Error('simulator app must have a verified adhoc signature');
    if (!input.signingMode.startsWith('simulator-') && (adhoc || !teamIdentifier)) {
      throw new Error('device/export app must have a verified team-bound signature');
    }
    const signerCertificateSha256: string[] = [];
    if (!unsigned && !adhoc) {
      const prefix = join(root, 'signer-cert-');
      run('codesign', ['-d', `--extract-certificates=${prefix}`, appPath]);
      for (const name of readdirSync(root).filter((entry) => entry.startsWith('signer-cert-')).sort()) {
        signerCertificateSha256.push(sha256File(join(root, name)));
      }
      if (signerCertificateSha256.length === 0) throw new Error('codesign did not extract a signer certificate');
    }
    return {
      binarySha256: sha256File(input.binaryPath), format: direct.format,
      applicationId: direct.applicationId, version: direct.version, buildNumber: direct.buildNumber,
      architectures: direct.architectures, metadataSha256: direct.metadataSha256,
      signatureVerified: !unsigned, signatureSchemes: unsigned ? [] : [adhoc ? 'adhoc' : 'codesign-cms'],
      signerCertificateSha256: sortedUnique(signerCertificateSha256), inspector: 'xcode/codesign+plutil+lipo',
      executable: direct.executable, codeSignaturePresent: direct.codeSignaturePresent,
      provisioningProfilePresent: direct.provisioningProfilePresent,
      signingMode: input.signingMode, teamIdentifier,
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

export function runTerminalNativePackageInspectionCli(args: readonly string[]): number {
  if (args.includes('--help')) {
    console.log('Usage: deviceEvidencePackageCli.ts --platform <ios|android> --binary <path> --output <json> [--aapt2 <path> --apksigner <path> | --ios-signing-mode <mode>]');
    return 0;
  }
  const platform = option(args, '--platform');
  const binaryPath = option(args, '--binary');
  const outputPath = option(args, '--output');
  if ((platform !== 'ios' && platform !== 'android') || !binaryPath || !outputPath) return 2;
  const aapt2Path = option(args, '--aapt2');
  const apksignerPath = option(args, '--apksigner');
  const iosSigningMode = option(args, '--ios-signing-mode');
  if (platform === 'android' && (!aapt2Path || !apksignerPath)) return 2;
  if (platform === 'ios' && !['simulator-unsigned', 'simulator-adhoc', 'device-development', 'device-distribution', 'app-store-export'].includes(String(iosSigningMode))) return 2;
  try {
    const details = platform === 'android'
      ? inspectAndroidPackageWithBuildTools({
        binaryPath: resolve(binaryPath),
        aapt2Path: resolve(aapt2Path!),
        apksignerPath: resolve(apksignerPath!),
      })
      : inspectIosPackageWithXcodeTools({
        binaryPath: resolve(binaryPath),
        signingMode: iosSigningMode as 'simulator-unsigned' | 'simulator-adhoc' | 'device-development' | 'device-distribution' | 'app-store-export',
      });
    mkdirSync(dirname(resolve(outputPath)), { recursive: true });
    writeFileSync(resolve(outputPath), `${terminalEvidenceCanonicalJson(details)}\n`, { mode: 0o600 });
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

if (process.argv[1]?.endsWith('deviceEvidencePackageCli.ts')) {
  process.exitCode = runTerminalNativePackageInspectionCli(process.argv.slice(2));
}
