import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const testsDir = dirname(fileURLToPath(import.meta.url));
const moduleRoot = dirname(testsDir);
const repoRoot = dirname(dirname(dirname(dirname(moduleRoot))));
const expoNotificationsRoot = dirname(createRequire(import.meta.url).resolve('expo-notifications/package.json', {
  paths: [dirname(dirname(moduleRoot))],
}));

function read(...segments) {
  return readFileSync(join(...segments), 'utf8');
}

const protocolSource = read(repoRoot, 'packages', 'protocol', 'src', 'push', 'activityRemoteAlert.ts');
const protocolEventIdentitySource = read(repoRoot, 'packages', 'protocol', 'src', 'activity', 'eventIdentity.ts');
const kotlinSource = read(
  moduleRoot, 'android', 'src', 'main', 'java', 'dev', 'happier', 'activitynotifications', 'ActivityRemoteAlert.kt',
);
const swiftSource = read(moduleRoot, 'ios', 'notificationService', 'HappierActivityNotificationService.swift');
const swiftEventsSource = read(moduleRoot, 'ios', 'ActivityNotificationEvents.swift');
const indexSource = read(moduleRoot, 'index.ts');
const iosModuleSource = read(moduleRoot, 'ios', 'HappierActivityNotificationsModule.swift');
const androidModuleSource = read(
  moduleRoot, 'android', 'src', 'main', 'java', 'dev', 'happier', 'activitynotifications',
  'HappierActivityNotificationsModule.kt',
);
const swiftPreparedSource = read(moduleRoot, 'ios', 'ActivityPreparedContext.swift');
const kotlinPreparedSource = read(
  moduleRoot, 'android', 'src', 'main', 'java', 'dev', 'happier', 'activitynotifications', 'ActivityPreparedContext.kt',
);
const swiftEnricherSource = read(moduleRoot, 'ios', 'ActivityNotificationEnricher.swift');
const iosPodspec = read(moduleRoot, 'ios', 'HappierActivityNotifications.podspec');
const kotlinEnricherSource = read(
  moduleRoot, 'android', 'src', 'main', 'java', 'dev', 'happier', 'activitynotifications', 'ActivityNotificationEnricher.kt',
);
const installedExpoNotificationRecords = read(
  expoNotificationsRoot, 'ios', 'ExpoNotifications', 'Notifications',
  'NotificationRecords.swift',
);
const swiftSessionCryptoSource = read(
  dirname(moduleRoot), 'happier-crypto-worker', 'ios', 'HappierCryptoWorkerSessionCrypto.swift',
);
const kotlinSessionCryptoSource = read(
  dirname(moduleRoot), 'happier-crypto-worker', 'android', 'src', 'main', 'java', 'dev', 'happier', 'cryptoworker',
  'HappierCryptoWorkerSessionCrypto.kt',
);

function canonicalEventTypes() {
  const union = protocolSource.match(/ActivityRemoteAlertEventV1Schema = [\s\S]*?(?=export type ActivityRemoteAlertEventV1)/);
  assert.ok(union, 'canonical alert event union not found');
  return [...union[0].matchAll(/z\.literal\('([^']+)'\)/g)].map((match) => match[1]).filter((value) => value !== 'type').sort();
}

function quotedListAfter(source, marker) {
  const index = source.indexOf(marker);
  assert.ok(index >= 0, `missing ${marker}`);
  const line = source.slice(index, source.indexOf('\n', index));
  return [...line.matchAll(/"([^"]+)"/g)].map((match) => match[1]).sort();
}

/**
 * Renders a Kotlin or TypeScript string template with concrete values so the
 * identity a device would actually produce is compared, not the spelling of the
 * branch that produces it. `${a ?: b}` resolves to its first supplied operand,
 * mirroring the Kotlin elvis used by the replacement identity.
 */
function renderTemplate(template, fields) {
  return template.replace(/\$\{([^}]+)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (_, braced, bare) => {
    const expression = (braced ?? bare).trim();
    for (const candidate of expression.split('?:').map((part) => part.trim())) {
      if (fields[candidate] !== undefined && fields[candidate] !== null) return String(fields[candidate]);
    }
    return assert.fail(`unresolved template expression \`${expression}\``);
  });
}

function kotlinEventIdentityBlock() {
  const start = kotlinSource.indexOf('val eventIdentity: String?');
  const end = kotlinSource.indexOf('val canFetchSessionTranscriptPreview');
  assert.ok(start >= 0 && end > start, 'Android has no committed-event identity');
  return kotlinSource.slice(start, end);
}

function canonicalIdentityTemplate(owner) {
  const template = protocolEventIdentitySource
    .match(new RegExp(`export function ${owner}[\\s\\S]*?\\n\\}`))?.[0];
  assert.ok(template, `canonical identity owner ${owner} not found`);
  return [...template.matchAll(/`([^`]+)`/g)].map((match) => match[1]);
}

test('every consumer vocabulary matches the canonical alert categories', () => {
  const canonical = canonicalEventTypes();
  assert.ok(canonical.length > 0);
  assert.deepEqual(quotedListAfter(kotlinSource, 'SUPPORTED_EVENT_TYPES'), canonical);
  assert.deepEqual(quotedListAfter(swiftEventsSource, 'static let supported'), canonical);
  assert.match(indexSource, /ACTIVITY_NOTIFICATION_EVENTS\s*=\s*ACTIVITY_REMOTE_ALERT_EVENT_TYPES_V1/);
  // The extension derives its admission set from that one shared list rather
  // than keeping a second copy the capability can drift from.
  assert.match(swiftSource, /ActivityNotificationEvents\.supported/);
});

test('both native consumers key admission on the canonical payload discriminator', () => {
  const discriminator = protocolSource.match(/type: z\.literal\("?'?(activity_alert)'?"?\)/);
  assert.ok(discriminator, 'canonical payload discriminator not found');
  for (const [name, source] of [['kotlin', kotlinSource], ['swift', swiftSource]]) {
    assert.match(source, /"activity_alert"/, `${name} consumer does not check the payload discriminator`);
    assert.match(source, /(?:setOf\(1, 2\)|\[1, 2\]\.contains)/,
      `${name} consumer does not check the supported payload versions`);
  }
});

test('Android strictly parses only the serialized Expo data body without scalar coercion', () => {
  assert.match(kotlinSource, /remoteMessage\.data\["body"\]/);
  assert.doesNotMatch(kotlinSource, /optString\(/, 'JSONObject optString coerces numbers and booleans into strings');
  assert.doesNotMatch(kotlinSource, /opt(Int|Long)\(/, 'JSONObject numeric opt accessors accept numeric strings');
  assert.match(kotlinSource, /requiredPositiveInt\("messageSeq"\)/);
  assert.match(kotlinSource, /sequenceDomain/);
});

test('native preview admission requires an explicit main-transcript sequence domain', () => {
  for (const [name, source] of [['kotlin', kotlinSource], ['swift', swiftSource]]) {
    assert.match(source, /sequenceDomain/, `${name} does not parse the canonical sequence domain`);
    assert.match(source, /session_transcript/, `${name} does not positively admit the main transcript domain`);
  }
  for (const [name, source] of [['kotlin', kotlinEnricherSource], ['swift', swiftEnricherSource]]) {
    assert.match(source, /canFetchSessionTranscriptPreview/,
      `${name} does not gate the transcript fetch through the domain-aware alert owner`);
  }
});

test('native current Discussion references require the exact Discussion identity', () => {
  for (const [name, source] of [['kotlin', kotlinSource], ['swift', swiftSource]]) {
    assert.match(source, /discussionId/, `${name} does not parse the canonical Discussion identity`);
  }
  for (const [name, source] of [['kotlin', kotlinEnricherSource], ['swift', swiftEnricherSource]]) {
    assert.match(source, /discussions/, `${name} does not fetch through the exact Discussion route`);
    assert.match(source, /discussionId/, `${name} does not bind enrichment to the referenced Discussion`);
  }
});

test('native event identities distinguish equal sequences owned by different Discussions', () => {
  for (const [name, source] of [['kotlin', kotlinSource], ['swift', swiftSource]]) {
    assert.match(source, /eventIdentity/, `${name} has no exact committed-event identity`);
    assert.match(source, /discussionId/, `${name} omits the Discussion owner from event identity`);
    assert.match(source, /messageSeq/, `${name} omits the Discussion-local sequence from event identity`);
  }
  assert.match(kotlinSource, /replacementTag[\s\S]*eventIdentity/,
    'Android replacement still collapses distinct Discussion events');

  // The identity a device renders must equal the canonical Protocol owner's,
  // not merely mention the same fields.
  const rendered = {
    discussionId: 'discussion-a', 'reference.discussionId': 'discussion-a',
    messageSeq: 7, 'reference.sequence': 7,
  };
  assert.deepEqual(
    [...kotlinEventIdentityBlock().matchAll(/"(message-seq:[^"]+)"/g)]
      .map((match) => renderTemplate(match[1], rendered)).sort(),
    canonicalIdentityTemplate('resolveActivitySequenceEventIdentityV1')
      .map((template) => renderTemplate(template, rendered)).sort(),
  );
});

test('iOS keeps remote body-envelope admission separate from local top-level admission', () => {
  assert.match(swiftSource, /init\?\(remoteUserInfo:/);
  // `expo-notifications` hands iOS the Expo `body` envelope as a JSON object and
  // serializes it to a string only for the JS background representation, so the
  // remote initializer must admit the object shape this platform really receives.
  assert.match(installedExpoNotificationRecords, /userInfo\["body"\] as\? \[String: Any\]/,
    'expo-notifications no longer delivers the iOS body envelope as an object');
  assert.match(swiftSource, /remoteUserInfo\["body"\] as\? \[String: Any\]/,
    'the remote service rejects the object envelope iOS actually delivers');
  assert.match(swiftSource, /remoteUserInfo\["body"\] as\? String/);
  assert.match(swiftSource, /init\?\(localUserInfo:/);
  assert.match(swiftSource, /ActivityRemoteAlert\(remoteUserInfo: request\.content\.userInfo\)/);
  const remoteInitializer = swiftSource.slice(
    swiftSource.indexOf('init?(remoteUserInfo:'),
    swiftSource.indexOf('init?(localUserInfo:'),
  );
  assert.doesNotMatch(remoteInitializer, /payload\s*=\s*remoteUserInfo/,
    'the remote service must not fall back to a top-level local envelope');
});

test('the app-process pod excludes notification-service-only Swift sources', () => {
  const exclusionAssignment = iosPodspec.match(/s\.exclude_files\s*=\s*\[([\s\S]*?)\]/)?.[1] ?? '';
  const exclusions = [...exclusionAssignment.matchAll(/'([^']+)'/g)]
    .map((match) => match[1])
    .sort();

  assert.deepEqual(exclusions, [
    'ActivityNotificationEnricher.swift',
    'notificationService/**/*',
  ]);
});

test('neither native consumer fabricates alert copy', () => {
  // The Home submits generic copy that already passed the recipient's policy.
  // A literal title or body here would be a second content owner.
  for (const [name, source] of [['kotlin', kotlinSource], ['swift', swiftSource]]) {
    const presenter = name === 'kotlin'
      ? read(moduleRoot, 'android', 'src', 'main', 'java', 'dev', 'happier', 'activitynotifications', 'ActivityNotificationPresenter.kt')
      : source;
    assert.doesNotMatch(presenter, /\.(title|body)\s*=\s*["']/, `${name} consumer writes its own notification copy`);
  }
  assert.doesNotMatch(kotlinEnricherSource, /\.take\(\d+\)/, 'Android must not invent a native-only content limit');
  assert.doesNotMatch(swiftEnricherSource, /\.prefix\(\d+\)/, 'iOS must not invent a native-only content limit');
});

test('native capability is published only after strict exact-Home context is loaded', () => {
  assert.match(iosModuleSource, /ActivityPreparedContext\.load[\s\S]*?ActivityNotificationServiceExtension\.isBundled/);
  assert.match(iosModuleSource, /"platform":\s*"ios"/);
  assert.match(androidModuleSource, /ActivityPreparedContext\.load[\s\S]*?ActivityNotificationConsumer\.isInstalled[\s\S]*?null\s+else\s+mapOf/);
  assert.match(androidModuleSource, /"platform"\s+to\s+"android"/);
  for (const [name, source] of [['swift', swiftPreparedSource], ['kotlin', kotlinPreparedSource]]) {
    assert.match(source, /serverId/);
    assert.match(source, /accountId/);
    assert.match(source, /registrationId/);
    assert.match(source, /settingsVersion/);
    assert.match(source, /machineKey/);
    assert.match(source, /legacy_e2ee/);
    assert.match(source, /e2ee/);
  }
});

test('both native enrichers use the existing Session messages route and generic fallback', () => {
  for (const [name, source] of [['swift', swiftEnricherSource], ['kotlin', kotlinEnricherSource]]) {
    assert.match(source, /account\/encryption\/currentness|appendingPathComponent\("currentness"\)/,
      `${name} does not revalidate the prepared Account encryption generation`);
    assert.match(source, /accountEncryptionVersion/,
      `${name} does not bind enrichment to the prepared Account encryption version`);
    assert.match(source, /settingsVersion/,
      `${name} does not bind enrichment to the prepared Account settings version`);
    assert.match(source, /recipientEnvelopeReadiness/,
      `${name} does not revalidate recipient-envelope readiness`);
    assert.match(source, /\/v1\/sessions\/|appendingPathComponent\("sessions"\)/, `${name} does not use the Session owner`);
    assert.match(source, /Authorization/);
    assert.match(source, /Redirect|redirect/i, `${name} does not reject credential-bearing redirects`);
    assert.match(source, /include_preview/);
    assert.match(source, /accessProjectionVersion/);
    assert.match(source, /effectiveAccess/);
    assert.match(source, /readTranscript/);
    assert.match(source, /openSessionDataKey/);
    assert.match(source, /decryptSessionPayload/);
    assert.match(source, /metadataLayoutVersion/);
    assert.match(source, /summary/);
    assert.match(source, /title_only/);
    assert.match(source, /["(]content["\)]/, `${name} does not open the canonical raw-record content field`);
    assert.match(source, /["(]text["\)]/, `${name} does not reconstruct canonical text content`);
    assert.match(source, /return null|completion\(nil\)/, `${name} has no generic fallback`);
  }
});

test('both native enrichers require exact current settings before any rich content fetch', () => {
  assert.match(swiftEnricherSource,
    /exactInteger\(root\["settingsVersion"\]\)\s*==\s*prepared\.settingsVersion/);
  assert.match(kotlinEnricherSource,
    /root\.exactLong\("settingsVersion"\)\s*!=\s*prepared\.settingsVersion/);
});

test('both native enrichers suppress stale rich assignment content from the fetched Session projection', () => {
  for (const [name, source] of [['swift', swiftEnricherSource], ['kotlin', kotlinEnricherSource]]) {
    assert.match(source, /assigned/, `${name} has no assignment-specific currentness gate`);
    assert.match(source, /responsibleAccountId/, `${name} does not reuse current Session responsibility`);
    assert.match(source, /accountId/, `${name} does not bind responsibility to the alert recipient`);
  }
});

test('both native consumers re-admit prepared local policy after asynchronous enrichment', () => {
  // Account currentness is checked over the network, but device privacy and
  // credential custody can change locally while those requests are in flight.
  // Rich content may be applied only if the exact prepared generation is still
  // present immediately after enrichment completes.
  assert.match(swiftPreparedSource, /ActivityPreparedHomeContext:\s*Equatable/);
  assert.match(swiftSource,
    /ActivityPreparedContext\.home\([\s\S]*?serverId:\s*alert\.serverId[\s\S]*?accountId:\s*alert\.accountId[\s\S]*?\)\s*==\s*prepared/,
    'iOS applies an enrichment captured before a local privacy or credential mutation');
  assert.match(kotlinEnricherSource,
    /ActivityPreparedContext\.home\(context,\s*alert\.serverId,\s*alert\.accountId\)\s*==\s*prepared/,
    'Android returns an enrichment captured before a local privacy or credential mutation');
});

test('Discussion-local sequences cannot select unrelated Session transcript preview content', () => {
  assert.match(swiftEnricherSource, /canFetchSessionTranscriptPreview/);
  assert.match(kotlinEnricherSource, /canFetchSessionTranscriptPreview/);
  const swiftEvents = swiftSource.match(
    /var canFetchSessionTranscriptPreview: Bool[\s\S]*?\[([^\]]+)\]\.contains\(eventType\)/,
  )?.[1];
  const kotlinEvents = kotlinSource.match(
    /val canFetchSessionTranscriptPreview: Boolean[\s\S]*?eventType in setOf\(([^)]+)\)/,
  )?.[1];
  for (const [name, events] of [['swift', swiftEvents], ['kotlin', kotlinEvents]]) {
    assert.ok(events, `${name} has no explicit Session-transcript preview event set`);
    assert.deepEqual([...events.matchAll(/"([^"]+)"/g)].map((match) => match[1]).sort(), [
      'human_message', 'message', 'ready',
    ]);
  }
});

test('notification processes reuse the canonical native Session crypto owner', () => {
  for (const [name, source] of [['swift', swiftSessionCryptoSource], ['kotlin', kotlinSessionCryptoSource]]) {
    assert.match(source, /openSessionDataKey/,
      `${name} has no public canonical recipient-envelope opener`);
    assert.match(source, /decryptSessionPayload/,
      `${name} has no public canonical Session-payload opener`);
    assert.match(source, /decryptDataKeyEnvelopeV1Batch/,
      `${name} reimplemented the recipient-envelope cipher`);
    assert.match(source, /decryptSecretboxJsonBatch/,
      `${name} reimplemented the Session payload cipher`);
  }
});

const kotlinWakeSource = read(
  moduleRoot, 'android', 'src', 'main', 'java', 'dev', 'happier', 'activitynotifications', 'SessionChangedWake.kt',
);
const kotlinHandoffSource = read(
  moduleRoot, 'android', 'src', 'main', 'java', 'dev', 'happier', 'activitynotifications',
  'ActivityNotificationMainProcessHandoff.kt',
);
const protocolWakeSource = read(repoRoot, 'packages', 'protocol', 'src', 'push', 'sessionChangedWake.ts');

test('the Android wake consumer keys on the canonical Protocol wake discriminator', () => {
  const canonical = protocolWakeSource.match(/SESSION_CHANGED_WAKE_TYPE = '([^']+)'/)?.[1];
  assert.ok(canonical, 'canonical wake discriminator not found');
  const native = kotlinWakeSource.match(/TYPE = "([^"]+)"/)?.[1];
  assert.equal(native, canonical, 'Android admits a different wake type than the Protocol owner');
  // Strictness is behavioral, not a spelling: the admitted field set must stay
  // exactly the canonical one, so no content field can ride into the app process.
  const canonicalFields = [...protocolWakeSource
    .matchAll(/^\s{2}(\w+):/gm)].map((match) => match[1]).sort();
  assert.deepEqual(canonicalFields, ['alert', 'serverId', 'sessionId', 'type']);
  assert.deepEqual(
    [...kotlinWakeSource.matchAll(/setOf\("type", "serverId", "sessionId", "alert"\)/g)].length, 1,
  );
});

test('the app-process wake arm binds to real expo-notifications entry points', () => {
  // The handoff runs the incumbent delegate's task arm and nothing else, so a
  // content-free wake reaches the registered JS consumer without presenting.
  assert.match(kotlinHandoffSource, /FirebaseMessagingDelegate\.runTaskManagerTasks\(/);
  assert.match(kotlinHandoffSource, /RemoteMessageSerializer\.toBundle\(/);
  const delegate = read(
    expoNotificationsRoot, 'android', 'src', 'main', 'java',
    'expo', 'modules', 'notifications', 'service', 'delegates', 'FirebaseMessagingDelegate.kt',
  );
  assert.match(delegate, /fun runTaskManagerTasks\(applicationContext: Context, bundle: Bundle\)/,
    'expo-notifications no longer exposes the background-task arm this handoff calls');
  const serializer = read(
    expoNotificationsRoot, 'android', 'src', 'main', 'java',
    'expo', 'modules', 'notifications', 'notifications', 'RemoteMessageSerializer.java',
  );
  assert.match(serializer, /public static @NonNull Bundle toBundle\(RemoteMessage message\)/,
    'expo-notifications no longer exposes the canonical message serializer this handoff uses');
  // The serialized shape the JS wake consumer reads: the Expo data bag arrives
  // with the payload JSON under `dataString`.
  assert.match(serializer, /serializedData\.putString\("dataString", data\.getOrDefault\("body", null\)\)/);
});
