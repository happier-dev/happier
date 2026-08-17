import {
  BUNDLED_LEGACY_CONNECTED_ACCOUNT_COMPATIBILITY_BY_SERVICE_ID,
  ConnectedServiceCredentialRecordV1Schema,
  QualifiedConnectedAccountConfigurationSnapshotV4Schema,
  QualifiedConnectedAccountCredentialSnapshotV4Schema,
  openQualifiedConnectedAccountContentEnvelope,
  parseQualifiedConnectedAccountCredentialPlaintextV1,
  sealQualifiedConnectedAccountContentEnvelope,
  type AccountScopedCryptoMaterial,
  type AccountEncryptionMigrateConnectedServicesDirective,
  type QualifiedConnectedAccountConfigurationSnapshotV4,
  type QualifiedConnectedAccountCredentialSnapshotV4,
  type QualifiedConnectedAccountProfileV4,
  type QualifiedConnectedAccountRef,
} from '@happier-dev/protocol';

type MigrationItem = Extract<
  AccountEncryptionMigrateConnectedServicesDirective,
  { action: 'migrate' }
>['qualifiedCredentials'][number];

export function qualifiedConnectedAccountLegacyProjectionKeys(
  accounts: readonly QualifiedConnectedAccountProfileV4[],
): ReadonlySet<string> {
  const keys = new Set<string>();
  for (const account of accounts) {
    for (const [serviceId, compatibility] of Object.entries(
      BUNDLED_LEGACY_CONNECTED_ACCOUNT_COMPATIBILITY_BY_SERVICE_ID,
    )) {
      if (
        compatibility.service.pluginId
          === account.ref.service.pluginId
        && compatibility.service.localId
          === account.ref.service.localId
      ) {
        keys.add(JSON.stringify([serviceId, account.ref.accountId]));
      }
    }
  }
  return keys;
}

function sameRef(
  left: QualifiedConnectedAccountRef,
  right: QualifiedConnectedAccountRef,
): boolean {
  return left.service.pluginId === right.service.pluginId
    && left.service.localId === right.service.localId
    && left.accountId === right.accountId;
}

function openSourceEnvelope(params: Readonly<{
  kind: 'credential' | 'configuration';
  sourceMode: 'plain' | 'e2ee';
  material: AccountScopedCryptoMaterial;
  envelope:
    | QualifiedConnectedAccountCredentialSnapshotV4['content']
    | QualifiedConnectedAccountConfigurationSnapshotV4[
        'configurationContent'
      ];
}>): unknown {
  const opened = params.sourceMode === 'plain'
    ? openQualifiedConnectedAccountContentEnvelope({
        kind: params.kind,
        accountMode: 'plain',
        envelope: params.envelope,
      })
    : openQualifiedConnectedAccountContentEnvelope({
        kind: params.kind,
        accountMode: 'e2ee',
        material: params.material,
        envelope: params.envelope,
      });
  if (opened === null) {
    throw new Error(
      `Qualified connected-account ${params.kind} does not match its source account encryption mode`,
    );
  }
  return opened;
}

function sealTargetEnvelope(params: Readonly<{
  kind: 'credential' | 'configuration';
  toMode: 'plain' | 'e2ee';
  material: AccountScopedCryptoMaterial;
  payload: unknown;
  randomBytes(length: number): Uint8Array;
}>) {
  return params.toMode === 'plain'
    ? sealQualifiedConnectedAccountContentEnvelope({
        kind: params.kind,
        accountMode: 'plain',
        payload: params.payload,
        randomBytes: params.randomBytes,
      })
    : sealQualifiedConnectedAccountContentEnvelope({
        kind: params.kind,
        accountMode: 'e2ee',
        material: params.material,
        payload: params.payload,
        randomBytes: params.randomBytes,
      });
}

/**
 * The single UI owner for account-encryption reseals of qualified credentials.
 * It opens and normalizes through the Protocol credential codec, then replaces
 * the content envelope on the same qualified row under its exact revisions.
 */
export async function resealQualifiedConnectedAccountMigrationCredentials(
  params: Readonly<{
    toMode: 'plain' | 'e2ee';
    material: AccountScopedCryptoMaterial;
    accounts: readonly QualifiedConnectedAccountProfileV4[];
    fetchCredential(
      ref: QualifiedConnectedAccountRef,
    ): Promise<QualifiedConnectedAccountCredentialSnapshotV4>;
    fetchConfiguration(
      ref: QualifiedConnectedAccountRef,
    ): Promise<QualifiedConnectedAccountConfigurationSnapshotV4>;
    randomBytes(length: number): Uint8Array;
  }>,
): Promise<readonly MigrationItem[]> {
  const sourceMode = params.toMode === 'plain' ? 'e2ee' : 'plain';
  const items: MigrationItem[] = [];

  for (const account of params.accounts) {
    if (account.revisionSemantics !== 'revisioned') {
      throw new Error(
        'Qualified connected-account credential revision is unavailable for migration',
      );
    }
    if (!account.authenticationModeId) {
      throw new Error(
        'Qualified connected-account authentication mode is unavailable for migration',
      );
    }
    const credential =
      QualifiedConnectedAccountCredentialSnapshotV4Schema.parse(
        await params.fetchCredential(account.ref),
      );
    if (credential.revisionSemantics !== 'revisioned') {
      throw new Error(
        'Qualified connected-account credential revision is unavailable for migration',
      );
    }
    if (
      !sameRef(credential.ref, account.ref)
      || credential.authenticationModeId !== account.authenticationModeId
      || credential.credentialRevision !== account.credentialRevision
      || credential.configurationRevision !== account.configurationRevision
    ) {
      throw new Error(
        'Qualified connected-account credential changed during migration preparation',
      );
    }
    const sourcePlaintext = openSourceEnvelope({
      kind: 'credential',
      sourceMode,
      material: params.material,
      envelope: credential.content,
    });
    const payload = parseQualifiedConnectedAccountCredentialPlaintextV1({
      ref: account.ref,
      authenticationModeId: account.authenticationModeId,
      plaintext: sourcePlaintext,
      metadata: credential.metadata,
    });
    const legacyPlaintext =
      ConnectedServiceCredentialRecordV1Schema.safeParse(sourcePlaintext);
    // An encryption-mode migration is a reseal under the same logical
    // revision. Preserve the normalized historical root (including its
    // timestamps) when present; novel qualified roots preserve their parsed
    // payload exactly.
    const replacementPlaintext =
      legacyPlaintext.success ? legacyPlaintext.data : payload;

    let replacementConfigurationContentEnvelope:
      QualifiedConnectedAccountConfigurationSnapshotV4[
        'configurationContent'
      ]
      | undefined;
    if (credential.configurationRevision !== null) {
      const configuration =
        QualifiedConnectedAccountConfigurationSnapshotV4Schema.parse(
          await params.fetchConfiguration(account.ref),
        );
      if (configuration.revisionSemantics !== 'revisioned') {
        throw new Error(
          'Qualified connected-account credential revision is unavailable for migration',
        );
      }
      if (
        configuration.target.kind !== 'account'
        || !sameRef(configuration.target.ref, account.ref)
        || configuration.authenticationModeId
          !== account.authenticationModeId
        || configuration.credentialRevision
          !== credential.credentialRevision
        || configuration.configurationRevision
          !== credential.configurationRevision
      ) {
        throw new Error(
          'Qualified connected-account configuration changed during migration preparation',
        );
      }
      replacementConfigurationContentEnvelope = sealTargetEnvelope({
        kind: 'configuration',
        toMode: params.toMode,
        material: params.material,
        payload: openSourceEnvelope({
          kind: 'configuration',
          sourceMode,
          material: params.material,
          envelope: configuration.configurationContent,
        }),
        randomBytes: params.randomBytes,
      });
    }

    items.push({
      ref: account.ref,
      expectedCredentialRevision: credential.credentialRevision,
      expectedConfigurationRevision:
        credential.configurationRevision,
      authenticationModeId: account.authenticationModeId,
      replacementCredentialContentEnvelope: sealTargetEnvelope({
        kind: 'credential',
        toMode: params.toMode,
        material: params.material,
        payload: replacementPlaintext,
        randomBytes: params.randomBytes,
      }),
      ...(replacementConfigurationContentEnvelope
        ? { replacementConfigurationContentEnvelope }
        : {}),
      metadata: credential.metadata,
    });
  }
  return Object.freeze(items);
}
