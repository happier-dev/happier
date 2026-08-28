import { readFile, writeFile } from 'node:fs/promises';

import type {
  MobileUcxLoadedNativeRuntime,
  MobileUcxLoadedNativeRuntimeSupport,
} from './mobileMaestroRunner';

export type MobilePluginPlatformCandidatePackageIdentity = Readonly<{
  packageName: string;
  version: string;
  integrity: string;
}>;

export type MobilePluginPlatformCandidateIdentity = Readonly<{
  runId: string;
  sdk: MobilePluginPlatformCandidatePackageIdentity;
  pluginUi: MobilePluginPlatformCandidatePackageIdentity;
  cli: MobilePluginPlatformCandidatePackageIdentity;
}>;

export type MobilePluginPlatformInstalledAppIdentity =
  | Readonly<{
      kind: 'android-base-apk';
      baseApkSha256: string;
      runtimeVersion: string | null;
    }>
  | Readonly<{
      kind: 'ios-app-bundle-file-set';
      appBundleFileSetSha256: string;
    }>
  | Readonly<{
      kind: 'unavailable';
      reason: string;
    }>;

export type UcxContributorVersionAttestation = Readonly<{
  archiveSha256: string;
  appliedGeneration: string | null;
}>;

export type MobilePluginPlatformCandidateRunAttestationInput = Readonly<{
  manifestPath: string;
  candidate: MobilePluginPlatformCandidateIdentity;
  installedApp: MobilePluginPlatformInstalledAppIdentity;
  ucxContributor: Readonly<{
    v1: UcxContributorVersionAttestation;
    v2: UcxContributorVersionAttestation;
  }>;
}>;

/**
 * UCX evidence is row-local: the exact SDK/Plugin UI/CLI packages and the
 * external plugin archives consumed by this one native journey. It does not
 * promote a broader candidate run id into a loaded-runtime authority.
 */
export type MobileUcxNativeRowArtifactIdentity = Readonly<{
  sdk: MobilePluginPlatformCandidatePackageIdentity;
  pluginUi: MobilePluginPlatformCandidatePackageIdentity;
  cli: MobilePluginPlatformCandidatePackageIdentity;
  plugin: Readonly<{
    id: string;
    v1: Readonly<{
      version: string;
      archiveSha256: string;
      appliedGeneration: string | null;
    }>;
    v2: Readonly<{
      version: string;
      archiveSha256: string;
      appliedGeneration: string | null;
    }>;
  }>;
}>;

export type MobileUcxNativeRowAttestationInput = Readonly<{
  manifestPath: string;
  row: MobileUcxNativeRowArtifactIdentity;
  installedApp: MobilePluginPlatformInstalledAppIdentity;
  loadedRuntime: MobileUcxLoadedNativeRuntime | null;
}>;

export type MobileUcxNativeRowAttestation =
  | Readonly<{
      status: 'observed';
      row: MobileUcxNativeRowArtifactIdentity;
      selectedApp: Record<string, unknown>;
      loadedRuntime: Extract<MobileUcxLoadedNativeRuntime, { kind: 'observed' }>;
    }>
  | Readonly<{
      status: 'blocked';
      row: MobileUcxNativeRowArtifactIdentity;
      selectedApp: Record<string, unknown>;
      blocker: Readonly<{
        kind: 'blocked';
        code: 'installed_app_identity_unavailable' | 'loaded_native_identity_unavailable';
        detail: string;
        wakeCondition: string;
        support?: MobileUcxLoadedNativeRuntimeSupport;
      }>;
    }>;

/**
 * A candidate mobile run cannot be reported as complete until the exact
 * JavaScript/bundle consumed by the selected device is bound to the candidate.
 * The incumbent Expo dev-client + Metro path does not expose that fact.
 */
export type MobilePluginPlatformCandidateRunAttestationBlocker = Readonly<{
  kind: 'blocked';
  code:
    | 'installed_app_identity_unavailable'
    | 'exact_device_loaded_javascript_identity_unavailable';
  candidateRunId: string;
  topology: 'expo-dev-client-metro';
  detail: string;
  wakeCondition: string;
}>;

type MobilePlatform = 'android' | 'ios';

type MobileMaestroManifest = Record<string, unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readRequiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`Mobile Maestro manifest omitted ${label}`);
  }
  return value;
}

function readNullableString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function readPlatform(value: unknown): MobilePlatform {
  if (value === 'android' || value === 'ios') return value;
  throw new Error('Mobile Maestro manifest omitted a supported platform');
}

function captureInstalledAppIdentity(
  platform: MobilePlatform,
  identity: MobilePluginPlatformInstalledAppIdentity,
): MobilePluginPlatformInstalledAppIdentity & Readonly<{
  capturePoint: 'before_maestro_process_start';
}> {
  if (platform === 'android' && identity.kind === 'ios-app-bundle-file-set') {
    throw new Error('An iOS app bundle identity cannot attest an Android Maestro run');
  }
  if (platform === 'ios' && identity.kind === 'android-base-apk') {
    throw new Error('An Android base APK identity cannot attest an iOS Maestro run');
  }
  return Object.freeze({
    ...identity,
    capturePoint: 'before_maestro_process_start' as const,
  });
}

function cloneCandidatePackageIdentity(
  identity: MobilePluginPlatformCandidatePackageIdentity,
): MobilePluginPlatformCandidatePackageIdentity {
  return Object.freeze({
    packageName: identity.packageName,
    version: identity.version,
    integrity: identity.integrity,
  });
}

function buildSelectedApp(
  manifest: MobileMaestroManifest,
  input: Readonly<{
    installedApp: MobilePluginPlatformInstalledAppIdentity;
  }>,
): Record<string, unknown> {
  const platform = readPlatform(manifest.platform);
  return Object.freeze({
    platform,
    deviceId: readNullableString(manifest.deviceId),
    appId: readRequiredString(manifest.appId, 'appId'),
    installedApp: captureInstalledAppIdentity(platform, input.installedApp),
  });
}

function cloneUcxNativeRowArtifacts(
  row: MobileUcxNativeRowArtifactIdentity,
): MobileUcxNativeRowArtifactIdentity {
  return Object.freeze({
    sdk: cloneCandidatePackageIdentity(row.sdk),
    pluginUi: cloneCandidatePackageIdentity(row.pluginUi),
    cli: cloneCandidatePackageIdentity(row.cli),
    plugin: Object.freeze({
      id: row.plugin.id,
      v1: Object.freeze({ ...row.plugin.v1 }),
      v2: Object.freeze({ ...row.plugin.v2 }),
    }),
  });
}

function buildMobileUcxNativeRowAttestation(
  manifest: MobileMaestroManifest,
  input: MobileUcxNativeRowAttestationInput,
): MobileUcxNativeRowAttestation {
  const selectedApp = buildSelectedApp(manifest, input);
  const row = cloneUcxNativeRowArtifacts(input.row);
  if (input.installedApp.kind === 'unavailable') {
    return Object.freeze({
      status: 'blocked' as const,
      row,
      selectedApp,
      blocker: Object.freeze({
        kind: 'blocked' as const,
        code: 'installed_app_identity_unavailable' as const,
        detail: input.installedApp.reason,
        wakeCondition: 'Attest the selected installed app before this native row begins; no loaded app or bundle claim is valid without that binary identity.',
      }),
    });
  }
  if (input.loadedRuntime?.kind === 'observed') {
    const deviceReportedRevision = input.loadedRuntime.deviceReportedBundle?.revision;
    if (deviceReportedRevision === input.loadedRuntime.bundle.revision) {
      return Object.freeze({
        status: 'observed' as const,
        row,
        selectedApp,
        loadedRuntime: input.loadedRuntime,
      });
    }
    const runtimeDetail = deviceReportedRevision
      ? `The selected-device loaded bundle revision ${deviceReportedRevision} does not match the row's asserted served-bundle revision ${input.loadedRuntime.bundle.revision}.`
      : 'The runner did not receive an immutable loaded bundle revision reported by the selected device.';
    return Object.freeze({
      status: 'blocked' as const,
      row,
      selectedApp,
      blocker: Object.freeze({
        kind: 'blocked' as const,
        code: 'loaded_native_identity_unavailable' as const,
        detail: runtimeDetail,
        wakeCondition: 'Have the selected device report the immutable revision compiled into the JavaScript bundle it loaded and verify that it matches this row\'s asserted served-bundle revision before recording observed.',
        support: Object.freeze({
          servedBundle: input.loadedRuntime.bundle,
          moduleProbe: input.loadedRuntime.moduleProbe,
        }),
      }),
    });
  }
  const runtimeDetail = input.loadedRuntime
    ? `${input.loadedRuntime.code}: ${input.loadedRuntime.detail}`
    : 'The mobile runner did not request a UCX loaded native identity.';
  return Object.freeze({
    status: 'blocked' as const,
    row,
    selectedApp,
    blocker: Object.freeze({
      kind: 'blocked' as const,
      code: 'loaded_native_identity_unavailable' as const,
      detail: runtimeDetail,
      wakeCondition: input.loadedRuntime?.wakeCondition
        ?? 'Have the selected device report the immutable revision compiled into the JavaScript bundle it loaded and verify that it matches this row\'s asserted served-bundle revision before recording observed.',
      support: input.loadedRuntime?.support,
    }),
  });
}

/**
 * Appends one UCX row-local native attestation to the incumbent Maestro
 * manifest. The returned record is observed only after the existing runner
 * has a selected-device-reported immutable bundle revision matching the row's
 * asserted served-bundle revision. Metro host facts and the module probe are
 * support only; they never establish loaded identity on their own.
 */
export async function appendMobileUcxNativeRowAttestation(
  input: MobileUcxNativeRowAttestationInput,
): Promise<MobileUcxNativeRowAttestation> {
  const manifest = JSON.parse(
    await readFile(input.manifestPath, 'utf8'),
  ) as unknown;
  if (!isRecord(manifest)) {
    throw new Error('Mobile Maestro manifest must be a JSON object');
  }
  if (manifest.pluginPlatformUcxNativeAttestation !== undefined) {
    throw new Error('Mobile Maestro manifest already contains a UCX native attestation');
  }
  const attestation = buildMobileUcxNativeRowAttestation(manifest, input);
  await writeFile(
    input.manifestPath,
    `${JSON.stringify({
      ...manifest,
      pluginPlatformUcxNativeAttestation: {
        v: 1,
        ...attestation,
      },
    }, null, 2)}\n`,
    'utf8',
  );
  return attestation;
}

/**
 * The runner starts an Expo development client through a Metro URL. Its host
 * fetch and Metro log only prove that Metro served a bundle; neither proves
 * which bytes the selected device actually executed. Keep the failure typed
 * so callers can stop before Maestro starts rather than emit a false-green.
 */
export function resolveMobilePluginPlatformCandidateMetroDevClientAttestationBlocker(
  input: Readonly<{
    candidate: MobilePluginPlatformCandidateIdentity;
    installedApp: MobilePluginPlatformInstalledAppIdentity;
  }>,
): MobilePluginPlatformCandidateRunAttestationBlocker {
  if (input.installedApp.kind === 'unavailable') {
    return Object.freeze({
      kind: 'blocked',
      code: 'installed_app_identity_unavailable',
      candidateRunId: input.candidate.runId,
      topology: 'expo-dev-client-metro',
      detail: input.installedApp.reason,
      wakeCondition: 'Expose and attest the selected device/app before Maestro starts; an exact device-loaded JavaScript or bundle identity is still required before this candidate gate can pass.',
    });
  }
  return Object.freeze({
    kind: 'blocked',
    code: 'exact_device_loaded_javascript_identity_unavailable',
    candidateRunId: input.candidate.runId,
    topology: 'expo-dev-client-metro',
    detail: 'Metro host/device URLs, host-side warming fetches, and Metro bundle logs do not prove which JavaScript bytes the selected device loaded.',
    wakeCondition: 'Add a candidate/build contract that records a digest from the selected device for the exact JavaScript or bundle it loaded and binds that digest to this candidate run.',
  });
}

function buildBlockedAttestation(
  manifest: MobileMaestroManifest,
  input: MobilePluginPlatformCandidateRunAttestationInput,
  blocker: MobilePluginPlatformCandidateRunAttestationBlocker,
): Record<string, unknown> {
  const candidate = Object.freeze({
    runId: input.candidate.runId,
    sdk: cloneCandidatePackageIdentity(input.candidate.sdk),
    pluginUi: cloneCandidatePackageIdentity(input.candidate.pluginUi),
    cli: cloneCandidatePackageIdentity(input.candidate.cli),
  });
  return Object.freeze({
    v: 1,
    status: 'blocked',
    candidate,
    selectedApp: buildSelectedApp(manifest, input),
    blocker,
    ucxContributor: Object.freeze({
      v1: Object.freeze({ ...input.ucxContributor.v1 }),
      v2: Object.freeze({ ...input.ucxContributor.v2 }),
    }),
  });
}

/**
 * Records a typed completion blocker in the incumbent Maestro manifest. The
 * current Metro/dev-client topology cannot produce an exact device-loaded
 * JavaScript identity, so this API must never serialize an `unattested`
 * success record.
 */
export async function appendMobilePluginPlatformCandidateRunAttestation(
  input: MobilePluginPlatformCandidateRunAttestationInput,
): Promise<MobilePluginPlatformCandidateRunAttestationBlocker> {
  const manifest = JSON.parse(
    await readFile(input.manifestPath, 'utf8'),
  ) as unknown;
  if (!isRecord(manifest)) {
    throw new Error('Mobile Maestro manifest must be a JSON object');
  }
  if (manifest.pluginPlatformCandidateAttestation !== undefined) {
    throw new Error('Mobile Maestro manifest already contains a candidate attestation');
  }
  const blocker = resolveMobilePluginPlatformCandidateMetroDevClientAttestationBlocker({
    candidate: input.candidate,
    installedApp: input.installedApp,
  });
  await writeFile(
    input.manifestPath,
    `${JSON.stringify({
      ...manifest,
      pluginPlatformCandidateAttestation: buildBlockedAttestation(manifest, input, blocker),
    }, null, 2)}\n`,
    'utf8',
  );
  return blocker;
}
