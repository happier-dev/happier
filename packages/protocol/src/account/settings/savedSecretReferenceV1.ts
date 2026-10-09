export const SHARED_SAVED_SECRET_REF_V1_PREFIX = 'happier:shared-secret:v1:';

export type SavedSecretRefV1 =
  | Readonly<{ kind: 'personal'; personalId: string }>
  | Readonly<{ kind: 'shared_resource'; resourceId: string }>;

export const SAVED_SECRET_REF_MAX_LENGTH_V1 = 256;

function assertSharedSavedSecretResourceIdV1(resourceId: unknown): asserts resourceId is string {
  if (
    typeof resourceId !== 'string'
    || resourceId.length === 0
    || resourceId.trim() !== resourceId
    || /[\u0000-\u001f\u007f]/u.test(resourceId)
    || SHARED_SAVED_SECRET_REF_V1_PREFIX.length + resourceId.length
      > SAVED_SECRET_REF_MAX_LENGTH_V1
  ) {
    throw new Error('Shared SavedSecret resource id is invalid');
  }
}

export function parseSavedSecretRefV1(value: string): SavedSecretRefV1 {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error('SavedSecret reference is invalid');
  }
  if (!value.startsWith(SHARED_SAVED_SECRET_REF_V1_PREFIX)) {
    // Personal ids predate the shared namespace and deliberately remain
    // opaque here. Collision migration happens before shared activation; the
    // pure codec must not retroactively narrow valid legacy personal ids.
    return Object.freeze({ kind: 'personal', personalId: value });
  }
  const resourceId = value.slice(SHARED_SAVED_SECRET_REF_V1_PREFIX.length);
  assertSharedSavedSecretResourceIdV1(resourceId);
  return Object.freeze({ kind: 'shared_resource', resourceId });
}

export function formatSharedSavedSecretRefV1(resourceId: string): string {
  assertSharedSavedSecretResourceIdV1(resourceId);
  return `${SHARED_SAVED_SECRET_REF_V1_PREFIX}${resourceId}`;
}

/** Canonical carrier paths keep opaque ids and field names unambiguous. */
export function formatSavedSecretReferencePathSegmentV1(key: string): string {
  return /^[A-Za-z_$][\w$]*$/u.test(key) ? `.${key}` : `[${JSON.stringify(key)}]`;
}

export function appendSavedSecretReferencePathV1(path: string, key: string): string {
  return path ? `${path}${formatSavedSecretReferencePathSegmentV1(key)}` : key;
}

/**
 * Identifiable reference carriers in original JSON, before stored projections
 * can discard additive fields. This does not authorize or rewrite a reference:
 * the domain census compares these paths with its known admitted bindings.
 */
export function listSavedSecretReferenceCarrierPathsV1(
  value: unknown,
  options: Readonly<{ secretId?: string; initialPath?: string }> = {},
): readonly string[] {
  const paths = new Set<string>();
  const visit = (candidate: unknown, path: string, referenceContainer: boolean): void => {
    if (Array.isArray(candidate)) {
      candidate.forEach((entry, index) => visit(entry, `${path}[${index}]`, referenceContainer));
      return;
    }
    if (candidate === null || typeof candidate !== 'object') return;
    const record = candidate as Record<string, unknown>;
    for (const [key, entry] of Object.entries(record)) {
      const childPath = appendSavedSecretReferencePathV1(path, key);
      const isReference = key === 'secretId' || key === 'savedSecretId' || key === 'secretRef'
        || key === 'bootstrapCredentialRef' || /(?:SecretId|SecretRef)$/u.test(key)
        || (key === 'ref' && (record.t === 'savedSecret' || record.kind === 'savedSecret'));
      if (typeof entry === 'string' && (options.secretId === undefined || entry === options.secretId)
        && (referenceContainer || isReference)) {
        paths.add((key === 'savedSecretId' && record.t !== 'savedSecret') || (key === 'secretId' && record.t === 'savedSecret')
          ? path : childPath);
      }
      const isReferenceContainer = key === 'secretRefs' || key === 'secretBindings'
        || key === 'credentialBindings' || key.startsWith('secretBindingsBy');
      // Voice entry identity/source metadata is not a credential binding map.
      const childIsReferenceContainer = key === 'credentialBindings' && Array.isArray(entry)
        ? false : referenceContainer || isReferenceContainer;
      visit(entry, childPath, childIsReferenceContainer);
    }
  };
  visit(value, options.initialPath ?? '', false);
  return Object.freeze([...paths]);
}
