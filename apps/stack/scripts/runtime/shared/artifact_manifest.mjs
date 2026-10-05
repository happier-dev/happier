import { dirname, join } from 'node:path';
import { stat } from 'node:fs/promises';

import { readJsonIfExists, writeJsonAtomic } from '../../utils/fs/json.mjs';
import { resolveStackComponentArtifactDir, validateRuntimeArtifactFingerprint } from './runtime_paths.mjs';
import { assertWebArtifactPayload } from './web_payload.mjs';
import { assertDaemonSupportPayload } from './daemon_support_payload.mjs';

const COMPONENT_SUPPORT_ARTIFACT_FIELDS = Object.freeze({
  server: {
    field: 'serverSupportArtifactFingerprint',
    supportComponent: 'server-support',
  },
  daemon: {
    field: 'daemonSupportArtifactFingerprint',
    supportComponent: 'daemon-support',
  },
});

function normalizeComponentSupportArtifactReference({ component, manifest }) {
  const descriptor = COMPONENT_SUPPORT_ARTIFACT_FIELDS[component];
  if (!descriptor) return { reference: null, error: null };
  const rawValue = manifest?.[descriptor.field];
  if (rawValue == null) return { reference: null, error: null };
  const fingerprintValidation = validateRuntimeArtifactFingerprint(rawValue);
  if (!fingerprintValidation.ok) {
    return {
      reference: null,
      error: `${descriptor.field} must be a non-empty artifact fingerprint`,
    };
  }
  return {
    reference: {
      field: descriptor.field,
      supportComponent: descriptor.supportComponent,
      artifactFingerprint: fingerprintValidation.artifactFingerprint,
    },
    error: null,
  };
}

export async function readArtifactManifest({ artifactDir }) {
  return await readJsonIfExists(join(artifactDir, 'manifest.json'), { defaultValue: null });
}

export async function writeArtifactManifest({ artifactDir, manifest }) {
  await writeJsonAtomic(join(artifactDir, 'manifest.json'), manifest);
}

export function artifactPayloadDir(artifactDir) {
  return join(artifactDir, 'payload');
}

export function validateArtifactManifest(manifest) {
  const errors = [];
  const version = Number(manifest?.version);
  const component = String(manifest?.component ?? '').trim();
  const artifactFingerprintValidation = validateRuntimeArtifactFingerprint(manifest?.artifactFingerprint);
  const artifactFingerprint = artifactFingerprintValidation.artifactFingerprint;
  const sourceFingerprint = String(manifest?.sourceFingerprint ?? '').trim();
  const entrypoint = String(manifest?.entrypoint ?? '').trim();
  const payloadDir = String(manifest?.payloadDir ?? '').trim();
  const supportReference = normalizeComponentSupportArtifactReference({ component, manifest });

  if (version !== 1) errors.push('artifact manifest version must be 1');
  if (!component) errors.push('artifact manifest component is required');
  if (!artifactFingerprintValidation.ok) {
    errors.push(artifactFingerprintValidation.error.replace(/^\[runtime\] /, 'artifact manifest '));
  }
  if (!sourceFingerprint) errors.push('artifact manifest sourceFingerprint is required');
  if (!payloadDir) errors.push('artifact manifest payloadDir is required');
  if (!entrypoint) errors.push('artifact manifest entrypoint is required');
  if (supportReference.error) errors.push(`artifact manifest ${supportReference.error}`);

  return {
    ok: errors.length === 0,
    errors,
    manifest: errors.length === 0
      ? {
          ...manifest,
          version,
          component,
          artifactFingerprint,
          sourceFingerprint,
          payloadDir,
          entrypoint,
          ...(supportReference.reference
            ? { [supportReference.reference.field]: supportReference.reference.artifactFingerprint }
            : {}),
        }
      : null,
  };
}

export function readComponentArtifactSupportReference(manifest) {
  const component = String(manifest?.component ?? '').trim();
  const { reference } = normalizeComponentSupportArtifactReference({ component, manifest });
  return reference;
}

export async function resolveComponentArtifactSupportReference({ stackBaseDir, manifest }) {
  const reference = readComponentArtifactSupportReference(manifest);
  if (!reference) return null;

  const artifactDir = resolveStackComponentArtifactDir({
    stackBaseDir,
    component: reference.supportComponent,
    fingerprint: reference.artifactFingerprint,
  });
  const supportManifest = await readReusableArtifactManifest({
    artifactDir,
    artifactFingerprint: reference.artifactFingerprint,
  });
  if (!supportManifest || supportManifest.component !== reference.supportComponent) {
    throw new Error(
      `[runtime] ${String(manifest?.component ?? '').trim()} support artifact is missing or invalid: ${reference.artifactFingerprint}.`,
    );
  }

  return {
    ...reference,
    artifactDir,
    manifest: supportManifest,
  };
}

// Historical self-contained snapshots have no artifact manifest. They share
// payload health with live artifacts without acquiring a current support binding.
export async function assertArtifactPayload({ stackBaseDir, payloadDir, manifest }) {
  const entrypoint = await stat(join(payloadDir, manifest.entrypoint));
  if (!entrypoint.isFile() || entrypoint.size === 0) {
    throw new Error(`[runtime] ${manifest.component} artifact payload is incomplete: entrypoint must be a non-empty file.`);
  }
  if (manifest.component === 'web') {
    await assertWebArtifactPayload({ payloadDir, entrypoint: manifest.entrypoint });
  }
  if (manifest.component === 'daemon-support') {
    await assertDaemonSupportPayload({ supportPayloadDir: payloadDir });
  }
  await resolveComponentArtifactSupportReference({ stackBaseDir, manifest });
}

export async function readReusableArtifactManifest({
  artifactDir,
  artifactFingerprint,
  stackBaseDir = dirname(dirname(dirname(artifactDir))),
}) {
  const manifest = await readArtifactManifest({ artifactDir });
  const validation = validateArtifactManifest(manifest);
  if (!validation.ok || validation.manifest.artifactFingerprint !== artifactFingerprint) return null;
  try {
    await assertArtifactPayload({ stackBaseDir, payloadDir: artifactPayloadDir(artifactDir), manifest: validation.manifest });
    return validation.manifest;
  } catch {
    return null;
  }
}
