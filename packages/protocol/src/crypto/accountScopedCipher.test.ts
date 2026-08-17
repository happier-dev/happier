import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';

import tweetnacl from 'tweetnacl';
import {
  sealLegacyConnectedServiceQuotaSnapshotCompatibilityCiphertext,
} from '../host/legacyConnectedServiceQuotaCompatibility.js';
import {
  sealSessionOwnerMetadataFixtureCiphertext,
} from '../testing/accountScopedCipherFixtures.js';
import { decodeBase64, encodeBase64 } from './base64.js';
import { stringifySerializedJsonValue } from './serializedJsonValue.js';

import {
  createAccountScopedCryptoMaterialSnapshotV1,
  getAccountScopedBlobCiphertextBase64LengthV1,
  isAccountScopedBlobCiphertextForKind,
  openAccountScopedBlobCiphertext,
  readAccountScopedCiphertextKindByte,
  sealAccountScopedBlobCiphertext,
  type AccountScopedBlobKind,
  type AccountScopedCryptoMaterial,
  deriveAccountMachineKeyFromRecoverySecret,
  derivePluginCollectionIdentityTagV1,
} from './accountScopedCipher.js';
import {
  getAccountScopedBlobCiphertextBase64LengthV1 as getCanonicalAccountScopedBlobCiphertextBase64LengthV1,
  isAccountScopedBlobCiphertextForKind as isCanonicalAccountScopedBlobCiphertextForKind,
  readAccountScopedCiphertextKindByte as readCanonicalAccountScopedCiphertextKindByte,
} from './accountScopedCipherEnvelope.js';

function deterministicRandomBytesFactory(): (length: number) => Uint8Array {
  let counter = 1;
  return (length: number) => {
    const out = new Uint8Array(length);
    for (let i = 0; i < length; i++) {
      out[i] = counter & 0xff;
      counter++;
    }
    return out;
  };
}

const FROZEN_ACCOUNT_SCOPED_VECTOR_MACHINE_KEY =
  Uint8Array.from({ length: 32 }, (_, index) => index + 1);

const FROZEN_CANONICAL_ACCOUNT_SCOPED_VECTORS = [
  {
    kind: 'account_settings',
    kindByte: 1,
    ciphertext: 'oQEhIiMkJSYnKCkqKywtLi8wMTIzNDU2Nzj94RlZIyAv18gROn+709f0csPWYSTXX9PU9wCNwiQ+5MD1DSBhM5dHrncrvnXpyR0=',
    payload: { slot: 1, source: 'cli-v0.2.1' },
  },
  {
    kind: 'automation_template_payload',
    kindByte: 2,
    ciphertext: 'oQIhIiMkJSYnKCkqKywtLi8wMTIzNDU2NzhjMOHQt1wcsZ9zh1gLYjtXuexTWw75AVmbN+TKHn5Tt5j6kBwDpm3wb+17yzIwLLs=',
    payload: { slot: 2, source: 'cli-v0.2.1' },
  },
  {
    kind: 'connected_service_credential',
    kindByte: 3,
    ciphertext: 'oQMhIiMkJSYnKCkqKywtLi8wMTIzNDU2NzgGxu54j+shCt94KGyplfy49A3QCE4qv9Z6vQ1gEqx4pdbM1lTc21E6mxUQ7o2VLc4=',
    payload: { slot: 3, source: 'cli-v0.2.1' },
  },
  {
    kind: 'connected_service_quota_snapshot',
    kindByte: 4,
    ciphertext: 'oQQhIiMkJSYnKCkqKywtLi8wMTIzNDU2Nzg5fEl9K9e0gbQcLrSkvsMc0Wbde5VEgjODqJnwlP50/98/oh/sEPqZQamcCTwpYsU=',
    payload: { slot: 4, source: 'cli-v0.2.1' },
  },
  {
    kind: 'session_respawn_environment',
    kindByte: 5,
    ciphertext: 'oQUhIiMkJSYnKCkqKywtLi8wMTIzNDU2NzhHWU9WmWQ7nwAvyK6bcNpLDJTC6xywpyybRuQMGnRXvSaDO+M/Y8TUEVlmJ8CdSkqA5Z4yZfVMX+I=',
    payload: { slot: 5, source: 'remote-dev@165a9365' },
  },
  {
    kind: 'provider_account_usage_snapshot',
    kindByte: 6,
    ciphertext: 'oQYhIiMkJSYnKCkqKywtLi8wMTIzNDU2NziSyguEBc7xZotGmryGC78iu1JxU0l/R4iPjMjrci2oQwOWiDRnDXEMbfB31KH9hPPCBEUf4y90RdU=',
    payload: { slot: 6, source: 'remote-dev@165a9365' },
  },
  {
    kind: 'session_organization_display',
    kindByte: 7,
    ciphertext: 'oQchIiMkJSYnKCkqKywtLi8wMTIzNDU2Nzg0mkrSWNdvOq0Jvf6eiumoXFQk4kQLsvR4Fj9q/+utxYs/krndxhoJD+jdJ6u9JbMNk7oKvKkT0ks=',
    payload: { slot: 7, source: 'remote-dev@165a9365' },
  },
  {
    kind: 'session_first_intent',
    kindByte: 8,
    ciphertext: 'oQghIiMkJSYnKCkqKywtLi8wMTIzNDU2NzjT4yuWzsiuWbUcPaCjD9TdiZicxfS3G6P0UB1L1sTyUv9BLLHlfxIV4Z+eK81ltpc0NtuphiR3fZM=',
    payload: { slot: 8, source: 'remote-dev@165a9365' },
  },
  {
    kind: 'qualified_connected_account_configuration',
    kindByte: 9,
    ciphertext: 'oQkhIiMkJSYnKCkqKywtLi8wMTIzNDU2Nzh+oStuIDhXy3cUeiyw1H+ViUFnbGbprMiLCup6+VRcXSWgqJJIsTGn5g4FuiaZemQ=',
    payload: { slot: 9, source: 'dev-r4.4.6' },
  },
  {
    kind: 'session_owner_metadata',
    kindByte: 10,
    ciphertext: 'oQohIiMkJSYnKCkqKywtLi8wMTIzNDU2NzgsvICo8KXTESqbTLkYvLXJG1VfHFpp6U4WHG4Bi2KldSNqd2gMLo9JnviSP6dg8vIC',
    payload: { slot: 10, source: 'dev-r4.4.8' },
  },
  {
    kind: 'review_comment_sensitive',
    kindByte: 11,
    ciphertext: 'oQshIiMkJSYnKCkqKywtLi8wMTIzNDU2Nzh8SJImBuOUWhKTF2ASONdrNWdX8B7bWCeUaGd12Ud5FLHaEa9U30xtTpaa2LA1NIn7g88Sy0YNMjwGUHK/LX5ciaOdwLPj',
    payload: { slot: 11, source: 'plaintext-accounts-2026-07-31.9' },
  },
  {
    kind: 'review_comment_event_sensitive',
    kindByte: 12,
    ciphertext: 'oQwhIiMkJSYnKCkqKywtLi8wMTIzNDU2NziIfbdlWMAH0Gu7NhWjufXhCOg+0m1js1RYRnx5KuI0e7/HVjSjDbSC064Xed2f8t1c0UlACQzZY9tIe0sZX1InEmP1pKXx',
    payload: { slot: 12, source: 'plaintext-accounts-2026-07-31.9' },
  },
  {
    kind: 'plugin_declarative_settings',
    kindByte: 13,
    ciphertext: 'oQ0hIiMkJSYnKCkqKywtLi8wMTIzNDU2NzgbbYBzPymCkDUo8kNScqnaijviJpVf3/W8IMI0F/pr3fFNvEhi02/PgpfOajeTHXUdmTYLQWC4RF+1D0OfZJIXNfIsfBx19cFQKdDo7OQ4x28DUcw=',
    payload: { slot: 13, source: 'plugin-platform-preview-convergence-f18-svc03' },
  },
  {
    kind: 'automation_run_result',
    kindByte: 14,
    ciphertext: 'oQ4hIiMkJSYnKCkqKywtLi8wMTIzNDU2NzjqzFZwlv44Kc2xMxU/3qJceAjtUErHwGNGc+DOxo4RC0MSP7AiQ0/bt/qpmI+Er2qmDD+PIo67FPJnm8OtZaMVH6ifaH4I8HwM',
    payload: { slot: 14, source: 'event-automations-r0.22-run-result' },
  },
  {
    kind: 'automation_conversation_reply_context',
    kindByte: 15,
    ciphertext: 'oQ8hIiMkJSYnKCkqKywtLi8wMTIzNDU2NzjU8Et7e9o2sz7jnpWu2iPgh0fkgxfNKoeiBolvKfEy+6qO8+4/ROhS0vOJIi68YsoJOfzd4FIAGh8JSWylRjyqR/IFGTRae3wlahEE',
    payload: { slot: 15, source: 'event-automations-r0.22-reply-context' },
  },
  {
    kind: 'automation_reply_handoff_receipt',
    kindByte: 16,
    ciphertext: 'oRAhIiMkJSYnKCkqKywtLi8wMTIzNDU2NzjYxvoLrTTsm7GzWRHJjtjVoIyVTXvA0HVj7XeYLkgdROdFOo0O2H0OODdqp8u6FMs1Ol0E3CTHHqrex15KrmIwUEkYFPKsW2ZQQoSUu2Q=',
    payload: { slot: 16, source: 'event-automations-r0.22-handoff-receipt' },
  },
  {
    kind: 'plugin_collection_private_payload',
    kindByte: 17,
    ciphertext: 'oREhIiMkJSYnKCkqKywtLi8wMTIzNDU2NzgplMXbfMtVTx/6tBhnGzsV9ci80ZS1oMQcTKi9WTlab6oI/eR5OmMYtPIWsr5kYGoAHP6tFmYqEoWJtvULZiushUl1otpyegZu8jFOtzt+c8BwWg9SDGp5aV0=',
    payload: { slot: 17, source: 'plugin-extensibility-preview-data-r0.21-collections' },
  },
  {
    kind: 'plugin_account_kv_private_payload',
    kindByte: 18,
    ciphertext: 'oRIhIiMkJSYnKCkqKywtLi8wMTIzNDU2NzhC4dya9yhkI9FJB1N8lXN6ZjX0K3I8YRKXb9YAuPX+FuUjait70O8/cxptMhmnNKDmoVXShYexcIGKh7qNPPFlPjK91SvYBq0wwTlkOFc8IpIi+9bf+bsB8A==',
    payload: { slot: 18, source: 'plugin-extensibility-preview-data-r0.21-account-kv' },
  },
  {
    kind: 'automation_trigger_evidence',
    kindByte: 19,
    ciphertext: 'oRMhIiMkJSYnKCkqKywtLi8wMTIzNDU2Nzj6Heu1SknCXix1nK+8sfDRhgkeoqLORBq033GR/ly4vp5cQZOoGwktkgqlWEsnQxPKRRrBotvDxXZWzg1IxActt9py4EJeOIeUdeKWvN0G',
    payload: { slot: 19, source: 'event-automations-r0.23-trigger-evidence' },
  },
  {
    kind: 'automation_trigger_definition',
    kindByte: 20,
    ciphertext: 'oRQhIiMkJSYnKCkqKywtLi8wMTIzNDU2NzjWVPWz415CuDUXrxTJJ/7pG4ihLywZ/FGakUeRvh9X3WnQqHu0HA3MZM4A3X62K+8feFd2MoLcoIv06SfU1NyxjWMJjVnQAQc/D/uXHXWfgV4=',
    payload: { slot: 20, source: 'event-automations-r0.24-trigger-definition' },
  },
  {
    kind: 'automation_session_start_request',
    kindByte: 21,
    ciphertext: 'oRUhIiMkJSYnKCkqKywtLi8wMTIzNDU2Nzi632lF56rEM3YTKb+dOC2ST/yE5YZxVLtdA+oVQqDT6MGAcO/f50kbFCW/X3HG84M62gjeZW+pXkQyjzE5/4PJ8VVLOM7UR2SfHpMH1T5NIB93wJw=',
    payload: { slot: 21, source: 'event-automations-r0.28-session-start-request' },
  },
  {
    kind: 'automation_run_failure_detail',
    kindByte: 22,
    ciphertext: 'oRYhIiMkJSYnKCkqKywtLi8wMTIzNDU2NziMVajdy0ZlI0WjIwuxNEXBpz0FDw2fphFfTOGaMFwoEJiq4TzFnr19XleUKOulAVa2988hjvK0ZZ2A/ujUFleX+4AREhVS2SpXAweNUQ==',
    payload: { slot: 22, source: 'event-automations-r0.38-failure-detail' },
  },
] as const;

const FROZEN_HISTORICAL_ACCOUNT_SCOPED_ALIAS_VECTORS = [
  {
    kind: 'provider_account_usage_snapshot',
    ciphertext: 'oQUhIiMkJSYnKCkqKywtLi8wMTIzNDU2NziBJ/3OYHQgvc/8sPig5WoVu1JjU09qFpCDgpr5aG34XQ==',
    payload: { alias: 'pau5' },
  },
  {
    kind: 'session_respawn_environment',
    ciphertext: 'oQYhIiMkJSYnKCkqKywtLi8wMTIzNDU2Nzg4WFEkTnogRv0Z2DoTzy+WDJTQ6xql9jSUSLQaBnFEqS2XI7w=',
    payload: { alias: 'respawn6' },
  },
  {
    kind: 'qualified_connected_account_configuration',
    ciphertext: 'oQghIiMkJSYnKCkqKywtLi8wMTIzNDU2Nzhi7NCmuVdFpB4TqAoHOHCWiUF1bGD8/dCIBKtm+EdHWXig7w==',
    payload: { alias: 'config8' },
  },
] as const;

const TEST_FILE_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const PROTOCOL_PACKAGE_DIRECTORY = resolve(TEST_FILE_DIRECTORY, '..', '..');
const REPOSITORY_ROOT = resolve(PROTOCOL_PACKAGE_DIRECTORY, '..', '..');

const RELEASED_CLI_ACCOUNT_SCOPED_READER_ARTIFACTS = [
  {
    tag: 'cli-v0.2.0',
    commit: '526aa0db60a36db0f05ba4566ea443e397486424',
  },
  {
    tag: 'cli-v0.2.1',
    commit: 'b1d15a8a9c241737d1ca9b167459901e6259173a',
  },
  {
    tag: 'cli-v0.2.2-preview.1775586717.26498',
    commit: '4913c1e533c872a0712ba1c25b3104fd470aacc2',
  },
] as const;

const RELEASED_CLI_ACCOUNT_SCOPED_READER_SOURCE_FILES = [
  'packages/protocol/src/crypto/accountScopedCipher.ts',
  'packages/protocol/src/crypto/base64.ts',
  'packages/protocol/src/crypto/keyDerivation.ts',
  'packages/protocol/src/crypto/serializedJsonValue.ts',
] as const;

/**
 * This runs the immutable released reader source itself. It does not recreate
 * the historical crypto algorithm or kind table in the current test owner.
 * A shallow checkout does not retain released tags, so its unit lane skips the
 * artifact execution; the release/full-history compatibility lane owns it.
 */
function hasReleasedCliAccountScopedReaderArtifacts(): boolean {
  return RELEASED_CLI_ACCOUNT_SCOPED_READER_ARTIFACTS.every(({ tag }) => (
    spawnSync('git', ['rev-parse', '--verify', '--quiet', `${tag}^{}`], {
      cwd: REPOSITORY_ROOT,
      stdio: 'ignore',
    }).status === 0
  ));
}

function executeReleasedAccountScopedReaderVectors(
  reader: (typeof RELEASED_CLI_ACCOUNT_SCOPED_READER_ARTIFACTS)[number],
): readonly Readonly<{ kind: AccountScopedBlobKind; value: unknown | null }>[] {
  const resolvedCommit = execFileSync(
    'git',
    ['rev-parse', `${reader.tag}^{}`],
    { cwd: REPOSITORY_ROOT, encoding: 'utf8' },
  ).trim();
  if (resolvedCommit !== reader.commit) {
    throw new Error(
      `Released CLI reader tag ${reader.tag} resolved to ${resolvedCommit}, expected ${reader.commit}`,
    );
  }

  const artifactDirectory = mkdtempSync(
    join(PROTOCOL_PACKAGE_DIRECTORY, '.released-account-scoped-reader-'),
  );
  try {
    for (const sourcePath of RELEASED_CLI_ACCOUNT_SCOPED_READER_SOURCE_FILES) {
      const destination = join(artifactDirectory, sourcePath);
      mkdirSync(dirname(destination), { recursive: true });
      writeFileSync(
        destination,
        execFileSync('git', ['show', `${reader.tag}:${sourcePath}`], {
          cwd: REPOSITORY_ROOT,
        }),
      );
    }

    const result = spawnSync(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '--eval', `
const load = async (specifier) => {
  const module = await import(specifier);
  return module.default ?? module;
};
const currentCipher = await load(process.env.CURRENT_ACCOUNT_SCOPED_CIPHER_URL);
const currentQuotaCompatibility = await load(process.env.CURRENT_QUOTA_COMPATIBILITY_CIPHER_URL);
const historicalReader = await load(process.env.HISTORICAL_ACCOUNT_SCOPED_READER_URL);
const machineKey = Uint8Array.from(JSON.parse(process.env.ACCOUNT_SCOPED_MACHINE_KEY_JSON));
const material = { type: 'dataKey', machineKey };
const vectors = JSON.parse(process.env.ACCOUNT_SCOPED_READER_VECTORS_JSON);
const results = vectors.map((vector, index) => {
  const randomBytes = (length) => Uint8Array.from(
    { length },
    (_, byteIndex) => ((index + 1) * 37 + byteIndex) & 0xff,
  );
  const ciphertext = vector.kind === 'connected_service_quota_snapshot'
    ? currentQuotaCompatibility.sealLegacyConnectedServiceQuotaSnapshotCompatibilityCiphertext({
      material,
      payload: vector.payload,
      randomBytes,
    })
    : currentCipher.sealAccountScopedBlobCiphertext({
      kind: vector.kind,
      material,
      payload: vector.payload,
      randomBytes,
    });
  const value = historicalReader.openAccountScopedBlobCiphertext({
    kind: vector.kind,
    material,
    ciphertext,
  });
  return { kind: vector.kind, value: value?.value ?? null };
});
process.stdout.write(JSON.stringify(results));
`],
      {
        cwd: REPOSITORY_ROOT,
        encoding: 'utf8',
        env: {
          ...process.env,
          CURRENT_ACCOUNT_SCOPED_CIPHER_URL: pathToFileURL(
            join(TEST_FILE_DIRECTORY, 'accountScopedCipher.ts'),
          ).href,
          CURRENT_QUOTA_COMPATIBILITY_CIPHER_URL: pathToFileURL(
            join(
              PROTOCOL_PACKAGE_DIRECTORY,
              'src',
              'host',
              'legacyConnectedServiceQuotaCompatibility.ts',
            ),
          ).href,
          HISTORICAL_ACCOUNT_SCOPED_READER_URL: pathToFileURL(
            join(
              artifactDirectory,
              'packages',
              'protocol',
              'src',
              'crypto',
              'accountScopedCipher.ts',
            ),
          ).href,
          ACCOUNT_SCOPED_MACHINE_KEY_JSON: JSON.stringify(
            [...FROZEN_ACCOUNT_SCOPED_VECTOR_MACHINE_KEY],
          ),
          ACCOUNT_SCOPED_READER_VECTORS_JSON: JSON.stringify(
            FROZEN_CANONICAL_ACCOUNT_SCOPED_VECTORS.map(({ kind, payload }) => ({
              kind,
              payload,
            })),
          ),
        },
      },
    );
    if (result.error || result.status !== 0) {
      throw new Error(
        `Released CLI reader ${reader.tag} failed to execute: ${result.error?.message ?? ''}\n${result.stderr}\n${result.stdout}`,
      );
    }
    return JSON.parse(result.stdout) as readonly Readonly<{
      kind: AccountScopedBlobKind;
      value: unknown | null;
    }>[];
  } finally {
    rmSync(artifactDirectory, { recursive: true, force: true });
  }
}

type AccountScopedKindRollbackDisposition = Readonly<{
  productionOwner: string;
  remoteDev165A: 'readable' | 'rollback_blocking';
}>;

/**
 * Test-only compatibility evidence, deliberately derived from the canonical
 * kind union rather than exported as another runtime registry. Every current
 * kind must have one frozen vector and an explicit rollback disposition.
 */
const CURRENT_ACCOUNT_SCOPED_KIND_ROLLBACK_DISPOSITIONS = {
  account_settings: {
    productionOwner: 'Account Settings stored-content envelope',
    remoteDev165A: 'readable',
  },
  automation_template_payload: {
    productionOwner: 'Automation template stored-content envelope',
    remoteDev165A: 'readable',
  },
  connected_service_credential: {
    productionOwner: 'Connected Service credential envelope',
    remoteDev165A: 'readable',
  },
  connected_service_quota_snapshot: {
    productionOwner: 'Connected Service quota compatibility envelope',
    remoteDev165A: 'readable',
  },
  session_respawn_environment: {
    productionOwner: 'Session respawn environment owner',
    remoteDev165A: 'readable',
  },
  provider_account_usage_snapshot: {
    productionOwner: 'ProviderAccountUsage owner',
    remoteDev165A: 'readable',
  },
  session_organization_display: {
    productionOwner: 'Session organization display owner',
    remoteDev165A: 'readable',
  },
  session_first_intent: {
    productionOwner: 'Session first-intent owner',
    remoteDev165A: 'readable',
  },
  qualified_connected_account_configuration: {
    productionOwner: 'Qualified Connected Account configuration owner',
    remoteDev165A: 'rollback_blocking',
  },
  session_owner_metadata: {
    productionOwner: 'Session owner-metadata envelope owner',
    remoteDev165A: 'rollback_blocking',
  },
  review_comment_sensitive: {
    productionOwner: 'Review Comment sensitive-body owner',
    remoteDev165A: 'rollback_blocking',
  },
  review_comment_event_sensitive: {
    productionOwner: 'Review Comment event-sensitive owner',
    remoteDev165A: 'rollback_blocking',
  },
  plugin_declarative_settings: {
    productionOwner: 'Plugin declarative Settings record owner',
    remoteDev165A: 'rollback_blocking',
  },
  automation_run_result: {
    productionOwner: 'Automation reply-handoff result owner',
    remoteDev165A: 'rollback_blocking',
  },
  automation_conversation_reply_context: {
    productionOwner: 'Automation reply-handoff context owner',
    remoteDev165A: 'rollback_blocking',
  },
  automation_reply_handoff_receipt: {
    productionOwner: 'Automation reply-handoff receipt owner',
    remoteDev165A: 'rollback_blocking',
  },
  plugin_collection_private_payload: {
    productionOwner: 'Plugin Collection private-payload owner',
    remoteDev165A: 'rollback_blocking',
  },
  plugin_account_kv_private_payload: {
    productionOwner: 'Plugin Account KV private-payload owner',
    remoteDev165A: 'rollback_blocking',
  },
  automation_trigger_evidence: {
    productionOwner: 'Automation Event trigger-evidence host envelope',
    remoteDev165A: 'rollback_blocking',
  },
  automation_trigger_definition: {
    productionOwner: 'Automation trigger-definition stored-content envelope',
    remoteDev165A: 'rollback_blocking',
  },
  automation_session_start_request: {
    productionOwner: 'Automation Session-start request envelope',
    remoteDev165A: 'rollback_blocking',
  },
  automation_run_failure_detail: {
    productionOwner: 'Automation Run failure-detail envelope',
    remoteDev165A: 'rollback_blocking',
  },
} as const satisfies Record<AccountScopedBlobKind, AccountScopedKindRollbackDisposition>;

describe('accountScopedCipher', () => {
  it('has one frozen canonical vector and an explicit rollback disposition for every current kind', () => {
    const frozenKinds = FROZEN_CANONICAL_ACCOUNT_SCOPED_VECTORS.map(
      (vector) => vector.kind,
    );
    const frozenKindSet = new Set(frozenKinds);
    const dispositionKinds = Object.keys(
      CURRENT_ACCOUNT_SCOPED_KIND_ROLLBACK_DISPOSITIONS,
    ).sort();

    expect(frozenKindSet.size).toBe(frozenKinds.length);
    expect([...frozenKindSet].sort()).toEqual(dispositionKinds);
    expect(
      frozenKinds.filter(
        (kind) => CURRENT_ACCOUNT_SCOPED_KIND_ROLLBACK_DISPOSITIONS[kind].remoteDev165A
          === 'readable',
      ).sort(),
    ).toEqual(
      Object.entries(CURRENT_ACCOUNT_SCOPED_KIND_ROLLBACK_DISPOSITIONS)
        .filter(([, disposition]) => disposition.remoteDev165A === 'readable')
        .map(([kind]) => kind)
        .sort(),
    );
  });

  it('freezes canonical E2EE Account mode and content-key fingerprint vectors with the exact crypto material', () => {
    const legacySecret = new Uint8Array(32).fill(7);
    const legacy = createAccountScopedCryptoMaterialSnapshotV1({
      accountEncryptionMode: 'e2ee',
      material: { type: 'legacy', secret: legacySecret },
    });
    expect(legacy).toMatchObject({
      accountEncryptionMode: 'e2ee',
      contentPublicKeyFingerprint:
        'content-public-key-sha256:b6e2f1b418486b2714dd42bc21bffd2a9099e988572c4885713e19923cc774a6',
    });

    const machineKey = new Uint8Array(32).fill(9);
    const publicKey = tweetnacl.box.keyPair.fromSecretKey(machineKey).publicKey;
    const dataKey = createAccountScopedCryptoMaterialSnapshotV1({
      accountEncryptionMode: 'e2ee',
      material: { type: 'dataKey', machineKey },
      dataKeyPublicKey: publicKey,
    });
    expect(dataKey).toMatchObject({
      accountEncryptionMode: 'e2ee',
      contentPublicKeyFingerprint:
        'content-public-key-sha256:0710e7de882119e331610cac720c1b15288f7006f083c101777be37b19f2a8a3',
    });

    legacySecret.fill(0);
    machineKey.fill(0);
    publicKey.fill(0);
    expect(legacy.material.type).toBe('legacy');
    expect(legacy.material.type === 'legacy' && legacy.material.secret[0])
      .toBe(7);
    expect(dataKey.material.type).toBe('dataKey');
    expect(dataKey.material.type === 'dataKey' && dataKey.material.machineKey[0])
      .toBe(9);
  });

  it('rejects Account E2EE material for a plain Account', () => {
    expect(() => createAccountScopedCryptoMaterialSnapshotV1({
      // @ts-expect-error Plain Accounts cannot supply Account E2EE material.
      accountEncryptionMode: 'plain',
      material: {
        type: 'legacy',
        secret: new Uint8Array(32).fill(7),
      },
    })).toThrow();
  });

  it('rejects a data-key credential whose public key does not match its private machine key', () => {
    expect(() => createAccountScopedCryptoMaterialSnapshotV1({
      accountEncryptionMode: 'e2ee',
      material: {
        type: 'dataKey',
        machineKey: new Uint8Array(32).fill(9),
      },
      dataKeyPublicKey: new Uint8Array(32).fill(8),
    })).toThrow(/public key/i);
  });

  it('reports only the versioned-envelope kind byte for owner admission checks', () => {
    expect(readAccountScopedCiphertextKindByte(
      FROZEN_CANONICAL_ACCOUNT_SCOPED_VECTORS[5].ciphertext,
    )).toBe(6);
    expect(readAccountScopedCiphertextKindByte(
      'oQUhIiMkJSYnKCkqKywtLi8wMTIzNDU2NziBJ/3OYHQgvc/8sPig5WoVu1JjU09qFpCDgpr5aG34XQ==',
    )).toBe(5);
    expect(readAccountScopedCiphertextKindByte('not-base64')).toBeNull();
  });

  it('keeps envelope inspection and sizing at one browser-safe canonical owner', () => {
    expect(getAccountScopedBlobCiphertextBase64LengthV1)
      .toBe(getCanonicalAccountScopedBlobCiphertextBase64LengthV1);
    expect(isAccountScopedBlobCiphertextForKind)
      .toBe(isCanonicalAccountScopedBlobCiphertextForKind);
    expect(readAccountScopedCiphertextKindByte)
      .toBe(readCanonicalAccountScopedCiphertextKindByte);

    const triggerEvidence = FROZEN_CANONICAL_ACCOUNT_SCOPED_VECTORS.find(
      (vector) => vector.kind === 'automation_trigger_evidence',
    );
    expect(triggerEvidence).toBeDefined();
    if (!triggerEvidence) throw new Error('expected the frozen trigger-evidence vector');
    expect(isCanonicalAccountScopedBlobCiphertextForKind({
      kind: 'automation_trigger_evidence',
      ciphertext: triggerEvidence.ciphertext,
    })).toBe(true);
  });

  /**
   * Slots 1-4 were produced from immutable cli-v0.2.1 commit
   * b1d15a8a9c241737d1ca9b167459901e6259173a. Slots 5-8 were
   * regenerated from the kind map and v1 wire algorithm observed in exact
   * rollback predecessor remote-dev commit
   * 165a9365bcecc866fef967c3d86454de602a47ea. The slot-9 vector freezes the
   * approved r4.4.6 allocation using the same v1 wire algorithm. Slot 10 freezes
   * the approved r4.4.8 owner-metadata domain. Slots 11-12 freeze the approved
   * Plaintext Accounts .9 Review Comment sensitive-body and event domains.
   * Slot 13 freezes the Plugin Platform Preview Convergence F18/SVC03
   * declarative-settings domain. Slots 14-16 freeze Event Automations r0.22
   * reply-handoff result, context, and receipt domains. Slots 17-18 freeze
   * PEP-DATA r0.21 Collection and Account-KV private payload domains. Slot 19
   * freezes Event Automations r0.23 trigger evidence, and slot 20 freezes the
   * r0.25 trigger-definition domain. Slot 21 freezes the r0.28 Automation
   * Session-start request domain. Slot 22 freezes the r0.38 Run failure-detail
   * domain.
   */
  it('opens the provenance-pinned canonical vectors for slots 1 through 22', () => {
    const material: AccountScopedCryptoMaterial = {
      type: 'dataKey',
      machineKey: FROZEN_ACCOUNT_SCOPED_VECTOR_MACHINE_KEY,
    };

    for (const vector of FROZEN_CANONICAL_ACCOUNT_SCOPED_VECTORS) {
      const bytes = decodeBase64(vector.ciphertext, 'base64');
      expect(bytes.slice(0, 2)).toEqual(Uint8Array.of(0xa1, vector.kindByte));
      const opened = openAccountScopedBlobCiphertext({
        kind: vector.kind as AccountScopedBlobKind,
        material,
        ciphertext: vector.ciphertext,
      });
      expect(opened).toMatchObject({
        format: 'account_scoped_v1',
        kindTag: 'canonical',
        value: vector.payload,
      });
    }

  });

  it('freezes canonical kinds 10 through 22 with no alias or cross-domain admission', () => {
    const material: AccountScopedCryptoMaterial = {
      type: 'dataKey',
      machineKey: FROZEN_ACCOUNT_SCOPED_VECTOR_MACHINE_KEY,
    };
    const ownerVector = FROZEN_CANONICAL_ACCOUNT_SCOPED_VECTORS[9];
    const noAliasVectors = FROZEN_CANONICAL_ACCOUNT_SCOPED_VECTORS.slice(9);
    const randomBytes = (length: number) =>
      Uint8Array.from({ length }, (_, index) => index + 33);

    expect(sealSessionOwnerMetadataFixtureCiphertext({
      material,
      payload: ownerVector.payload,
      randomBytes,
    })).toBe(ownerVector.ciphertext);
    for (const noAliasVector of noAliasVectors) {
      expect(sealAccountScopedBlobCiphertext({
        kind: noAliasVector.kind,
        material,
        payload: noAliasVector.payload,
        randomBytes,
      })).toBe(noAliasVector.ciphertext);

      const canonicalBytes = decodeBase64(noAliasVector.ciphertext, 'base64');
      for (
        let candidateKindByte = 0;
        candidateKindByte <= 0xff;
        candidateKindByte++
      ) {
        if (candidateKindByte === noAliasVector.kindByte) continue;
        const retaggedBytes = new Uint8Array(canonicalBytes);
        retaggedBytes[1] = candidateKindByte;
        expect(openAccountScopedBlobCiphertext({
          kind: noAliasVector.kind,
          material,
          ciphertext: encodeBase64(retaggedBytes, 'base64'),
        })).toBeNull();
      }

      for (const otherVector of FROZEN_CANONICAL_ACCOUNT_SCOPED_VECTORS) {
        if (otherVector.kind === noAliasVector.kind) continue;
        expect(openAccountScopedBlobCiphertext({
          kind: noAliasVector.kind,
          material,
          ciphertext: otherVector.ciphertext,
        })).toBeNull();
        expect(openAccountScopedBlobCiphertext({
          kind: otherVector.kind,
          material,
          ciphertext: noAliasVector.ciphertext,
        })).toBeNull();
      }

      for (const aliasVector of FROZEN_HISTORICAL_ACCOUNT_SCOPED_ALIAS_VECTORS) {
        expect(openAccountScopedBlobCiphertext({
          kind: noAliasVector.kind,
          material,
          ciphertext: aliasVector.ciphertext,
        })).toBeNull();
      }
    }
  });

  it('opens only the bounded historical Dev tag aliases under their requested domains', () => {
    const material: AccountScopedCryptoMaterial = {
      type: 'dataKey',
      machineKey: FROZEN_ACCOUNT_SCOPED_VECTOR_MACHINE_KEY,
    };
    for (const vector of FROZEN_HISTORICAL_ACCOUNT_SCOPED_ALIAS_VECTORS) {
      expect(openAccountScopedBlobCiphertext({
        kind: vector.kind,
        material,
        ciphertext: vector.ciphertext,
      })).toMatchObject({
        format: 'account_scoped_v1',
        kindTag: 'historical_alias',
        value: vector.payload,
      });
    }

    expect(openAccountScopedBlobCiphertext({
      kind: 'session_respawn_environment',
      material,
      ciphertext:
        FROZEN_HISTORICAL_ACCOUNT_SCOPED_ALIAS_VECTORS[0]
          .ciphertext,
    })).toBeNull();
    expect(openAccountScopedBlobCiphertext({
      kind: 'provider_account_usage_snapshot',
      material,
      ciphertext:
        FROZEN_HISTORICAL_ACCOUNT_SCOPED_ALIAS_VECTORS[1]
          .ciphertext,
    })).toBeNull();
    expect(openAccountScopedBlobCiphertext({
      kind: 'session_first_intent' as AccountScopedBlobKind,
      material,
      ciphertext:
        FROZEN_HISTORICAL_ACCOUNT_SCOPED_ALIAS_VECTORS[2]
          .ciphertext,
    })).toBeNull();
  });

  it('makes the remote-dev rollback boundary explicit for every current kind', () => {
    const remoteDevReadableKinds = Object.entries(
      CURRENT_ACCOUNT_SCOPED_KIND_ROLLBACK_DISPOSITIONS,
    )
      .filter(([, disposition]) => disposition.remoteDev165A === 'readable')
      .map(([kind]) => kind)
      .sort();
    expect(remoteDevReadableKinds).toEqual(
      FROZEN_CANONICAL_ACCOUNT_SCOPED_VECTORS
        .slice(0, 8)
        .map((vector) => vector.kind)
        .sort(),
    );
  });

  const releasedReaderTest = hasReleasedCliAccountScopedReaderArtifacts()
    ? it
    : it.skip;

  releasedReaderTest('executes the immutable released CLI readers against every current canonical vector', () => {
    for (const reader of RELEASED_CLI_ACCOUNT_SCOPED_READER_ARTIFACTS) {
      expect(executeReleasedAccountScopedReaderVectors(reader)).toEqual(
        FROZEN_CANONICAL_ACCOUNT_SCOPED_VECTORS.map((vector, index) => ({
          kind: vector.kind,
          value: index < 4 ? vector.payload : null,
        })),
      );
    }
  }, 45_000);

  it('allows only the narrow compatibility sealer to emit the frozen kind-4 old-reader representation', () => {
    const material: AccountScopedCryptoMaterial = {
      type: 'dataKey',
      machineKey: FROZEN_ACCOUNT_SCOPED_VECTOR_MACHINE_KEY,
    };
    const payload = { slot: 4, source: 'cli-v0.2.1' };
    const randomBytes = (length: number) =>
      Uint8Array.from({ length }, (_, index) => index + 33);

    expect(sealLegacyConnectedServiceQuotaSnapshotCompatibilityCiphertext({
      material,
      payload,
      randomBytes,
    })).toBe(FROZEN_CANONICAL_ACCOUNT_SCOPED_VECTORS[3].ciphertext);
    expect(() => sealAccountScopedBlobCiphertext({
      kind: 'connected_service_quota_snapshot',
      material,
      payload,
      randomBytes,
    })).toThrow(/legacy read-only/i);
  });

  it('seals/opens without Buffer or atob/btoa globals', () => {
    const prevBuffer = (globalThis as any).Buffer;
    const prevAtob = (globalThis as any).atob;
    const prevBtoa = (globalThis as any).btoa;
    (globalThis as any).Buffer = undefined;
    (globalThis as any).atob = undefined;
    (globalThis as any).btoa = undefined;

    try {
      const kind: AccountScopedBlobKind = 'account_settings';
      const machineKey = new Uint8Array(32).fill(9);
      const material: AccountScopedCryptoMaterial = { type: 'dataKey', machineKey };
      const payload = { claudeLocalPermissionBridgeEnabled: true, schemaVersion: 1 };

      const ciphertext = sealAccountScopedBlobCiphertext({
        kind,
        material,
        payload,
        randomBytes: deterministicRandomBytesFactory(),
      });

      const opened = openAccountScopedBlobCiphertext({ kind, material, ciphertext });
      expect(opened?.format).toBe('account_scoped_v1');
      expect(opened?.value).toEqual(payload);
    } finally {
      (globalThis as any).Buffer = prevBuffer;
      (globalThis as any).atob = prevAtob;
      (globalThis as any).btoa = prevBtoa;
    }
  });

  it('seals and opens v1 ciphertext with dataKey material', () => {
    const kind: AccountScopedBlobKind = 'account_settings';
    const machineKey = new Uint8Array(32).fill(9);
    const material: AccountScopedCryptoMaterial = { type: 'dataKey', machineKey };
    const payload = { claudeLocalPermissionBridgeEnabled: true, schemaVersion: 1 };

    const ciphertext = sealAccountScopedBlobCiphertext({
      kind,
      material,
      payload,
      randomBytes: deterministicRandomBytesFactory(),
    });

    const opened = openAccountScopedBlobCiphertext({ kind, material, ciphertext });
    expect(opened?.format).toBe('account_scoped_v1');
    expect(opened?.value).toEqual(payload);
  });

  it('seals and opens v1 ciphertext for connected service credentials', () => {
    const kind: AccountScopedBlobKind = 'connected_service_credential';
    const machineKey = new Uint8Array(32).fill(4);
    const material: AccountScopedCryptoMaterial = { type: 'dataKey', machineKey };
    const payload = { serviceId: 'openai-codex', profileId: 'work', token: 'ciphertext-payload' };

    const ciphertext = sealAccountScopedBlobCiphertext({
      kind,
      material,
      payload,
      randomBytes: deterministicRandomBytesFactory(),
    });

    const opened = openAccountScopedBlobCiphertext({ kind, material, ciphertext });
    expect(opened?.format).toBe('account_scoped_v1');
    expect(opened?.value).toEqual(payload);
  });

  it('rejects sealing new connected service quota snapshot ciphertexts as legacy read-only', () => {
    const kind: AccountScopedBlobKind = 'connected_service_quota_snapshot';
    const machineKey = new Uint8Array(32).fill(5);
    const material: AccountScopedCryptoMaterial = { type: 'dataKey', machineKey };
    const payload = { v: 1, serviceId: 'openai-codex', profileId: 'work', fetchedAt: Date.now(), meters: [] };

    expect(() => sealAccountScopedBlobCiphertext({
      kind,
      material,
      payload,
      randomBytes: deterministicRandomBytesFactory(),
    })).toThrow(/legacy read-only/i);
  });

  it('seals and opens v1 ciphertext for session respawn environment continuity', () => {
    const kind: AccountScopedBlobKind = 'session_respawn_environment';
    const machineKey = new Uint8Array(32).fill(6);
    const material: AccountScopedCryptoMaterial = { type: 'dataKey', machineKey };
    const payload = {
      CLAUDE_CONFIG_DIR: '/tmp/claude-config',
      CODEX_HOME: '/tmp/codex-home',
    };

    const ciphertext = sealAccountScopedBlobCiphertext({
      kind,
      material,
      payload,
      randomBytes: deterministicRandomBytesFactory(),
    });

    const opened = openAccountScopedBlobCiphertext({ kind, material, ciphertext });
    expect(opened?.format).toBe('account_scoped_v1');
    expect(opened?.value).toEqual(payload);
  });

  it('seals and opens v1 ciphertext for session organization display payloads', () => {
    const kind: AccountScopedBlobKind = 'session_organization_display';
    const machineKey = new Uint8Array(32).fill(7);
    const material: AccountScopedCryptoMaterial = { type: 'dataKey', machineKey };
    const payload = { name: 'Pinned work', color: '#4f46e5' };

    const ciphertext = sealAccountScopedBlobCiphertext({
      kind,
      material,
      payload,
      randomBytes: deterministicRandomBytesFactory(),
    });

    const opened = openAccountScopedBlobCiphertext({ kind, material, ciphertext });
    expect(opened?.format).toBe('account_scoped_v1');
    expect(opened?.value).toEqual(payload);
  });

  it('emits only the canonical account-scoped v1 kind bytes', () => {
    const machineKey = new Uint8Array(32).fill(8);
    const material: AccountScopedCryptoMaterial = { type: 'dataKey', machineKey };
    const payload = { value: 'stable-kind-byte' };
    const cases: ReadonlyArray<readonly [AccountScopedBlobKind, number]> = [
      ['session_respawn_environment', 5],
      ['provider_account_usage_snapshot', 6],
      ['session_organization_display', 7],
      ['session_first_intent', 8],
      ['qualified_connected_account_configuration', 9],
      ['session_owner_metadata', 10],
      ['review_comment_sensitive', 11],
      ['review_comment_event_sensitive', 12],
      ['plugin_declarative_settings', 13],
      ['automation_run_result', 14],
      ['automation_conversation_reply_context', 15],
      ['automation_reply_handoff_receipt', 16],
      ['plugin_collection_private_payload', 17],
      ['plugin_account_kv_private_payload', 18],
      ['automation_trigger_evidence', 19],
      ['automation_trigger_definition', 20],
    ];

    for (const [kind, expectedKindByte] of cases) {
      const ciphertext = sealAccountScopedBlobCiphertext({
        kind,
        material,
        payload,
        randomBytes: deterministicRandomBytesFactory(),
      });

      const bytes = decodeBase64(ciphertext, 'base64');
      expect(bytes[0]).toBe(0xa1);
      expect(bytes[1]).toBe(expectedKindByte);
      expect(openAccountScopedBlobCiphertext({ kind, material, ciphertext })?.value).toEqual(payload);
    }
  });

  it('allows legacy and dataKey devices to read the same v1 ciphertext', () => {
    const kind: AccountScopedBlobKind = 'account_settings';
    const recoverySecret = new Uint8Array(32).fill(7);
    const machineKey = deriveAccountMachineKeyFromRecoverySecret(recoverySecret);

    const legacyMaterial: AccountScopedCryptoMaterial = { type: 'legacy', secret: recoverySecret };
    const dataKeyMaterial: AccountScopedCryptoMaterial = { type: 'dataKey', machineKey };
    const payload = { codexBackendMode: 'acp' };

    const ciphertext = sealAccountScopedBlobCiphertext({
      kind,
      material: legacyMaterial,
      payload,
      randomBytes: deterministicRandomBytesFactory(),
    });

    expect(openAccountScopedBlobCiphertext({ kind, material: legacyMaterial, ciphertext })?.value).toEqual(payload);
    expect(openAccountScopedBlobCiphertext({ kind, material: dataKeyMaterial, ciphertext })?.value).toEqual(payload);
  });

  it('leaves untagged recovery-secret payloads to the account-settings owner for domain validation', () => {
    const kind: AccountScopedBlobKind = 'account_settings';
    const recoverySecret = new Uint8Array(32).fill(3);
    const payload = { analyticsOptOut: false };

    const nonce = new Uint8Array(24).fill(4);
    const plaintext = new TextEncoder().encode(stringifySerializedJsonValue(payload));
    const boxed = tweetnacl.secretbox(plaintext, nonce, recoverySecret);
    const legacyBytes = new Uint8Array(nonce.length + boxed.length);
    legacyBytes.set(nonce, 0);
    legacyBytes.set(boxed, nonce.length);
    const legacyCiphertext = encodeBase64(legacyBytes, 'base64');

    const material: AccountScopedCryptoMaterial = { type: 'legacy', secret: recoverySecret };
    const opened = openAccountScopedBlobCiphertext({ kind, material, ciphertext: legacyCiphertext });
    expect(opened).toBeNull();
  });

  it('leaves untagged machine-key payloads to the automation owner for domain validation', () => {
    const kind: AccountScopedBlobKind = 'automation_template_payload';
    const machineKey = new Uint8Array(32).fill(6);
    const payload = { directory: '/tmp/project', prompt: 'Run checks' };

    const nonce = new Uint8Array(24).fill(8);
    const plaintext = new TextEncoder().encode(stringifySerializedJsonValue(payload));
    const boxed = tweetnacl.secretbox(plaintext, nonce, machineKey);
    const legacyBytes = new Uint8Array(nonce.length + boxed.length);
    legacyBytes.set(nonce, 0);
    legacyBytes.set(boxed, nonce.length);
    const legacyCiphertext = encodeBase64(legacyBytes, 'base64');

    const material: AccountScopedCryptoMaterial = { type: 'dataKey', machineKey };
    const opened = openAccountScopedBlobCiphertext({ kind, material, ciphertext: legacyCiphertext });
    expect(opened).toBeNull();
  });

  it('does not treat an untagged legacy nonce collision as a requested-domain envelope', () => {
    const kind: AccountScopedBlobKind = 'account_settings';
    const recoverySecret = new Uint8Array(32).fill(3);
    const payload = { analyticsOptOut: false };

    // Collision case: legacy nonce begins with the account-scoped magic byte and kind byte.
    const nonce = new Uint8Array(24).fill(4);
    nonce[0] = 0xa1;
    nonce[1] = 1; // account_settings kind byte

    const plaintext = new TextEncoder().encode(JSON.stringify(payload));
    const boxed = tweetnacl.secretbox(plaintext, nonce, recoverySecret);
    const legacyBytes = new Uint8Array(nonce.length + boxed.length);
    legacyBytes.set(nonce, 0);
    legacyBytes.set(boxed, nonce.length);
    const legacyCiphertext = encodeBase64(legacyBytes, 'base64');

    const material: AccountScopedCryptoMaterial = { type: 'legacy', secret: recoverySecret };
    const opened = openAccountScopedBlobCiphertext({ kind, material, ciphertext: legacyCiphertext });
    expect(opened).toBeNull();
    expect(openAccountScopedBlobCiphertext({
      kind: 'automation_template_payload',
      material,
      ciphertext: legacyCiphertext,
    })).toBeNull();
  });

  it('returns null when kind does not match', () => {
    const payload = { x: 1 };
    const machineKey = new Uint8Array(32).fill(8);
    const material: AccountScopedCryptoMaterial = { type: 'dataKey', machineKey };
    const ciphertext = sealAccountScopedBlobCiphertext({
      kind: 'account_settings',
      material,
      payload,
      randomBytes: deterministicRandomBytesFactory(),
    });

    expect(openAccountScopedBlobCiphertext({ kind: 'automation_template_payload', material, ciphertext })).toBeNull();
  });

  it('reserves the Automation trigger-definition ciphertext domain at stable byte 20', () => {
    const material: AccountScopedCryptoMaterial = {
      type: 'dataKey',
      machineKey: FROZEN_ACCOUNT_SCOPED_VECTOR_MACHINE_KEY,
    };
    const ciphertext = sealAccountScopedBlobCiphertext({
      // This assertion intentionally arrives before the registry allocation.
      kind: 'automation_trigger_definition' as AccountScopedBlobKind,
      material,
      payload: { slot: 20, source: 'event-automations-r0.24-trigger-definition' },
      randomBytes: (length) => Uint8Array.from({ length }, (_, index) => index + 33),
    });

    const frozenVector = FROZEN_CANONICAL_ACCOUNT_SCOPED_VECTORS.find(
      (vector) => vector.kind === 'automation_trigger_definition',
    );
    expect(ciphertext).toBe(frozenVector?.ciphertext);
    expect(readAccountScopedCiphertextKindByte(ciphertext)).toBe(20);
  });

  it('reserves the Automation Session-start request ciphertext domain at stable byte 21', () => {
    const material: AccountScopedCryptoMaterial = {
      type: 'dataKey',
      machineKey: FROZEN_ACCOUNT_SCOPED_VECTOR_MACHINE_KEY,
    };
    const ciphertext = sealAccountScopedBlobCiphertext({
      kind: 'automation_session_start_request',
      material,
      payload: { slot: 21, source: 'event-automations-r0.28-session-start-request' },
      randomBytes: (length) => Uint8Array.from({ length }, (_, index) => index + 33),
    });

    const frozenVector = FROZEN_CANONICAL_ACCOUNT_SCOPED_VECTORS.find(
      (vector) => vector.kind === 'automation_session_start_request',
    );
    expect(ciphertext).toBe(frozenVector?.ciphertext);
    expect(readAccountScopedCiphertextKindByte(ciphertext)).toBe(21);
  });

  it('reserves the Automation Run failure-detail ciphertext domain at stable byte 22', () => {
    const material: AccountScopedCryptoMaterial = {
      type: 'dataKey',
      machineKey: FROZEN_ACCOUNT_SCOPED_VECTOR_MACHINE_KEY,
    };
    const ciphertext = sealAccountScopedBlobCiphertext({
      kind: 'automation_run_failure_detail',
      material,
      payload: { slot: 22, source: 'event-automations-r0.38-failure-detail' },
      randomBytes: (length) => Uint8Array.from({ length }, (_, index) => index + 33),
    });

    const frozenVector = FROZEN_CANONICAL_ACCOUNT_SCOPED_VECTORS.find(
      (vector) => vector.kind === 'automation_run_failure_detail',
    );
    expect(ciphertext).toBe(frozenVector?.ciphertext);
    expect(readAccountScopedCiphertextKindByte(ciphertext)).toBe(22);
  });
});

describe('derivePluginCollectionIdentityTagV1', () => {
  const machineKeyFor = (seed: number): Uint8Array =>
    Uint8Array.from({ length: 32 }, (_, index) => (index + seed) & 0xff);

  const materialFor = (seed: number): AccountScopedCryptoMaterial => ({
    type: 'dataKey',
    machineKey: machineKeyFor(seed),
  });

  type IdentityTagRequest = Parameters<typeof derivePluginCollectionIdentityTagV1>[0];

  const request = (overrides: Partial<IdentityTagRequest> = {}): IdentityTagRequest => ({
    accountEncryptionMode: 'e2ee',
    material: materialFor(1),
    pluginId: 'happier.triage',
    collectionId: 'entries',
    field: 'entryTag',
    components: ['happier.scm-github/items', 'pull-request', 'octo/repo', '42'],
    ...overrides,
  });

  it('derives a different tag for identical field and components requested by a second plugin', () => {
    const first = derivePluginCollectionIdentityTagV1(request());
    const second = derivePluginCollectionIdentityTagV1(request({ pluginId: 'happier.other' }));

    expect(second).not.toBe(first);
  });

  it('derives a different tag for two fields of one collection', () => {
    const rowIdField = derivePluginCollectionIdentityTagV1(request({ components: ['a', 'b'] }));
    const indexField = derivePluginCollectionIdentityTagV1(
      request({ field: 'scopeTag', components: ['a', 'b'] }),
    );

    expect(indexField).not.toBe(rowIdField);
  });

  it('derives a different tag for two collections of one plugin', () => {
    const entries = derivePluginCollectionIdentityTagV1(request());
    const observations = derivePluginCollectionIdentityTagV1(request({ collectionId: 'observations' }));

    expect(observations).not.toBe(entries);
  });

  it('derives a stable 43-character tag over the row-id alphabet in both Account modes', () => {
    const keyed = derivePluginCollectionIdentityTagV1(request());
    const plain = derivePluginCollectionIdentityTagV1(
      request({ accountEncryptionMode: 'plain', material: null }),
    );

    for (const tag of [keyed, plain]) {
      expect(tag).toHaveLength(43);
      expect(tag).toMatch(/^[A-Za-z0-9_-]{43}$/);
    }
    expect(derivePluginCollectionIdentityTagV1(request())).toBe(keyed);
    expect(plain).not.toBe(keyed);
  });

  it('derives a different keyed tag for one identity under two Happier Accounts', () => {
    const first = derivePluginCollectionIdentityTagV1(request({ material: materialFor(1) }));
    const second = derivePluginCollectionIdentityTagV1(request({ material: materialFor(2) }));

    expect(second).not.toBe(first);
  });

  it('derives distinct tags for component tuples a delimiter join would merge', () => {
    /** A contract-valid `collisionScope` may itself contain the unit separator. */
    const separator = '\u001f';
    for (const accountEncryptionMode of ['e2ee', 'plain'] as const) {
      const material = accountEncryptionMode === 'e2ee' ? materialFor(1) : null;
      const left = derivePluginCollectionIdentityTagV1(request({
        accountEncryptionMode,
        material,
        components: [`origin${separator}region`, '42'],
      }));
      const right = derivePluginCollectionIdentityTagV1(request({
        accountEncryptionMode,
        material,
        components: ['origin', `region${separator}42`],
      }));

      expect(right).not.toBe(left);
    }
  });

  it('derives a 43-character tag for a natural key far above the row-id byte ceiling', () => {
    const oversized = 'x'.repeat(512);
    for (const accountEncryptionMode of ['e2ee', 'plain'] as const) {
      const tag = derivePluginCollectionIdentityTagV1(request({
        accountEncryptionMode,
        material: accountEncryptionMode === 'e2ee' ? materialFor(1) : null,
        components: [oversized, oversized, oversized],
      }));

      expect(tag).toMatch(/^[A-Za-z0-9_-]{43}$/);
    }
  });

  it('fails closed rather than mixing the two Account-mode arms', () => {
    expect(() => derivePluginCollectionIdentityTagV1(request({ material: null })))
      .toThrow(/identity material/i);
    expect(() => derivePluginCollectionIdentityTagV1(
      request({ accountEncryptionMode: 'plain', material: materialFor(1) }),
    )).toThrow(/identity material/i);
  });
});
