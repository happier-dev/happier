import { readFile } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';

import { HappierRunnerActivationFileV1Schema } from '@happier-dev/protocol/ephemeralRunner/activationFile';
import type { HappierRunnerActivationFileV1 } from '@happier-dev/protocol/ephemeralRunner/activationFile';
import { RunnerActivationBindingV1Schema } from '@happier-dev/protocol/ephemeralRunner/activation';
import type { RunnerActivationBindingV1 } from '@happier-dev/protocol/ephemeralRunner/activation';
import { runnerArtifactTargetForPlatform } from '@happier-dev/protocol/ephemeralRunner/runnerArtifact';
import type { RunnerArtifactIdentityV1 } from '@happier-dev/protocol/ephemeralRunner/runnerArtifact';
import { decodeBase64, encodeBase64 } from '@happier-dev/protocol/crypto/base64';
import tweetnacl from 'tweetnacl';

import packageJson from '../../package.json';

export type EphemeralRunnerActivationFileErrorCode =
  | 'RUNNER_ACTIVATION_FILE_INVALID'
  | 'RUNNER_ARTIFACT_MISMATCH';

export class EphemeralRunnerActivationFileError extends Error {
  readonly code: EphemeralRunnerActivationFileErrorCode;

  constructor(code: EphemeralRunnerActivationFileErrorCode, message: string) {
    super(message);
    this.name = 'EphemeralRunnerActivationFileError';
    this.code = code;
  }
}

export type VerifiedEphemeralRunnerActivationFile = Readonly<{
  document: HappierRunnerActivationFileV1;
  binding: RunnerActivationBindingV1;
  activationSecretKey: Uint8Array;
  dispose(): void;
}>;

export async function readStrictEphemeralRunnerActivationDocument(
  path: string,
): Promise<HappierRunnerActivationFileV1> {
  let raw: string;
  try {
    raw = await readFile(path, { encoding: 'utf8' });
  } catch {
    throw invalidActivationFile();
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    throw invalidActivationFile();
  }
  const parsed = HappierRunnerActivationFileV1Schema.safeParse(decoded);
  if (!parsed.success) throw invalidActivationFile();
  return parsed.data;
}

function invalidActivationFile(): EphemeralRunnerActivationFileError {
  // Deliberately omit parse detail: rejected files can contain attacker-chosen
  // secrets and are never copied into logs or terminal output.
  return new EphemeralRunnerActivationFileError(
    'RUNNER_ACTIVATION_FILE_INVALID',
    'The Happier Runner activation file is invalid',
  );
}

export function assertRunnerArtifactMatchesCurrentExecutable(
  artifact: RunnerArtifactIdentityV1,
): void {
  const runtimeArtifactTarget = runnerArtifactTargetForPlatform({
    os: process.platform === 'win32' ? 'windows' : process.platform,
    arch: process.arch,
  });
  if (
    runtimeArtifactTarget === null
    || artifact.target !== runtimeArtifactTarget
    || artifact.version !== packageJson.version
  ) {
    throw new EphemeralRunnerActivationFileError(
      'RUNNER_ARTIFACT_MISMATCH',
      'This activation was created for a different Happier Runner artifact',
    );
  }
}

export async function readVerifiedEphemeralRunnerActivationFile(
  path: string,
  expected: Readonly<{ artifact: RunnerArtifactIdentityV1 }>,
): Promise<VerifiedEphemeralRunnerActivationFile> {
  const document = await readStrictEphemeralRunnerActivationDocument(path);
  if (!isDeepStrictEqual(document.activation.artifact, expected.artifact)) {
    throw new EphemeralRunnerActivationFileError(
      'RUNNER_ARTIFACT_MISMATCH',
      'This activation was created for a different Happier Runner artifact',
    );
  }

  const activationSecretKey = decodeBase64(
    document.activation.signingPrivateKeyBase64Url,
    'base64url',
  );
  if (activationSecretKey.length !== tweetnacl.sign.secretKeyLength) throw invalidActivationFile();
  const activationSigningPublicKey = encodeBase64(
    tweetnacl.sign.keyPair.fromSecretKey(activationSecretKey).publicKey,
    'base64url',
  );
  const activation = document.activation;
  const binding = RunnerActivationBindingV1Schema.safeParse({
    activationId: activation.id,
    homeServerIdentityId: document.home.homeServerIdentityId,
    creatorAccountId: activation.creatorAccountId,
    creatorTokenEpoch: activation.creatorTokenEpoch,
    activationExpiresAt: activation.activationExpiresAt,
    workspace: activation.workspace,
    sessionId: activation.sessionId,
    machineId: activation.machineId,
    activationSigningPublicKey,
    artifact: activation.artifact,
    endpointFactsRecipient: activation.endpointFactsRecipient,
    authoringCommitment: activation.authoringCommitment,
  });
  if (!binding.success) {
    activationSecretKey.fill(0);
    throw invalidActivationFile();
  }

  let disposed = false;
  return Object.freeze({
    document,
    binding: binding.data,
    activationSecretKey,
    dispose() {
      if (disposed) return;
      disposed = true;
      activationSecretKey.fill(0);
    },
  });
}
