// Official Antigravity ACP 1.3.0 consumer OAuth contract (ccpa_connection/oauth_manager.py).
// The registered paste-code callback was observed from the native Antigravity CLI 1.3.1.
export const AGY_OAUTH_CLIENT_ID =
  '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com';
// Installed-app client secret distributed by the provider; this is not an account credential.
export const AGY_OAUTH_CLIENT_SECRET = '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';
export const AGY_OAUTH_AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const AGY_OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const AGY_OAUTH_CALLBACK_URL = 'https://antigravity.google/oauth-callback';
export const AGY_OAUTH_USERINFO_URL = 'https://www.googleapis.com/oauth2/v3/userinfo';
export const AGY_OAUTH_SCOPES = Object.freeze([
  'https://www.googleapis.com/auth/cloud-platform',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/aicode',
]);

// The registered manual callback displays a code; the current PKCE attempt binds its exchange.
export const AGY_OAUTH_ALLOW_RAW_AUTHORIZATION_CODE = true;
