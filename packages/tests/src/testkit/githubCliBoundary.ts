import { startConnectedAccountTlsRecordingProxy } from './providers/connectedAccountTlsRecordingProxy';

/** Only GitHub HTTPS is substituted. The installed gh, Git, process execution,
 * credential stores and Happier admission/materialization remain real. */
export async function startGithubCliBoundary() {
  const deviceCode = 'GH-TEST-1116';
  const verificationURI = 'https://github.com/login/device';
  const proxy = await startConnectedAccountTlsRecordingProxy({
    additionalDnsNames: ['github.com', 'api.github.com'],
    responseForRequest: request => {
      if (request.path === '/login/device/code') return { statusCode: 200, body: {
        device_code: 'constructed-device-attempt', user_code: deviceCode,
        verification_uri: verificationURI, expires_in: 900, interval: 5,
      } };
      if (request.path === '/login/oauth/access_token') return { statusCode: 200,
        body: { error: 'authorization_pending', error_description: 'Fixture waits for cancellation' } };
      if (request.path.startsWith('/team-setup/fixture.git/info/refs')) {
        if (!request.authorizationFingerprint) return { statusCode: 401, body: {},
          headers: { 'www-authenticate': 'Basic realm="GitHub fixture"' } };
        const serviceLine = '# service=git-upload-pack\n';
        return { statusCode: 200, body: null,
          headers: { 'content-type': 'application/x-git-upload-pack-advertisement' },
          rawBody: `${(Buffer.byteLength(serviceLine) + 4).toString(16).padStart(4, '0')}${serviceLine}00000000` };
      }
      if (request.path === '/user') return { statusCode: 200,
        headers: { 'x-oauth-scopes': 'repo, read:org, gist' },
        body: { login: 'team-setup-fixture', id: 1116, name: 'Team setup fixture' } };
      if (request.path === '/') return { statusCode: 200,
        headers: { 'x-oauth-scopes': 'repo, read:org, gist' },
        body: { current_user_url: 'https://api.github.com/user' } };
      if (request.path === '/graphql') return { statusCode: 200,
        headers: { 'x-oauth-scopes': 'repo, read:org, gist' },
        body: { data: { viewer: { login: 'team-setup-fixture' } } } };
      return { statusCode: 404, body: { message: 'External GitHub fixture endpoint unavailable' } };
    },
  });
  return { ...proxy, deviceCode, verificationURI, env: {
    HTTPS_PROXY: proxy.url, https_proxy: proxy.url, HTTP_PROXY: proxy.url,
    NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost',
    SSL_CERT_FILE: proxy.caCertPath, GIT_SSL_CAINFO: proxy.caCertPath,
  } };
}
