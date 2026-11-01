const FIRST_PARTY_VERSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/u;
const FIRST_PARTY_VERSION_ID_MAX_LENGTH = 200;

export const FIRST_PARTY_INSTALL_HOME_ENV_KEY = 'HAPPIER_FIRST_PARTY_INSTALL_HOME';
export const FIRST_PARTY_MANAGED_TOOLS_DIR_NAME = 'tools';

export class InvalidFirstPartyVersionIdError extends Error {
  readonly code = 'FIRST_PARTY_VERSION_ID_INVALID';
  readonly versionId: string;

  constructor(versionId: string) {
    super(`Invalid first-party payload version id '${versionId}'. Expected one portable path segment.`);
    this.name = 'InvalidFirstPartyVersionIdError';
    this.versionId = versionId;
  }
}

export function assertValidFirstPartyVersionId(versionId: string): void {
  if (
    versionId.length === 0
    || versionId.length > FIRST_PARTY_VERSION_ID_MAX_LENGTH
    || !FIRST_PARTY_VERSION_ID_PATTERN.test(versionId)
  ) {
    throw new InvalidFirstPartyVersionIdError(versionId);
  }
}
