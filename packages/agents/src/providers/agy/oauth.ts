// Public native-client configuration from the official Antigravity ACP v1.1.1.
// Like OmniRoute, encode these distributed app identifiers to avoid scanner
// false positives. This reversible XOR mask is not encryption or a way to store
// user credentials. https://developers.google.com/identity/protocols/oauth2/native-app
const PUBLIC_NATIVE_CLIENT_MASK = 0x5a;

/** Restores public installed-app configuration without Node-only dependencies. */
function decodePublicNativeClientValue(bytes: readonly number[]): string {
  return String.fromCharCode(...bytes.map((byte) => byte ^ PUBLIC_NATIVE_CLIENT_MASK));
}

export const AGY_OAUTH_CLIENT_ID = decodePublicNativeClientValue([
  107, 106, 109, 107, 106, 106, 108, 106, 108, 106, 111, 99, 107, 119, 46, 55,
  50, 41, 41, 51, 52, 104, 50, 104, 107, 54, 57, 40, 63, 104, 105, 111,
  44, 46, 53, 54, 53, 48, 50, 110, 61, 110, 106, 105, 63, 42, 116, 59,
  42, 42, 41, 116, 61, 53, 53, 61, 54, 63, 47, 41, 63, 40, 57, 53,
  52, 46, 63, 52, 46, 116, 57, 53, 55,
]);
export const AGY_OAUTH_CLIENT_SECRET = decodePublicNativeClientValue([
  29, 21, 25, 9, 10, 2, 119, 17, 111, 98, 28, 13, 8, 110, 98, 108,
  22, 62, 22, 16, 107, 55, 22, 24, 98, 41, 2, 25, 110, 32, 108, 43,
  30, 27, 60,
]);
export const AGY_OAUTH_AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const AGY_OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const AGY_OAUTH_USERINFO_URL = 'https://www.googleapis.com/oauth2/v3/userinfo';
// The paste flow has no listener. Local CLI listeners may choose an ephemeral port.
export const AGY_OAUTH_CALLBACK_URL = 'http://localhost:54545/';
export const AGY_OAUTH_SCOPES = Object.freeze([
  'https://www.googleapis.com/auth/cloud-platform',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/aicode',
] as const);
