import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));

function readPackageFile(relativePath: string): string {
  return readFileSync(join(packageRoot, relativePath), 'utf8');
}

describe('Iroh mobile release build contract', () => {
  it('uses the checked-in lockfile for Node, iOS, and Android Cargo builds', () => {
    expect(readPackageFile('scripts/build-node-addon.mjs')).toMatch(
      /const cargoArgs = \["build", "--locked",/u,
    );
    for (const script of ['scripts/build-rust-ios.sh', 'scripts/build-rust-android.sh']) {
      expect(readPackageFile(script)).toMatch(/cargo build --locked /u);
    }
  });

  it('proves the canonical Iroh version, source, and checksum across application lockfiles', () => {
    const source = readPackageFile('scripts/verify-iroh-lock-parity.mjs');
    expect(source).toContain("'rust/Cargo.lock'");
    expect(source).toContain("'../../apps/ui/src-tauri/Cargo.lock'");
    expect(source).toMatch(/version.*source.*checksum/su);
    expect(JSON.parse(readPackageFile('package.json')).scripts['verify:iroh-lock-parity'])
      .toBe('node scripts/verify-iroh-lock-parity.mjs');
  });

  it('reads Cargo artifacts from the package Rust workspace target directory', () => {
    for (const script of ['scripts/build-rust-ios.sh', 'scripts/build-rust-android.sh']) {
      const source = readPackageFile(script);
      expect(source).toContain('CARGO_TARGET_DIR="${ROOT_DIR}/rust/target"');
      expect(source).not.toContain('${CRATE_DIR}/target/');
    }
  });

  it('stages iOS universal and XCFramework outputs outside the synchronized checkout before publication', () => {
    const source = readPackageFile('scripts/build-rust-ios.sh');

    expect(source).toMatch(/WORK_DIR="\$\(mktemp -d /u);
    expect(source).toMatch(/trap .*WORK_DIR.* EXIT/u);
    expect(source).toContain('SIM_UNIVERSAL="${WORK_DIR}/libhappier_iroh_native.a"');
    expect(source).toContain('STAGED_XCFRAMEWORK="${WORK_DIR}/HappierIrohNativeRust.xcframework"');
    expect(source).toContain('-output "${STAGED_XCFRAMEWORK}"');
    expect(source).toContain('mv "${STAGED_XCFRAMEWORK}" "${XCFRAMEWORK}"');
    expect(source.indexOf('xcodebuild -create-xcframework')).toBeLessThan(
      source.indexOf('rm -rf "${XCFRAMEWORK}"'),
    );
  });

  it('allows native lifecycle panics to unwind into typed failure responses', () => {
    const workspaceManifest = readPackageFile('rust/Cargo.toml');
    expect(workspaceManifest).toMatch(/\[profile\.release\][\s\S]*?panic\s*=\s*"unwind"/u);
  });

  it('keeps Android ABI and API declarations aligned with the Rust artifacts', () => {
    const gradle = readPackageFile('android/build.gradle');
    const script = readPackageFile('scripts/build-rust-android.sh');
    const outputAbis = [...script.matchAll(/^build_target\s+"[^"]+"\s+"([^"]+)"/gmu)]
      .map((match) => match[1]);
    const abiFilters = gradle.match(/abiFilters\s+((?:'[^']+'(?:,\s*)?)+)/u);
    const gradleApiLevel = gradle.match(/def happierIrohNativeAndroidApiLevel\s*=\s*(\d+)/u);
    const scriptApiLevel = script.match(/API_LEVEL="\$\{HAPPIER_ANDROID_NATIVE_API_LEVEL:-(\d+)\}"/u);

    expect(outputAbis).toEqual(['arm64-v8a', 'x86_64']);
    expect(abiFilters).not.toBeNull();
    expect(gradleApiLevel).not.toBeNull();
    expect(scriptApiLevel).not.toBeNull();
    if (abiFilters === null || gradleApiLevel === null || scriptApiLevel === null) return;

    const declaredAbis = [...abiFilters[1].matchAll(/'([^']+)'/gu)].map((match) => match[1]);
    expect(declaredAbis).toEqual(outputAbis);
    expect(gradleApiLevel[1]).toBe('24');
    expect(scriptApiLevel[1]).toBe(gradleApiLevel[1]);
    expect(gradle).toContain('minSdk happierIrohNativeAndroidApiLevel');
    expect(gradle).toContain(
      'environment "HAPPIER_ANDROID_NATIVE_API_LEVEL", '
        + '(System.getenv("HAPPIER_ANDROID_NATIVE_API_LEVEL") '
        + '?: happierIrohNativeAndroidApiLevel.toString())',
    );
  });

  it('installs the Android application JNI context exactly once before endpoint construction', () => {
    const kotlin = readPackageFile(
      'android/src/main/java/dev/happier/iroh/HappierIrohNativeModule.kt',
    );
    const createEndpoint = kotlin.slice(
      kotlin.indexOf('fun createEndpoint(request:'),
      kotlin.indexOf('fun startMachineHttpTunnel('),
    );

    expect(createEndpoint.indexOf('IrohAndroidContext.install(context)')).toBeGreaterThan(-1);
    expect(createEndpoint.indexOf('IrohAndroidContext.install(context)')).toBeLessThan(
      createEndpoint.indexOf('HappierIrohNativeRust.createEndpointJson('),
    );
    expect(kotlin).toMatch(
      /private object IrohAndroidContext[\s\S]*?installed[\s\S]*?@Synchronized[\s\S]*?if \(installed\) return[\s\S]*?installAndroidContext\(context\.applicationContext\)[\s\S]*?installed = true/u,
    );
    expect(kotlin).toContain('external fun installAndroidContext(context: Context)');

    const rust = readPackageFile('rust/happier-iroh-native/src/lib.rs');
    expect(rust).toContain('iroh::dns::install_android_jni_context(');
    expect(rust).toContain('static ANDROID_APPLICATION_CONTEXT: Mutex<Option<GlobalRef>>');
    expect(rust).toContain('env.new_global_ref(application_context)');
  });

  it('keeps blocking Android Iroh lifecycle calls off Expo\'s serial module queue', () => {
    const android = readPackageFile(
      'android/src/main/java/dev/happier/iroh/HappierIrohNativeModule.kt',
    );
    const definition = android.slice(
      android.indexOf('override fun definition()'),
      android.indexOf('\n  }\n}\n\nprivate object HappierIrohNativeBridge'),
    );

    expect(android).toContain('import kotlinx.coroutines.Dispatchers');
    expect(android).toContain('import kotlinx.coroutines.withContext');
    expect(definition).toContain('Function("getAvailability")');
    expect(definition).not.toContain('AsyncFunction("getAvailability")');
    expect(definition).toContain('AsyncFunction("getTunnelStatus")');

    for (const operation of [
      'createEndpoint',
      'ensureHomeTunnel',
      'releaseHomeTunnel',
      'shutdownEndpoint',
      'startMachineTunnel',
      'startMachineHttpTunnel',
      'stopMachineTunnel',
    ]) {
      const start = definition.indexOf(`AsyncFunction("${operation}")`);
      const next = definition.indexOf('AsyncFunction(', start + 1);
      const body = definition.slice(start, next === -1 ? undefined : next);

      expect(start, operation).toBeGreaterThanOrEqual(0);
      expect(body, operation).toContain(`AsyncFunction("${operation}").SuspendBody`);
      expect(body, operation).toContain('withContext(Dispatchers.IO)');
    }
  });

  it('does not publish the Cargo target directory with the package sources', () => {
    const manifest = JSON.parse(readPackageFile('package.json')) as { files?: string[] };
    // Development checkouts contain only the current host addon. Publish the
    // exact native directory, never a glob (the workspace bundler deliberately
    // accepts only exact relative paths) or the separate test-addon directory.
    expect(manifest.files).toContain('native');
    expect(manifest.files?.some((entry) => /[*?{}[\]]/u.test(entry))).toBe(false);
    expect(manifest.files).not.toContain('native-test');
    expect(manifest.files).not.toContain('rust');
    expect(manifest.files).toEqual(expect.arrayContaining([
      'rust/Cargo.toml',
      'rust/Cargo.lock',
      'rust/happier-iroh-core',
      'rust/happier-iroh-native',
      'rust/happier-iroh-node',
    ]));
    expect(readPackageFile('.npmignore')).toMatch(/^rust\/target\/$/mu);
  });

  it('keeps the TypeScript and Rust machine carrier constants identical', () => {
    const descriptor = readPackageFile('src/descriptor.ts');
    const core = readPackageFile('rust/happier-iroh-core/src/lib.rs');
    const machine = readPackageFile('rust/happier-iroh-core/src/machine.rs');
    const typescriptAlpn = descriptor.match(/MACHINE_ALPN\s*=\s*'([^']+)'/u)?.[1];
    const rustAlpn = core.match(/MACHINE_ALPN:\s*&\[u8\]\s*=\s*b"([^"]+)"/u)?.[1];

    expect(typescriptAlpn).toBeDefined();
    expect(rustAlpn).toBe(typescriptAlpn);
    for (const [typescriptName, rustName = typescriptName, caseInsensitive = true] of [
      ['MACHINE_ADMISSION_PATH', 'MACHINE_ADMISSION_PATH', false],
      ['MACHINE_REMOTE_ENDPOINT_HEADER'],
      ['MACHINE_APPLICATION_PORT_HEADER', 'IROH_MACHINE_APPLICATION_PORT_HEADER'],
      ['MACHINE_APPLICATION_CAPABILITY_HEADER', 'IROH_MACHINE_APPLICATION_CAPABILITY_HEADER'],
      ['MACHINE_HTTP_LOCAL_CAPABILITY_HEADER', 'IROH_MACHINE_HTTP_LOCAL_CAPABILITY_HEADER'],
    ] as const) {
      const typescriptValue = descriptor.match(new RegExp(`${typescriptName}\\s*=\\s*'([^']+)'`, 'u'))?.[1];
      const rustValue = machine.match(new RegExp(`${rustName}:\\s*&str\\s*=\\s*"([^"]+)"`, 'u'))?.[1];
      expect(typescriptValue, typescriptName).toBeDefined();
      expect(caseInsensitive ? rustValue?.toLowerCase() : rustValue, rustName)
        .toBe(caseInsensitive ? typescriptValue?.toLowerCase() : typescriptValue);
    }
  });

  it('exposes only the canonical endpoint-and-tunnel handle lifecycle on mobile bindings', () => {
    const ios = readPackageFile('ios/HappierIrohNativeModule.swift');
    const android = readPackageFile(
      'android/src/main/java/dev/happier/iroh/HappierIrohNativeModule.kt',
    );
    for (const source of [ios, android]) {
      for (const operation of [
        'createEndpoint',
        'ensureHomeTunnel',
        'releaseHomeTunnel',
        'getTunnelStatus',
        'shutdownEndpoint',
        'startMachineTunnel',
        'startMachineHttpTunnel',
        'stopMachineTunnel',
      ]) {
        expect(source).toContain(`AsyncFunction("${operation}")`);
      }
      for (const removed of ['startHomeTunnel', 'stopHomeTunnel', 'getHomeTunnelStatus']) {
        expect(source).not.toContain(removed);
      }
    }
    const rustProduction = readPackageFile('rust/happier-iroh-native/src/lib.rs')
      .split('\n#[cfg(test)]\nmod tests')[0];
    const types = readPackageFile('src/HappierIrohNative.types.ts');
    expect(types).toContain('startMachineTunnel?: (request:');
    expect(types).toMatch(/startMachineTunnel\?:[\s\S]*?localCapability\?: string;/u);
    expect(ios).toContain('happier_iroh_native_start_machine_tunnel_json');
    const iosGeneratedHeader = readPackageFile('scripts/build-rust-ios.sh');
    expect(iosGeneratedHeader).toContain('happier_iroh_native_start_machine_http_tunnel_json');
    expect(android).toContain('HappierIrohNativeRust.startMachineTunnelJson(');
    expect(android).toContain('external fun startMachineTunnelJson(requestJson: String): String');
    expect(rustProduction).toContain('pub fn start_machine_tunnel_json(request: &str) -> Value');
    expect(rustProduction).toContain(
      'Java_dev_happier_iroh_HappierIrohNativeRust_startMachineTunnelJson',
    );
    const tauri = readPackageFile('../../apps/ui/src-tauri/src/iroh.rs');
    const rawCommand = tauri.slice(
      tauri.indexOf('pub async fn iroh_start_machine_tunnel('),
      tauri.indexOf('pub async fn iroh_stop_machine_tunnel('),
    );
    const rawProjection = tauri.slice(
      tauri.indexOf('fn renderer_machine_tunnel_lease('),
      tauri.indexOf('fn renderer_machine_http_tunnel_lease('),
    );
    const lifecycle = readPackageFile(
      '../../apps/ui/sources/sync/runtime/nativeIrohTunnels/machineTransferLifecycle.ts',
    );
    const finiteLifecycle = lifecycle.slice(
      lifecycle.indexOf('export async function startIrohMachineTransferTunnel('),
    );
    const desktopFiniteLifecycle = finiteLifecycle.slice(
      finiteLifecycle.indexOf('if (desktopHostKind() !== null)'),
      finiteLifecycle.indexOf('const native = await requireMobileModule()'),
    );
    expect(rawCommand).toContain('renderer_machine_tunnel_lease(started)');
    expect(rawCommand).not.toContain('renderer_machine_http_tunnel_lease(started)');
    expect(rawCommand).not.toContain('localCapability');
    expect(rawProjection).toContain('"localPort": local_port');
    expect(rawProjection).toContain('started.get("localCapability")');
    expect(rawProjection).not.toContain('"localOrigin"');
    expect(lifecycle).toContain('const localOrigin = record.localOrigin');
    expect(desktopFiniteLifecycle).toContain(
      "await invokeDesktopHost<unknown>(http ? 'iroh_start_machine_http_tunnel' : 'iroh_start_machine_tunnel'",
    );
    expect(desktopFiniteLifecycle).toContain(
      "await invokeDesktopHost('iroh_stop_machine_tunnel'",
    );
    expect(desktopFiniteLifecycle).not.toContain('iroh_stop_machine_http_tunnel');
    expect(desktopFiniteLifecycle).toContain('record.localPort');
    expect(desktopFiniteLifecycle).toContain("localOrigin: http ? record.localOrigin : typeof record.localPort === 'number'");
    for (const source of [types, ios, android]) {
      expect(source).not.toMatch(/payload(?:Bytes|Base64)/u);
    }
    for (const removed of ['start_home_tunnel_json', 'stop_home_tunnel_json', 'get_home_tunnel_status_json']) {
      expect(rustProduction).not.toContain(removed);
    }
  });
});
