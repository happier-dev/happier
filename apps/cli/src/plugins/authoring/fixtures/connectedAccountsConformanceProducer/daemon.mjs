const PACKED_TEST_TOKEN = 'packed-test-token';

function diagnostic(code, message) {
  return { code, severity: 'error', message };
}

async function readToken(credentials) {
  return (await credentials.get('token'))?.trim() ?? '';
}

function selectRequestedValues(requested, values) {
  return Object.fromEntries(requested.flatMap((key) => (
    Object.prototype.hasOwnProperty.call(values, key) ? [[key, values[key]]] : []
  )));
}

function materializationFor(request, values) {
  if (request.kind === 'httpHeaders') {
    return {
      kind: 'httpHeaders',
      headers: selectRequestedValues(request.headerNames, values.headers ?? {}),
    };
  }
  if (request.kind === 'environment') {
    return {
      kind: 'environment',
      env: selectRequestedValues(request.keys, values.environment ?? {}),
    };
  }
  return {
    kind: 'files',
    files: Object.fromEntries(request.fileIds.flatMap((fileId) => {
      const value = values.files?.[fileId];
      return value === undefined ? [] : [[fileId, new TextEncoder().encode(value)]];
    })),
  };
}

function valuesForAccount(accountId, rotatingMaterialization) {
  switch (accountId) {
    case 'fixed':
      return {
        headers: { authorization: 'Bearer packed-header-secret' },
        environment: { FIXED_TOKEN: 'packed-environment-secret' },
        files: { credential: 'packed-file-secret' },
      };
    case 'alpha':
      return { environment: { GROUP_TOKEN: 'packed-group-alpha-secret' } };
    case 'beta':
      return { environment: { GROUP_TOKEN: 'packed-group-beta-secret' } };
    case 'replaceable-1':
      return { environment: { REPLACEABLE_TOKEN: 'packed-replacement-one-secret' } };
    case 'replaceable-2':
      return { environment: { REPLACEABLE_TOKEN: 'packed-replacement-two-secret' } };
    case 'revocable':
      return { environment: { REVOCABLE_TOKEN: 'packed-revocable-secret' } };
    case 'rotating':
      return {
        environment: {
          ROTATING_TOKEN: rotatingMaterialization === 1
            ? 'packed-materializer-one-secret'
            : 'packed-materializer-two-secret',
        },
      };
    default:
      return { environment: { TOKEN: 'packed-generic-secret' } };
  }
}

function createConformanceProducerRuntime(displayName) {
  let rotatingMaterializations = 0;

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
      const rotatingMaterialization = context.account.accountId === 'rotating'
        ? ++rotatingMaterializations
        : 0;
      return materializationFor(
        request,
        valuesForAccount(context.account.accountId, rotatingMaterialization),
      );
    },
  };
}

export async function activate(api) {
  api.connectedAccounts.register(
    'vault',
    createConformanceProducerRuntime('Acme Vault conformance account'),
  );
  api.connectedAccounts.register(
    'archive',
    createConformanceProducerRuntime('Acme Archive conformance account'),
  );
}
