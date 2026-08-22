const PACKED_TEST_TOKEN = 'packed-test-token';

function diagnostic(code, message) {
  return { code, severity: 'error', message };
}

async function readToken(credentials) {
  return (await credentials.get('token'))?.trim() ?? '';
}

function materializationFor(request) {
  if (request.kind === 'httpHeaders') {
    return {
      kind: 'httpHeaders',
      headers: Object.fromEntries(request.headerNames.map((name) => [name, ''])),
    };
  }
  if (request.kind === 'environment') {
    return {
      kind: 'environment',
      env: Object.fromEntries(request.keys.map((key) => [key, ''])),
    };
  }
  return {
    kind: 'files',
    files: Object.fromEntries(request.fileIds.map((fileId) => [fileId, new Uint8Array()])),
  };
}

function createCollisionPeerRuntime(displayName) {
  async function readHealth(credentials) {
    return await readToken(credentials) === PACKED_TEST_TOKEN
      ? { status: 'connected', displayName, scopes: [] }
      : {
          status: 'unavailable',
          diagnostic: diagnostic(
            'packed_test_token_unavailable',
            'The packed Connected Accounts conformance token is unavailable.',
          ),
        };
  }

  return {
    authentication: {
      modes: {
        manual: {
          kind: 'manual',
          async complete(input, context) {
            const token = input.fields.token?.trim() ?? '';
            if (!token) {
              return {
                status: 'rejected',
                diagnostic: diagnostic(
                  'packed_test_token_invalid',
                  'The packed Connected Accounts conformance token is required.',
                ),
              };
            }
            await context.attemptCredentials.set('token', token);
            return {
              status: 'connected',
              ...(context.attempt.kind === 'reconnect'
                ? { accountId: context.attempt.account.accountId }
                : {}),
              displayName,
              scopes: [],
            };
          },
        },
      },
    },
    async refresh(context) {
      return await readHealth(context.credentials);
    },
    async revoke() {
      return { status: 'remoteUnsupported' };
    },
    async status(context) {
      return await readHealth(context.credentials);
    },
    async materialize(request, context) {
      if (await readToken(context.credentials) !== PACKED_TEST_TOKEN) {
        throw new Error('Packed Connected Accounts conformance credentials are unavailable');
      }
      return materializationFor(request);
    },
  };
}

export async function activate(api) {
  api.connectedAccounts.register(
    'vault',
    createCollisionPeerRuntime('Collision Peer Vault account'),
  );
}
