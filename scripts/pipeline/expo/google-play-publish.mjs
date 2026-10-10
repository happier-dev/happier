// @ts-check
import { createPrivateKey, sign } from 'node:crypto';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const PUBLISHER_URL = 'https://androidpublisher.googleapis.com/androidpublisher/v3';
const SCOPE = 'https://www.googleapis.com/auth/androidpublisher';

export class GooglePlayPublicationError extends Error {
  constructor(code, message, httpStatus) {
    super(message);
    this.name = 'GooglePlayPublicationError';
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

/** Validate before EAS uploads; never include credential bytes in errors. */
export function requireGooglePlayCredential(credentialJson) {
  if (typeof credentialJson !== 'string' || !credentialJson.trim()) {
    throw new GooglePlayPublicationError('missing_play_credential', 'GOOGLE_PLAY_SERVICE_ACCOUNT_JSON is required for production Android publication.');
  }
  try {
    const credential = JSON.parse(credentialJson);
    if (credential.type !== 'service_account' || typeof credential.client_email !== 'string' || !credential.client_email.trim()
      || typeof credential.private_key !== 'string' || !credential.private_key.trim()
      || (credential.token_uri !== undefined && credential.token_uri !== TOKEN_URL)) throw new Error('Invalid fields');
    const privateKey = createPrivateKey(credential.private_key);
    if (privateKey.asymmetricKeyType !== 'rsa') throw new Error('Expected RSA key');
    return { clientEmail: credential.client_email, privateKey, keyId: typeof credential.private_key_id === 'string' ? credential.private_key_id : undefined };
  } catch {
    throw new GooglePlayPublicationError('invalid_play_credential', 'GOOGLE_PLAY_SERVICE_ACCOUNT_JSON must contain a valid Google service-account RSA key.');
  }
}

export function requireGooglePlayVersionCode(value) {
  const versionCode = String(value ?? '');
  if (!/^[1-9]\d*$/u.test(versionCode)) {
    throw new GooglePlayPublicationError('invalid_play_version_code', 'An exact positive Android version code is required.');
  }
  return versionCode;
}

function invalidResponse(message) {
  throw new GooglePlayPublicationError('invalid_play_response', message);
}

/**
 * EAS remains the binary uploader. This owner changes only the exact draft release
 * in a Play edit, binding its approved notes and full rollout in one commit.
 * API basis: Android Publisher v3 edits.tracks/update/commit; OAuth service-account RS256.
 * @param {{packageName: string, versionCode: string, whatsNew: string, credentialJson: string, fetchImpl?: typeof fetch}} options
 */
export async function publishGooglePlayProduction(options) {
  const credential = requireGooglePlayCredential(options.credentialJson);
  const versionCode = requireGooglePlayVersionCode(options.versionCode);
  if (!/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/u.test(options.packageName)) {
    throw new GooglePlayPublicationError('invalid_play_package', 'An exact Android package name is required.');
  }
  if (typeof options.whatsNew !== 'string' || !options.whatsNew.trim() || options.whatsNew.length > 500) {
    throw new GooglePlayPublicationError('invalid_play_notes', 'The approved playStore.whatsNew projection is required (maximum 500 characters).');
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  async function request(url, init = {}) {
    let response;
    try { response = await fetchImpl(url, init); } catch {
      throw new GooglePlayPublicationError('play_transport_error', 'Google Play request failed; retry publication without re-uploading the binary.');
    }
    if (!response.ok) {
      throw new GooglePlayPublicationError('play_api_error', `Google Play request failed (HTTP ${response.status}); retry publication without re-uploading the binary.`, response.status);
    }
    if (response.status === 204) return null;
    try { return await response.json(); } catch { return invalidResponse('Google Play returned invalid JSON.'); }
  }
  const issuedAt = Math.floor(Date.now() / 1000);
  const encoded = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const unsigned = `${encoded({ alg: 'RS256', typ: 'JWT', ...(credential.keyId ? { kid: credential.keyId } : {}) })}.${encoded({
    iss: credential.clientEmail, scope: SCOPE, aud: TOKEN_URL, iat: issuedAt, exp: issuedAt + 3600,
  })}`;
  const assertion = `${unsigned}.${sign('RSA-SHA256', Buffer.from(unsigned), credential.privateKey).toString('base64url')}`;
  const token = await request(TOKEN_URL, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }).toString(),
  });
  if (typeof token?.access_token !== 'string' || !token.access_token) invalidResponse('Google OAuth returned no access token.');
  const headers = { Authorization: `Bearer ${token.access_token}`, 'Content-Type': 'application/json' };
  const base = `${PUBLISHER_URL}/applications/${encodeURIComponent(options.packageName)}/edits`;
  const edit = await request(base, { method: 'POST', headers, body: '{}' });
  if (typeof edit?.id !== 'string' || !edit.id) invalidResponse('Google Play returned no edit identity.');
  const editUrl = `${base}/${encodeURIComponent(edit.id)}`;
  const trackUrl = `${editUrl}/tracks/production`;
  const track = await request(trackUrl, { headers });
  if (track?.track !== 'production' || !Array.isArray(track.releases)) invalidResponse('Google Play returned an invalid production track.');
  const matching = track.releases.filter((release) => Array.isArray(release.versionCodes) && release.versionCodes.includes(versionCode));
  if (matching.length !== 1) {
    throw new GooglePlayPublicationError('play_version_not_found', 'The exact Android version must occur once on the production track before publication.');
  }
  const target = matching[0];
  if (target.versionCodes.length !== 1) {
    throw new GooglePlayPublicationError('ambiguous_play_release', 'The target release contains other Android versions; refusing to change their publication policy or notes.');
  }
  if (target.releaseNotes !== undefined && !Array.isArray(target.releaseNotes)) invalidResponse('Google Play returned invalid localized release notes.');
  const currentNotes = target.releaseNotes ?? [];
  const englishNotes = currentNotes.filter((note) => note.language === 'en-US');
  const alreadySubmitted = target.status === 'completed' && target.userFraction === undefined && target.countryTargeting === undefined
    && englishNotes.length === 1 && englishNotes[0].text === options.whatsNew;
  if (alreadySubmitted) {
    await request(editUrl, { method: 'DELETE', headers });
  } else {
    const { userFraction: _userFraction, countryTargeting: _countryTargeting, ...release } = target;
    // A full rollout replaces the track's prior releases; Play allows only one completed release.
    const releases = [{
      ...release, status: 'completed',
      releaseNotes: [...currentNotes.filter((note) => note.language !== 'en-US'), { language: 'en-US', text: options.whatsNew }],
    }];
    const updated = await request(trackUrl, { method: 'PUT', headers, body: JSON.stringify({ track: 'production', releases }) });
    const actual = updated?.releases?.find((entry) => entry.versionCodes?.includes(versionCode));
    if (updated?.track !== 'production' || actual?.status !== 'completed' || actual.userFraction !== undefined || actual.countryTargeting !== undefined
      || !actual.releaseNotes?.some((note) => note.language === 'en-US' && note.text === options.whatsNew)) {
      invalidResponse('Google Play did not accept the exact completed release and approved notes.');
    }
    const committed = await request(`${editUrl}:commit`, { method: 'POST', headers, body: '{}' });
    if (committed?.id !== edit.id) invalidResponse('Google Play did not acknowledge the committed edit.');
  }
  return {
    status: alreadySubmitted ? 'publication_already_submitted' : 'publication_submitted',
    packageName: options.packageName, versionCode, track: 'production', releaseStatus: 'completed', publicAvailability: 'unverified',
  };
}
