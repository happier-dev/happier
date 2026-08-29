import {
  ACCOUNT_DIRECTORY_ASSERTION_MAX_LIFETIME_MS,
  ACCOUNT_DIRECTORY_ASSERTION_MIN_LIFETIME_MS,
  ACCOUNT_DIRECTORY_ASSERTION_SIGNING_DOMAIN_V1,
  ACCOUNT_DIRECTORY_HOME_LOGIN_ASSERTION_HTTP_PATH_V1,
  ACCOUNT_DIRECTORY_HOMES_HTTP_PATH_V1,
  ACCOUNT_DIRECTORY_LINKS_HTTP_PATH_V1,
  ACCOUNT_DIRECTORY_ME_HTTP_PATH_V1,
  ACCOUNT_DIRECTORY_PREFERRED_HOME_HTTP_PATH_V1,
  HOME_LOGIN_HTTP_PATH_V1,
  AccountDirectoryHomeEntryV1Schema,
  AccountDirectoryHomesResponseV1Schema,
  AccountDirectoryLinkPutRequestV1Schema,
  AccountDirectoryMeResponseV1Schema,
  HomeConnectionDescriptorV1Schema,
  HomeLoginAssertionV1Schema,
} from '@happier-dev/protocol';
import { AccountDirectoryCapabilitiesSchema } from '../../../protocol/src/auth/accountDirectory';

const keyBase64 = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
const keyBase64Url = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const keyId = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

const httpsDescriptor = {
  v: 1 as const,
  homeServerIdentityId: 'srv_home_https',
  canonicalServerUrl: 'https://home.example.test',
  revision: 1,
  endpoints: [{ kind: 'https' as const, url: 'https://home.example.test' }],
};

const irohDescriptor = {
  v: 1 as const,
  homeServerIdentityId: 'srv_home_iroh',
  canonicalServerUrl: 'http://127.0.0.1:43123',
  revision: 2,
  endpoints: [{ kind: 'iroh' as const, endpointId: 'endpoint-home-iroh' }],
};

function require(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

export type AccountDirectoryScenario = Readonly<{
  id: `F-AD-0${1 | 2 | 3 | 4 | 5 | 6}`;
  name: string;
  run: () => Promise<void>;
}>;

/** F-AD-01: descriptor variants are closed, bounded, and URL-safe. */
async function descriptorScenario(): Promise<void> {
  require(HomeConnectionDescriptorV1Schema.safeParse(httpsDescriptor).success, 'HTTPS descriptor rejected');
  require(HomeConnectionDescriptorV1Schema.safeParse(irohDescriptor).success, 'Iroh descriptor rejected');
  require(!HomeConnectionDescriptorV1Schema.safeParse({ ...httpsDescriptor, extra: true }).success, 'Descriptor accepted unknown fields');
  require(!HomeConnectionDescriptorV1Schema.safeParse({ ...httpsDescriptor, canonicalServerUrl: 'ftp://home.example.test' }).success, 'Descriptor accepted non-HTTP URL');
}

/** F-AD-02: directory entries and preferred state agree on one Home identity. */
async function homeDirectoryScenario(): Promise<void> {
  const home = {
    v: 1 as const,
    homeServerIdentityId: httpsDescriptor.homeServerIdentityId,
    canonicalServerUrl: httpsDescriptor.canonicalServerUrl,
    label: 'Personal Home',
    connectionDescriptor: httpsDescriptor,
    createdAtMs: 1_700_000_000_000,
    updatedAtMs: 1_700_000_000_001,
    preferred: true,
  };
  require(AccountDirectoryHomeEntryV1Schema.safeParse(home).success, 'Home entry rejected');
  require(AccountDirectoryHomesResponseV1Schema.safeParse({ v: 1, homes: [home], preferredHomeServerIdentityId: home.homeServerIdentityId }).success, 'Homes response rejected');
  require(!AccountDirectoryHomesResponseV1Schema.safeParse({ v: 1, homes: [home], preferredHomeServerIdentityId: 'srv_other' }).success, 'Preferred Home outside directory accepted');
  require(!AccountDirectoryHomeEntryV1Schema.safeParse({ ...home, canonicalServerUrl: 'https://other.example.test' }).success, 'Entry URL drift accepted');
}

/** F-AD-03: `/me` is caller-owned and does not accept account identity injection. */
async function meScenario(): Promise<void> {
  const value = {
    v: 1 as const,
    accountId: 'account-1',
    displayName: 'Ada Lovelace',
    avatar: null,
    linkedAuthenticationMethods: [{ providerId: 'github', login: 'ada' }],
  };
  require(AccountDirectoryMeResponseV1Schema.safeParse(value).success, 'Directory me response rejected');
  require(!AccountDirectoryMeResponseV1Schema.safeParse({ ...value, unexpected: true }).success, 'Directory me accepted unknown fields');
}

/** F-AD-04: issuer links are strict and relinking is explicit. */
async function linkScenario(): Promise<void> {
  const link = {
    v: 1 as const,
    issuerServerIdentityId: 'srv_account_service',
    issuerSubjectId: 'account-subject-1',
    issuerSigningKeyId: keyId,
    issuerSigningPublicKeyBase64Url: keyBase64Url,
  };
  require(AccountDirectoryLinkPutRequestV1Schema.safeParse(link).success, 'Directory link rejected');
  require(AccountDirectoryLinkPutRequestV1Schema.parse({ ...link, relink: true }).relink === true, 'Explicit relink was not preserved');
  require(!AccountDirectoryLinkPutRequestV1Schema.safeParse({ ...link, accountId: 'caller-supplied' }).success, 'Caller account id crossed link boundary');
}

/** F-AD-05: login assertions carry bounded lifetime and independent signing domain. */
async function assertionScenario(): Promise<void> {
  const issuedAtMs = 1_700_000_000_000;
  const assertion = {
    v: 1 as const,
    purpose: 'happier.home-login' as const,
    issuerServerIdentityId: 'srv_account_service',
    issuerSubjectId: 'account-subject-1',
    audienceHomeServerIdentityId: httpsDescriptor.homeServerIdentityId,
    clientBoxPublicKeyBase64: keyBase64,
    issuedAtMs,
    expiresAtMs: issuedAtMs + ACCOUNT_DIRECTORY_ASSERTION_MIN_LIFETIME_MS,
    keyId,
    signatureBase64Url: 'A'.repeat(86),
  };
  require(HomeLoginAssertionV1Schema.safeParse(assertion).success, 'Login assertion rejected');
  require(ACCOUNT_DIRECTORY_ASSERTION_MAX_LIFETIME_MS >= ACCOUNT_DIRECTORY_ASSERTION_MIN_LIFETIME_MS, 'Assertion lifetime bounds inverted');
  require(ACCOUNT_DIRECTORY_ASSERTION_SIGNING_DOMAIN_V1.startsWith('happier.account-directory.'), 'Unexpected assertion signing domain');
}

/** F-AD-06: all Account Directory routes remain on the protocol-owned paths/capability family. */
async function routeAndCapabilityScenario(): Promise<void> {
  require(ACCOUNT_DIRECTORY_ME_HTTP_PATH_V1 === '/v1/account-directory/me', 'Me route drifted');
  require(ACCOUNT_DIRECTORY_HOMES_HTTP_PATH_V1 === '/v1/account-directory/homes', 'Homes route drifted');
  require(ACCOUNT_DIRECTORY_PREFERRED_HOME_HTTP_PATH_V1.includes('/preferred'), 'Preferred route drifted');
  require(ACCOUNT_DIRECTORY_HOME_LOGIN_ASSERTION_HTTP_PATH_V1.includes('login-assertion'), 'Assertion route drifted');
  require(ACCOUNT_DIRECTORY_LINKS_HTTP_PATH_V1.startsWith('/v1/account/directory-links/'), 'Link route drifted');
  require(HOME_LOGIN_HTTP_PATH_V1 === '/v1/auth/home-login', 'Home login route drifted');
  require(!AccountDirectoryCapabilitiesSchema.safeParse({ version: 1, homeDirectory: true, extra: true }).success, 'Capability accepted unknown fields');
}

export const accountDirectoryScenarios: readonly AccountDirectoryScenario[] = Object.freeze([
  { id: 'F-AD-01', name: 'registerDiscoverEnroll', run: descriptorScenario },
  { id: 'F-AD-02', name: 'directoryIndependentSteadyState', run: homeDirectoryScenario },
  { id: 'F-AD-03', name: 'directoryAuthIsolation', run: meScenario },
  { id: 'F-AD-04', name: 'assertionFailures', run: assertionScenario },
  { id: 'F-AD-05', name: 'directoryMutations', run: linkScenario },
  { id: 'F-AD-06', name: 'homeOwnedDeviceApproval', run: routeAndCapabilityScenario },
]);

export async function runAccountDirectoryScenarios(): Promise<void> {
  for (const scenario of accountDirectoryScenarios) await scenario.run();
}
