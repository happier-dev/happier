import { createHash, createPrivateKey, createPublicKey } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';

import type { TerminalNativeDeviceArtifact, TerminalNativeDeviceEvidence } from './deviceEvidence';
import {
  terminalNativeCaptureAuthorityAllows,
  terminalNativeCaptureTimestampIsAllowed,
  verifyTerminalNativeCaptureSignature,
  type TerminalNativeCapturePolicy,
} from './deviceEvidenceAttestations';
import { readTerminalNativeBuildIdentityFromAppPackage } from './deviceEvidenceAppPackage';
import { terminalEvidenceCanonicalJson } from './deviceEvidenceCanonical';
import { createTerminalNativeCaptureAttestation } from './deviceEvidenceRunBundle';

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function publicKeyPemFromPrivate(privateKeyPem: string): string {
  return createPublicKey(createPrivateKey(privateKeyPem)).export({ type: 'spki', format: 'pem' }).toString();
}

function repositoryPath(root: string, path: string): string {
  const absolute = resolve(root, path);
  const normalized = relative(root, absolute).split(sep).join('/');
  if (normalized.startsWith('../') || normalized === '..') throw new Error(`path escapes repository: ${path}`);
  return normalized;
}

function atomicWriteJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, `${terminalEvidenceCanonicalJson(value)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

export function finalizeTerminalNativeCapture(input: Readonly<{
  repositoryRoot: string;
  draft: TerminalNativeDeviceEvidence;
  authorityId: string;
  privateKeyPem: string;
  capturePolicy: TerminalNativeCapturePolicy;
  attestationPath: string;
  clock?: () => Date;
}>): TerminalNativeDeviceEvidence {
  if (input.capturePolicy.schemaVersion !== 2 || !Array.isArray(input.capturePolicy.authorities)) {
    throw new Error('capture authority registry must use schemaVersion 2');
  }
  const authority = input.capturePolicy.authorities.find((candidate) => candidate.id === input.authorityId);
  if (!authority) throw new Error(`capture authority is not registered: ${input.authorityId}`);
  if (!terminalNativeCaptureAuthorityAllows(authority, input.draft.renderer.id, input.draft.buildEvidenceId)) {
    throw new Error(`capture authority ${input.authorityId} is not scoped for ${input.draft.renderer.id} build ${input.draft.buildEvidenceId}`);
  }
  for (const [label, timestamp] of [['run start', input.draft.startedAt], ['run end', input.draft.endedAt]] as const) {
    if (!terminalNativeCaptureTimestampIsAllowed(authority, timestamp)) {
      throw new Error(`${label} ${timestamp} is outside capture authority ${input.authorityId} validity window`);
    }
  }
  if (publicKeyPemFromPrivate(input.privateKeyPem).trim() !== authority.publicKeyPem.trim()) {
    throw new Error(`private key does not match registered capture authority ${input.authorityId}`);
  }
  if (input.draft.artifacts.some((artifact) => artifact.kind === 'capture-attestation')) {
    throw new Error('draft must not already contain a capture attestation');
  }
  const signedAt = (input.clock ?? (() => new Date()))().toISOString();
  if (!terminalNativeCaptureTimestampIsAllowed(authority, signedAt)) {
    throw new Error(`capture signing time ${signedAt} is outside capture authority ${input.authorityId} validity window`);
  }
  for (const artifact of input.draft.artifacts) {
    const absolute = resolve(input.repositoryRoot, artifact.path);
    repositoryPath(input.repositoryRoot, absolute);
    if (!statSync(absolute).isFile()) throw new Error(`artifact is not a regular file: ${artifact.path}`);
    if (sha256File(absolute) !== artifact.sha256) throw new Error(`artifact checksum mismatch: ${artifact.id}`);
  }

  const appArtifact = input.draft.artifacts.find((artifact) => artifact.id === input.draft.app.binaryArtifactId);
  if (!appArtifact) throw new Error('draft retained app artifact is unavailable for build identity verification');
  const embeddedIdentity = readTerminalNativeBuildIdentityFromAppPackage(
    resolve(input.repositoryRoot, appArtifact.path),
    input.draft.platform,
  );
  if (embeddedIdentity.authorityId !== authority.id
    || embeddedIdentity.rendererId !== input.draft.renderer.id
    || embeddedIdentity.buildEvidenceId !== input.draft.buildEvidenceId
    || !terminalNativeCaptureTimestampIsAllowed(authority, String(embeddedIdentity.generatedAt))
    || !verifyTerminalNativeCaptureSignature(embeddedIdentity, authority)) {
    throw new Error('retained app build identity is not authorized for this renderer, build, or validity window');
  }

  const attestationPath = resolve(input.attestationPath);
  const relativeAttestationPath = repositoryPath(input.repositoryRoot, attestationPath);
  if (!/(?:^|\/)\.project\/logs\/e2e\/terminal-native\/.+/.test(relativeAttestationPath)) {
    throw new Error('capture attestation must live under .project/logs/e2e/terminal-native');
  }
  const attestation = createTerminalNativeCaptureAttestation({
    authorityId: authority.id,
    privateKeyPem: input.privateKeyPem,
    evidence: input.draft,
    artifacts: input.draft.artifacts,
    signedAt,
  });
  atomicWriteJson(attestationPath, attestation);
  const artifact: TerminalNativeDeviceArtifact = {
    id: 'capture-attestation',
    kind: 'capture-attestation',
    path: relativeAttestationPath,
    mediaType: 'application/json',
    sha256: sha256File(attestationPath),
    capturedAt: signedAt,
  };
  return {
    ...input.draft,
    captureAuthority: authority.id,
    captureAttestationArtifactId: artifact.id,
    artifacts: [...input.draft.artifacts, artifact],
  };
}

function option(args: readonly string[], name: string): string | null {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] ?? null : null;
}

export function runTerminalNativeCaptureCli(args: readonly string[], repositoryRoot = resolve(process.cwd(), '../..')): number {
  const draftPath = option(args, '--draft');
  const outputPath = option(args, '--output');
  const attestationPath = option(args, '--attestation');
  const authorityId = option(args, '--authority');
  const privateKeyPath = option(args, '--private-key');
  if (args.includes('--help')) {
    console.log('Usage: deviceEvidenceCaptureCli.ts --draft <json> --output <json> --attestation <json> --authority <id> --private-key <pem>');
    return 0;
  }
  if (![draftPath, outputPath, attestationPath, authorityId, privateKeyPath].every(Boolean)) return 2;
  try {
    const draft = JSON.parse(readFileSync(resolve(draftPath!), 'utf8')) as TerminalNativeDeviceEvidence;
    const capturePolicy = JSON.parse(readFileSync(resolve(repositoryRoot, 'packages/terminal-native/device-evidence-capture-authorities.json'), 'utf8')) as TerminalNativeCapturePolicy;
    const finalized = finalizeTerminalNativeCapture({
      repositoryRoot,
      draft,
      authorityId: authorityId!,
      privateKeyPem: readFileSync(resolve(privateKeyPath!), 'utf8'),
      capturePolicy,
      attestationPath: resolve(attestationPath!),
    });
    atomicWriteJson(resolve(outputPath!), finalized);
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

if (process.argv[1]?.endsWith('deviceEvidenceCaptureCli.ts')) {
  process.exitCode = runTerminalNativeCaptureCli(process.argv.slice(2));
}
