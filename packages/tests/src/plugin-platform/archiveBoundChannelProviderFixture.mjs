const STATIC_FIXTURE_ORIGIN = 'https://channels-fixture.invalid';
const STATIC_FIXTURE_SOCKET_ORIGIN = 'wss://channels-fixture.invalid';
const FIXTURE_NETWORK_ACCESS_ID = 'fixture-network-client';
const LOOPBACK_HOSTNAME = '127.0.0.1';
const SETUP_TRANSIENT_HANDOFF_MARKER =
  '  // Setup validates the transient handoff but deliberately does not retain it.';

function assertFixture(value, code) {
  if (!value) throw new Error(code);
}

function record(value, code) {
  assertFixture(
    value !== null && typeof value === 'object' && !Array.isArray(value),
    code,
  );
  return value;
}

function parseLoopbackOrigin(value) {
  assertFixture(typeof value === 'string', 'packed_channel_provider_loopback_origin_not_string');
  const parsed = new URL(value);
  const port = Number.parseInt(parsed.port, 10);
  assertFixture(
    parsed.protocol === 'https:'
      && parsed.hostname === LOOPBACK_HOSTNAME
      && Number.isInteger(port)
      && port > 0
      && port <= 65_535
      && parsed.username.length === 0
      && parsed.password.length === 0
      && (parsed.pathname === '' || parsed.pathname === '/')
      && parsed.search.length === 0
      && parsed.hash.length === 0,
    'packed_channel_provider_loopback_origin_invalid',
  );
  return parsed.origin;
}

function parseStrictResultSentinel(value) {
  if (value === undefined) return null;
  assertFixture(
    typeof value === 'string'
      && value.length > 0
      && value.length <= 256,
    'packed_channel_provider_strict_result_sentinel_invalid',
  );
  return value;
}

function bindFixtureSource(source, origin, strictResultSentinel) {
  assertFixture(
    typeof source === 'string' && source.includes(STATIC_FIXTURE_ORIGIN),
    'packed_channel_provider_fixture_source_origin_missing',
  );
  const scopePattern = /scope: \{\n        targets: \[\{ kind: 'fixedOrigin', origin: FIXTURE_ORIGIN \}\],\n        transports: \['websocket'\],(?:\n        privateNetwork: (?:true|false),)?\n      \},/gu;
  const scopeMatches = source.match(scopePattern) ?? [];
  assertFixture(
    scopeMatches.length === 1,
    'packed_channel_provider_fixture_source_network_access_missing',
  );
  const strictResultBranch = strictResultSentinel === null
    ? ''
    : `  if (input.pairingCode === ${JSON.stringify(strictResultSentinel)}) return {};\n`;
  assertFixture(
    source.includes(SETUP_TRANSIENT_HANDOFF_MARKER),
    'packed_channel_provider_fixture_setup_marker_missing',
  );
  const bound = source
    .replaceAll(STATIC_FIXTURE_SOCKET_ORIGIN, `wss://${new URL(origin).host}`)
    .replaceAll(STATIC_FIXTURE_ORIGIN, origin)
    .replace(SETUP_TRANSIENT_HANDOFF_MARKER, `${strictResultBranch}${SETUP_TRANSIENT_HANDOFF_MARKER}`)
    .replace(scopePattern, [
      'scope: {',
      "        targets: [{ kind: 'fixedOrigin', origin: FIXTURE_ORIGIN }],",
      "        transports: ['websocket'],",
      '        privateNetwork: true,',
      '      },',
    ].join('\n'));
  assertFixture(
    !bound.includes(STATIC_FIXTURE_ORIGIN)
      && !bound.includes(STATIC_FIXTURE_SOCKET_ORIGIN),
    'packed_channel_provider_fixture_source_origin_replacement_incomplete',
  );
  return bound;
}

function replaceFixtureOrigins(value, origin) {
  if (typeof value === 'string') {
    return value
      .replaceAll(STATIC_FIXTURE_SOCKET_ORIGIN, `wss://${new URL(origin).host}`)
      .replaceAll(STATIC_FIXTURE_ORIGIN, origin);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => replaceFixtureOrigins(entry, origin));
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
      key,
      replaceFixtureOrigins(entry, origin),
    ]));
  }
  return value;
}

function bindFixtureManifest(manifest, origin) {
  const root = record(
    replaceFixtureOrigins(manifest, origin),
    'packed_channel_provider_fixture_manifest_invalid',
  );
  const hostAccess = record(
    root.hostAccess,
    'packed_channel_provider_fixture_manifest_host_access_missing',
  );
  assertFixture(
    Array.isArray(hostAccess.required),
    'packed_channel_provider_fixture_manifest_required_access_missing',
  );
  const accessIndex = hostAccess.required.findIndex((candidate) => (
    record(candidate, 'packed_channel_provider_fixture_manifest_access_invalid').id
      === FIXTURE_NETWORK_ACCESS_ID
  ));
  assertFixture(
    accessIndex >= 0,
    'packed_channel_provider_fixture_manifest_network_access_missing',
  );
  const required = hostAccess.required.map((candidate, index) => {
    if (index !== accessIndex) return candidate;
    const request = record(
      candidate,
      'packed_channel_provider_fixture_manifest_access_invalid',
    );
    const scope = record(
      request.scope,
      'packed_channel_provider_fixture_manifest_network_scope_missing',
    );
    return {
      ...request,
      scope: {
        ...scope,
        targets: [{ kind: 'fixedOrigin', origin }],
        transports: ['websocket'],
        privateNetwork: true,
      },
    };
  });
  return {
    ...root,
    hostAccess: {
      ...hostAccess,
      required,
    },
  };
}

/**
 * Produces the only archive-local mutation needed by C9. The committed
 * out-of-tree fixture remains a public `.invalid` artifact; the reviewed
 * archive gets one ephemeral TLS loopback authority in both its executable
 * source and its serialized manifest.
 */
export function createArchiveBoundPackedChannelProviderFixture(input) {
  const origin = parseLoopbackOrigin(input?.origin);
  const strictResultSentinel = parseStrictResultSentinel(
    input?.strictResultSentinel,
  );
  return Object.freeze({
    source: bindFixtureSource(input?.source, origin, strictResultSentinel),
    manifest: bindFixtureManifest(input?.manifest, origin),
  });
}
