import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { tmpdir } from 'node:os';
import { dirname, join as joinPath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCipheriv } from 'node:crypto';
import { parseSessionChangedWakeV1} from '@happier-dev/protocol/push/sessionChangedWake';
import { resolveActivityRemoteAlertEventIdentity, resolveActivityRemoteAlertEventForPersonalEventV2 } from '@happier-dev/protocol/push/activityRemoteAlert';

const testsDir = dirname(fileURLToPath(import.meta.url));
const moduleRoot = dirname(testsDir);
const kotlinAlertSource = joinPath(
  moduleRoot, 'android', 'src', 'main', 'java', 'dev', 'happier', 'activitynotifications', 'ActivityRemoteAlert.kt',
);

const SERVER_ID = 'srv-1';
const SESSION_ID = 'sess-1';
const ACCOUNT_ID = 'acc-1';

function alertPayload(version, event) {
  return {
    type: 'activity_alert',
    v: version,
    serverId: SERVER_ID,
    sessionId: SESSION_ID,
    accountId: ACCOUNT_ID,
    event,
    previewBehavior: 'title_only',
  };
}

function wireBody(version, event) {
  return JSON.stringify(alertPayload(version, event));
}

// One committed Home/Session observed through materially distinct terminal
// turns plus the neighboring sequence/category references whose identities
// this lane must not change.
const scenarios = [
  { id: 'v2_request_turnA', body: wireBody(2, resolveActivityRemoteAlertEventForPersonalEventV2('permission_required', undefined, 'turn-AAA', 'req:😀')) },
  { id: 'v2_request_turnB', body: wireBody(2, resolveActivityRemoteAlertEventForPersonalEventV2('permission_required', undefined, 'turn-BBB', 'req:😀')) },
  { id: 'v2_user_action_turnA', body: wireBody(2, resolveActivityRemoteAlertEventForPersonalEventV2('user_action_required', undefined, 'turn-AAA', 'req:😀')) },
  { id: 'v2_request_legacy', body: wireBody(2, { type: 'permission_request', requestId: 'req:😀' }) },
  { id: 'v2_stalled_turnA', body: wireBody(2, { type: 'source_unavailable', stalledOccurrence: { turnId: 'turn-AAA', publisherFence: 123 } }) },
  { id: 'v2_stalled_turnA_restall', body: wireBody(2, { type: 'source_unavailable', stalledOccurrence: { turnId: 'turn-AAA', publisherFence: 124 } }) },
  { id: 'v2_failed_turnA', body: wireBody(2, { type: 'failed', turnId: 'turn-AAA' }) },
  { id: 'v2_failed_turnB', body: wireBody(2, { type: 'failed', turnId: 'turn-BBB' }) },
  { id: 'v2_cancelled_turnC', body: wireBody(2, { type: 'cancelled', turnId: 'turn-CCC' }) },
  { id: 'v1_failed_turnA', body: wireBody(1, { type: 'failed', turnId: 'turn-AAA' }) },
  { id: 'v2_ready_seq42', body: wireBody(2, { type: 'ready', sequenceDomain: 'session_transcript', messageSeq: 42 }) },
  {
    id: 'v2_discussion_mention_seq7',
    body: wireBody(2, { type: 'discussion_mention', sequenceDomain: 'discussion', discussionId: 'disc-1', messageSeq: 7 }),
  },
  { id: 'v1_human_message_seq9', body: wireBody(1, { type: 'human_message', messageSeq: 9 }) },
  { id: 'v2_failed_without_turn', body: wireBody(2, { type: 'failed' }) },
];

const UNPARSED_SCENARIO = 'v2_failed_without_turn';
// Released V1 sequenced references retain the category-grouping fallback on
// the native Android leg; this lane freezes that behavior unchanged. Protocol
// still derives `legacy-message-seq:` for them, so no canonical identity is
// asserted for this scenario's tag.
const FROZEN_V1_SEQUENCED_SCENARIO = 'v1_human_message_seq9';

function canonicalIdentity(scenarioId) {
  const scenario = scenarios.find((candidate) => candidate.id === scenarioId);
  return resolveActivityRemoteAlertEventIdentity(JSON.parse(scenario.body)) ?? null;
}

function firstFileByPrefix(directory, prefix) {
  const found = readdirSync(directory).find((name) => name.startsWith(prefix) && name.endsWith('.jar'));
  return found ? join(directory, found) : null;
}

/** Local Gradle distribution toolchain used to execute the real Kotlin parser on the JVM. */
function discoverKotlinToolchain() {
  const distsRoot = join(process.env.HOME ?? '', '.gradle', 'wrapper', 'dists');
  if (!existsSync(distsRoot)) return null;
  for (const dist of readdirSync(distsRoot)) {
    if (!dist.startsWith('gradle-')) continue;
    const distPath = join(distsRoot, dist);
    for (const hash of readdirSync(distPath)) {
      const hashPath = join(distPath, hash);
      for (const gradle of readdirSync(hashPath)) {
        if (!gradle.startsWith('gradle-')) continue;
        const lib = join(hashPath, gradle, 'lib');
        if (!existsSync(lib)) continue;
        const compiler = firstFileByPrefix(lib, 'kotlin-compiler-embeddable-');
        const stdlib = firstFileByPrefix(lib, 'kotlin-stdlib-');
        const serializationCore = firstFileByPrefix(lib, 'kotlinx-serialization-core-jvm-');
        const serializationJson = firstFileByPrefix(lib, 'kotlinx-serialization-json-jvm-');
        if (compiler && stdlib && serializationCore && serializationJson) {
          // The compiler JVM launches with the distribution's full lib
          // classpath, exactly like the Gradle launcher does.
          const compilerJars = readdirSync(lib).filter((name) => name.endsWith('.jar')).map((name) => join(lib, name));
          return { compilerJars, runtimeJars: [stdlib, serializationCore, serializationJson] };
        }
      }
    }
  }
  return null;
}

// JVM stand-in for the Android platform JSON runtime boundary (org.json is an
// OS-provided runtime class, not repo-internal logic). Backed by the real
// kotlinx JSON parser so payload shapes are parsed, not assumed.
const jsonRuntimeStub = `
package org.json

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import java.math.BigDecimal

class JSONException(message: String) : Exception(message)

class JSONObject(private val raw: String = "{}") {
  private val values: MutableMap<String, Any?> = LinkedHashMap()

  init {
    val element = try {
      Json.parseToJsonElement(raw)
    } catch (failure: Throwable) {
      throw JSONException("malformed JSON: \${failure.message}")
    }
    if (element !is JsonObject) throw JSONException("payload is not a JSON object")
    for ((key, value) in element) values[key] = convert(value)
  }

  fun opt(key: String): Any? = values[key]

  fun getString(key: String): String = values[key] as? String
    ?: throw JSONException("expected string value for key")

  fun has(key: String): Boolean = values.containsKey(key)

  fun keys(): Iterator<String> = values.keys.iterator()
  fun isNull(key: String): Boolean = values[key] == null
  fun getBoolean(key: String): Boolean = values[key] as Boolean
  fun optJSONArray(key: String): JSONArray? = values[key] as? JSONArray
  fun put(key: String, value: Any?): JSONObject { values[key] = value; return this }
  override fun toString(): String = raw

  private fun convert(value: JsonElement): Any? = when (value) {
    is JsonNull -> null
    is JsonObject -> JSONObject(value.toString())
    is JsonArray -> JSONArray(value.map { convert(it) })
    is JsonPrimitive -> if (value.isString) value.content else scalar(value.content)
  }

  private fun scalar(content: String): Any = when {
    content == "true" -> true
    content == "false" -> false
    content.contains('.') || content.contains('e') || content.contains('E') -> content.toDouble()
    else -> try {
      content.toLong()
    } catch (failure: NumberFormatException) {
      BigDecimal(content)
    }
  }
}
class JSONArray(private val values: List<Any?>) {
  fun length(): Int = values.size
  fun opt(index: Int): Any? = values.getOrNull(index)
}
`;

// JVM stand-in for the Firebase messaging transport boundary.
const firebaseStub = `
package com.google.firebase.messaging

class RemoteMessage(val data: Map<String, String>)
`;

// Executes the real [ActivityRemoteAlert.parse] entry point against canonical
// wire payloads and prints one result line per scenario:
// "<body>|<parsed|unparsed>|<replacementTag|->|<eventIdentity|->".
// The node:test owner compares these against the canonical Protocol identity.
const probeSource = `
package dev.happier.activitynotifications

import com.google.firebase.messaging.RemoteMessage
import org.json.JSONObject

fun main() {
  val input = JSONObject(readlnOrNull() ?: error("missing scenario input"))
  for (key in sortedScenarioKeys(input)) {
    val body = input.getString(key)
    val parsed = ActivityRemoteAlert.parse(RemoteMessage(mapOf("body" to body)))
    println(
      listOf(
        body,
        if (parsed == null) "unparsed" else "parsed",
        parsed?.replacementTag ?: "-",
        parsed?.eventIdentity ?: "-",
      ).joinToString("|"),
    )
  }
}

private fun sortedScenarioKeys(input: JSONObject): List<String> =
  buildList {
    val keys = input.keys()
    while (keys.hasNext()) add(keys.next())
  }.sorted()
`;

test('Android remote alert requests keep distinct terminal turns distinct exactly like Protocol', async (t) => {
  const toolchain = discoverKotlinToolchain();
  if (!toolchain) {
    t.skip('local Kotlin toolchain (Gradle distribution) unavailable; the behavioral native identity gate needs it');
    return;
  }

  // Canonical Protocol identities are computed at test time by the owner;
  // they are never re-declared here.
  const expected = new Map(scenarios.map((scenario) => [scenario.id, {
    identity: canonicalIdentity(scenario.id),
    status: scenario.id === UNPARSED_SCENARIO ? 'unparsed' : 'parsed',
  }]));
  assert.ok(
    [...expected.values()].filter((expectation) => expectation.identity).length >= 6,
    'the canonical Protocol owner must derive identities for the committed references under test',
  );

  const work = mkdtempSync(join(tmpdir(), 'activity-alert-turn-identity-'));
  let stdout;
  try {
    const jsonStub = join(work, 'OrgJsonStub.kt');
    const firebaseStubFile = join(work, 'FirebaseStub.kt');
    const probeFile = join(work, 'TurnIdentityProbe.kt');
    writeFileSync(jsonStub, jsonRuntimeStub);
    writeFileSync(firebaseStubFile, firebaseStub);
    writeFileSync(probeFile, probeSource);
    const classes = join(work, 'classes');
    execFileSync(
      'java',
      [
        '-cp', toolchain.compilerJars.join(delimiter),
        'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler',
        '-classpath', toolchain.runtimeJars.join(delimiter),
        '-no-stdlib',
        '-d', classes,
        '-nowarn',
        kotlinAlertSource, jsonStub, firebaseStubFile, probeFile,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );

    const scenarioInput = {};
    for (const scenario of scenarios) scenarioInput[scenario.id] = scenario.body;
    stdout = execFileSync(
      'java',
      ['-cp', [classes, ...toolchain.runtimeJars].join(delimiter), 'dev.happier.activitynotifications.TurnIdentityProbeKt'],
      { input: JSON.stringify(scenarioInput), encoding: 'utf8' },
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }

  const observed = new Map(
    stdout.trim().split('\n').filter(Boolean).map((line) => {
      const [body, status, tag, identity] = line.split('|');
      const scenario = scenarios.find((candidate) => candidate.body === body);
      assert.ok(scenario, `probe returned an unknown scenario body: ${body}`);
      return [scenario.id, { status, tag, identity }];
    }),
  );

  for (const scenario of scenarios) {
    const row = observed.get(scenario.id);
    assert.ok(row, `missing probe result for ${scenario.id}`);
    assert.equal(row.status, expected.get(scenario.id).status, `${scenario.id} strict admission`);
  }

  const tag = (id) => observed.get(id).tag;
  const identityOf = (id) => {
    const identity = observed.get(id).identity;
    assert.notEqual(identity, undefined, `${id} probe output`);
    return identity === '-' ? null : identity;
  };

  // The canonical Protocol owner decides every expected identity; native
  // replacement tags must embed exactly that identity.
  for (const scenario of scenarios) {
    if (scenario.id === UNPARSED_SCENARIO) continue;
    const expectation = expected.get(scenario.id);
    if (scenario.id === FROZEN_V1_SEQUENCED_SCENARIO) {
      assert.equal(identityOf(scenario.id), null, `${scenario.id} native identity stays frozen`);
      assert.equal(tag(scenario.id), `activity_alert:${SERVER_ID}:${SESSION_ID}:human_message`);
      continue;
    }
    assert.ok(expectation.identity, `${scenario.id} has no canonical Protocol identity`);
    assert.equal(identityOf(scenario.id), expectation.identity,
      `${scenario.id} native identity must equal Protocol`);
    assert.equal(tag(scenario.id), `activity_alert:${SERVER_ID}:${SESSION_ID}:${expectation.identity}`,
      `${scenario.id} replacement tag must embed the canonical Protocol identity`);
  }

  // Distinct terminal turns on the same Home/Session are distinct Android
  // notification requests: neither the failed nor the cancelled category
  // collapses them.
  assert.notEqual(tag('v2_request_turnA'), tag('v2_request_turnB'));
  assert.equal(identityOf('v2_request_turnA'), 'request-turn:6:req:😀:8:turn-AAA');
  assert.equal(tag('v2_request_turnA'), tag('v2_user_action_turnA'));
  assert.equal(identityOf('v2_request_legacy'), 'request:req:😀');
  assert.notEqual(tag('v2_failed_turnA'), tag('v2_failed_turnB'));
  assert.notEqual(tag('v2_failed_turnA'), tag('v2_cancelled_turnC'));
  assert.notEqual(tag('v2_failed_turnB'), tag('v2_cancelled_turnC'));
  // Canonical turn identity is version-independent, exactly like Protocol.
  assert.equal(tag('v1_failed_turnA'), tag('v2_failed_turnA'));
  // Message/discussion neighbors stay distinguishable and distinct from
  // terminal turns.
  assert.notEqual(tag('v2_ready_seq42'), tag('v2_discussion_mention_seq7'));
  assert.notEqual(tag('v2_ready_seq42'), tag('v2_failed_turnA'));
});

const kotlinWakeSource = joinPath(
  moduleRoot, 'android', 'src', 'main', 'java', 'dev', 'happier', 'activitynotifications', 'SessionChangedWake.kt',
);

test('Android Machine alerts reach native presentation with one Account-bound replacement identity', (t) => {
  const toolchain = discoverKotlinToolchain();
  if (!toolchain) {
    t.skip('Kotlin toolchain unavailable; Machine native presentation requires the JVM gate');
    return;
  }
  const work = mkdtempSync(join(tmpdir(), 'happier-machine-alert-'));
  const androidDir = dirname(kotlinAlertSource);
  const transport = `
package com.google.firebase.messaging
import android.os.Bundle
class RemoteMessage(extras: Bundle) {
  val data = extras.values.filterKeys { !it.startsWith("gcm.n.") }.mapValues { it.value as String }
  val notification = if (extras.values["gcm.n.e"] == "1") Notification(extras) else null
  class Notification(extras: Bundle) {
    val title = extras.values["gcm.n.title"] as? String
    val body = extras.values["gcm.n.body"] as? String
    val sound = extras.values["gcm.n.sound"] as? String
    val channelId = extras.values["gcm.n.android_channel_id"] as? String
  }
}`;
  const probe = `
package dev.happier.activitynotifications
import android.content.Intent
import android.os.Bundle
fun main() {
  for (phase in listOf("offline", "recovered")) {
    val body = """{"type":"machine_alert","v":1,"serverId":"srv-1","accountId":"acc-1","machineId":"machine-1","phase":"$phase","previewBehavior":"title_only"}"""
    val extras = Bundle().apply {
      putString("body", body); putString("gcm.n.e", "1")
      putString("gcm.n.title", "Happier"); putString("gcm.n.body", "Generic machine status")
    }
    val adapted = ActivityRemoteAlertIntent.prepareForNativePresentation(Intent().replaceExtras(extras))
    println(listOf(phase, adapted?.extras?.values?.get("tag") ?: "-", adapted?.extras?.values?.get("message") ?: "-").joinToString("|"))
  }
}`;
  try {
    const files = [
      ['OrgJsonStub.kt', jsonRuntimeStub],
      ['Bundle.kt', 'package android.os\nclass Bundle(other: Bundle? = null) { val values: MutableMap<String, Any> = other?.values?.toMutableMap() ?: mutableMapOf(); fun keySet() = values.keys; fun remove(key: String) { values.remove(key) }; fun putString(key: String, value: String) { values[key] = value } }'],
      ['Intent.kt', 'package android.content\nimport android.os.Bundle\nclass Intent(other: Intent? = null) { var extras: Bundle? = other?.extras; fun replaceExtras(value: Bundle): Intent { extras = value; return this } }'],
      ['Firebase.kt', transport], ['Probe.kt', probe],
    ].map(([name, source]) => { const path = join(work, name); writeFileSync(path, source); return path; });
    const machineParser = join(androidDir, 'MachineRemoteAlert.kt');
    const classes = join(work, 'classes');
    execFileSync('java', ['-cp', toolchain.compilerJars.join(delimiter), 'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler',
      '-classpath', toolchain.runtimeJars.join(delimiter), '-no-stdlib', '-d', classes, '-nowarn',
      kotlinAlertSource, join(androidDir, 'ActivityRemoteAlertIntent.kt'), ...(existsSync(machineParser) ? [machineParser] : []), ...files],
    { stdio: ['ignore', 'pipe', 'pipe'] });
    const output = execFileSync('java', ['-cp', [classes, ...toolchain.runtimeJars].join(delimiter), 'dev.happier.activitynotifications.ProbeKt'], { encoding: 'utf8' });
    assert.deepEqual(output.trim().split('\n'), [
      'offline|machine_alert:srv-1:acc-1:machine-1|Generic machine status',
      'recovered|machine_alert:srv-1:acc-1:machine-1|Generic machine status',
    ]);
  } finally { rmSync(work, { recursive: true, force: true }); }
});

// The Home's content-free closed-app wake exactly as it is submitted, beside
// the neighbors the Android entry point must never hand to the wake consumer.
const wakeScenarios = [
  { id: 'wake_muted', payload: { type: 'session_changed', serverId: SERVER_ID, sessionId: SESSION_ID, alert: 'muted' } },
  { id: 'wake_unknown_alert', payload: { type: 'session_changed', serverId: SERVER_ID, sessionId: SESSION_ID, alert: 'loud' } },
  { id: 'wake_with_home', payload: { type: 'session_changed', serverId: SERVER_ID, sessionId: SESSION_ID } },
  { id: 'wake_without_home', payload: { type: 'session_changed', sessionId: SESSION_ID } },
  { id: 'wake_padded_ids', payload: { type: 'session_changed', serverId: ` ${SERVER_ID} `, sessionId: ` ${SESSION_ID} ` } },
  {
    id: 'wake_carrying_content',
    payload: { type: 'session_changed', serverId: SERVER_ID, sessionId: SESSION_ID, title: 'Alice mentioned you' },
  },
  { id: 'wake_blank_session', payload: { type: 'session_changed', sessionId: '   ' } },
  { id: 'wake_null_home', payload: { type: 'session_changed', serverId: null, sessionId: SESSION_ID } },
  { id: 'badge_refresh', payload: { type: 'badge_refresh' } },
  { id: 'activity_alert', payload: alertPayload(2, { type: 'ready', sequenceDomain: 'session_transcript', messageSeq: 42 }) },
];
const ALERT_SCENARIO = 'activity_alert';

// Executes both real Android admission owners against the same wire body and
// prints "<id>|<wake accepted|rejected>|<sessionId|->|<serverId|->|<alert accepted|rejected>".
const wakeProbeSource = `
package dev.happier.activitynotifications

import com.google.firebase.messaging.RemoteMessage
import org.json.JSONObject

fun main() {
  val input = JSONObject(readlnOrNull() ?: error("missing scenario input"))
  for (key in sortedWakeScenarioKeys(input)) {
    val message = RemoteMessage(mapOf("body" to input.getString(key)))
    val wake = SessionChangedWake.parse(message)
    val alert = ActivityRemoteAlert.parse(message)
    println(
      listOf(
        key,
        if (wake == null) "rejected" else "accepted",
        wake?.sessionId ?: "-",
        wake?.serverId ?: "-",
        if (alert == null) "rejected" else "accepted",
      ).joinToString("|"),
    )
  }
}

private fun sortedWakeScenarioKeys(input: JSONObject): List<String> =
  buildList {
    val keys = input.keys()
    while (keys.hasNext()) add(keys.next())
  }.sorted()
`;

test('Android Machine entrypoint preserves foreground presentation, closed-app fallback and quiet recovery', (t) => {
  const toolchain = discoverKotlinToolchain();
  if (!toolchain) { t.skip('Kotlin toolchain unavailable; Machine enrichment requires the JVM gate'); return; }
  const work = mkdtempSync(join(tmpdir(), 'happier-machine-enrichment-'));
  const androidDir = dirname(kotlinAlertSource);
  const cryptoDir = join(moduleRoot, '..', 'happier-crypto-worker', 'android', 'src', 'main', 'java', 'dev', 'happier', 'cryptoworker');
  const key = Buffer.alloc(32, 7);
  const nonce = Buffer.alloc(12, 3);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const encrypted = Buffer.concat([Buffer.from([0]), nonce, cipher.update(JSON.stringify({ displayName: 'edge-1', host: 'host-1' })), cipher.final(), cipher.getAuthTag()]).toString('base64');
  const probe = `
package dev.happier.activitynotifications
import android.content.Context
import com.google.firebase.messaging.RemoteMessage
import com.sun.net.httpserver.HttpServer
import expo.modules.notifications.service.delegates.ExpoPresentationDelegate
import java.io.File
import java.net.InetSocketAddress
import org.json.JSONObject
fun main(args: Array<String>) {
  val input = JSONObject(readlnOrNull() ?: error("missing fixture"))
  val context = Context(File(args[0]))
  val preparedFile = File(context.filesDir, "happier-activity-alert-context-v1.json")
  var scenario = "plain"
  var mode = "plain"
  var requests = 0
  val server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
  server.createContext("/") { exchange ->
    check(exchange.requestHeaders.getFirst("Authorization") == "Bearer test-token")
    requests += 1
    val currentness = exchange.requestURI.path.endsWith("currentness")
    if (!currentness) check(exchange.requestHeaders.getFirst("x-happier-account-stored-content-protocol") == "2")
    val response = if (currentness) {
      val version = if (scenario == "stale_account") 2 else 1
      val readiness = if (mode == "plain") """{"status":"unavailable","reason":"plain_account"}""" else """{"status":"available"}"""
      """{"mode":"$mode","version":$version,"settingsVersion":1,"signingKeyFingerprint":null,"contentKeyFingerprint":null,"updatedAt":1,"recipientEnvelopeReadiness":$readiness}"""
    } else {
      val metadata = if (mode == "plain") input.getString("plainMetadata") else input.getString("encryptedMetadata")
      val envelope = if (mode == "plain") input.getString("plainMarker") else if (scenario == "bad_key") "Ag==" else "AQ=="
      val custodian = if (scenario == "foreign_machine") "other-account" else "acc-1"
      val kind = if (scenario == "runner") "ephemeral_session_runner" else "persistent"
      if (scenario == "revoked_preparation") preparedFile.delete()
      """{"machine":{"id":"machine-1","kind":"$kind","storageMode":"$mode","dataEncryptionKey":"$envelope","metadata":"$metadata","revokedAt":null,"replacedByMachineId":null,"access":{"custodian":{"accountId":"$custodian","displayName":"Alice"},"role":"manage","resourceMode":"$mode","accessState":"ready"}}}"""
    }
    val bytes = response.toByteArray()
    val status = if (scenario == "network_failure") 403 else 200
    exchange.sendResponseHeaders(status, bytes.size.toLong())
    exchange.responseBody.use { it.write(bytes) }
  }
  server.start()
  try {
    for (case in listOf("plain", "e2ee", "runner", "stale_account", "foreign_machine", "bad_key", "network_failure", "revoked_preparation", "status_only", "recovered")) {
      scenario = case
      mode = if (case in listOf("e2ee", "bad_key")) "e2ee" else "plain"
      requests = 0
      val machineKey = if (mode == "e2ee") """, "machineKey":"CQ=="""" else ""
      preparedFile.writeText("""{"v":1,"homes":[{"v":1,"serverId":"srv-1","apiEndpoint":"http://127.0.0.1:\${server.address.port}","accountId":"acc-1","credential":{"token":"test-token","encryptionMode":"$mode"$machineKey},"settingsVersion":1,"accountEncryptionVersion":1,"registrationId":"registration","pushToken":"push","previewCeiling":"include_preview"}]}""")
      val phase = if (case == "recovered") "recovered" else "offline"
      val preview = if (case == "status_only") "status_only" else "include_preview"
      val body = """{"type":"machine_alert","v":1,"serverId":"srv-1","accountId":"acc-1","machineId":"machine-1","phase":"$phase","previewBehavior":"$preview"}"""
      val message = RemoteMessage(mapOf("body" to body, "title" to "Happier", "message" to "Generic machine status"))
      val alert = MachineRemoteAlert.parse(message) ?: error("alert rejected")
      val enriched = ActivityNotificationPresenter.enrichedMessage(context, message, alert)
      println("$case|\${enriched.data["title"]}|\${enriched.data["message"]}|$requests")
      if (case == "recovered") {
        ActivityNotificationPresenter.present(context, message, alert)
        check(ExpoPresentationDelegate.presented == 1)
        check(ExpoPresentationDelegate.dismissed.isEmpty())
        val quiet = RemoteMessage(mapOf("body" to body))
        ActivityNotificationPresenter.present(context, quiet, alert)
        check(ExpoPresentationDelegate.dismissed.isEmpty())
        check(ExpoPresentationDelegate.presented == 1)
        check(ExpoPresentationDelegate.notifications.single().notificationRequest.content.body?.opt("phase") == "recovered")
        val offlineMessage = RemoteMessage(mapOf("body" to body.replace("recovered", "offline"), "message" to "Offline"))
        ActivityNotificationPresenter.present(context, offlineMessage, MachineRemoteAlert.parse(offlineMessage)!!)
        ActivityNotificationPresenter.present(context, quiet, alert)
        check(ExpoPresentationDelegate.dismissed == listOf("machine_alert:srv-1:acc-1:machine-1"))
        check(ExpoPresentationDelegate.notifications.isEmpty())
      }
    }
    // Exercise the real Firebase entrypoint, ordered handoff and presenter.
    // Expo is the external SDK boundary: its loaded handler supplies Off or
    // Silent; the isolated presenter has no foreground behavior to supply.
    ActivityNotificationMainProcessHandoff.register(context)
    val service = ActivityFirebaseMessagingService()
    fun deliver(phase: String, visible: Boolean = true) {
      val extras = android.os.Bundle().apply {
        putString("body", """{"type":"machine_alert","v":1,"serverId":"srv-1","accountId":"acc-1","machineId":"machine-1","phase":"$phase","previewBehavior":"title_only"}""")
        if (visible) {
          putString("gcm.n.e", "1"); putString("gcm.n.title", "Happier")
          putString("gcm.n.body", "Generic machine status")
        }
      }
      service.handleIntent(android.content.Intent().replaceExtras(extras))
    }
    for (behavior in listOf("off", "silent", "full")) {
      ExpoPresentationDelegate.notifications = emptyList()
      ExpoPresentationDelegate.presented = 0
      ExpoPresentationDelegate.behaviors = emptyList()
      expo.modules.notifications.service.delegates.FirebaseMessagingDelegate.foregroundBehavior = behavior
      deliver("recovered")
      check(ExpoPresentationDelegate.presented == if (behavior == "off") 0 else 1) { "recovered ignored foreground $behavior" }
      if (behavior != "off") check(ExpoPresentationDelegate.behaviors == listOf(behavior)) { "recovered bypassed loaded handler $behavior" }
    }
    // A content-free recovery clears the matching offline notice even when
    // the foreground handler suppresses all visible notifications.
    expo.modules.notifications.service.delegates.FirebaseMessagingDelegate.foregroundBehavior = "full"
    deliver("offline")
    expo.modules.notifications.service.delegates.FirebaseMessagingDelegate.foregroundBehavior = "off"
    val beforeQuiet = ExpoPresentationDelegate.presented
    deliver("recovered", visible = false)
    check(ExpoPresentationDelegate.notifications.isEmpty()) { "quiet recovery retained offline notification" }
    check(ExpoPresentationDelegate.presented == beforeQuiet) { "quiet recovery presented content" }
    ActivityNotificationMainProcessHandoff.unregister()
    ExpoPresentationDelegate.behaviors = emptyList()
    deliver("recovered")
    check(ExpoPresentationDelegate.behaviors == listOf("default")) { "closed app lost native fallback" }
    check(ExpoPresentationDelegate.notifications.single().notificationRequest.content.body?.opt("phase") == "recovered")
  } finally { ActivityNotificationMainProcessHandoff.unregister(); server.stop(0) }
}`;
  try {
    const sources = [
      ['OrgJson.kt', jsonRuntimeStub],
      ['Context.kt', `package android.content
import java.io.File
import java.util.concurrent.CountDownLatch
open class Context(val filesDir: File) {
  companion object { lateinit var current: Context; const val ACTIVITY_SERVICE = "activity" }
  init { current = this }
  val packageName = "dev.happier"
  val applicationContext get() = this
  val packageManager = android.content.pm.PackageManager()
  var receiver: BroadcastReceiver? = null
  fun getSystemService(name: String): Any? = null
  fun unregisterReceiver(value: BroadcastReceiver) { receiver = null }
  fun sendBroadcast(intent: Intent) {}
  fun sendOrderedBroadcast(intent: Intent, permission: String?) { receiver?.onReceive(this, intent) }
  fun sendOrderedBroadcast(intent: Intent, permission: String?, result: BroadcastReceiver, handler: android.os.Handler, code: Int, data: String?, extras: android.os.Bundle?) {
    val pending = receiver?.let { it.onReceive(this, intent); it.pending }
    pending?.done?.await()
    result.resultCode = pending?.code ?: code
    result.onReceive(this, intent)
  }
}
abstract class BroadcastReceiver {
  var resultCode = 0
  var pending: PendingResult? = null
  fun goAsync() = PendingResult().also { pending = it }
  abstract fun onReceive(context: Context, intent: Intent)
  class PendingResult { val done = CountDownLatch(1); var code = 0; fun setResultCode(value: Int) { code = value }; fun finish() { done.countDown() } }
}
class Intent(var action: String? = null) {
  constructor(other: Intent): this(other.action) { extras = other.extras }
  var extras: android.os.Bundle? = null
  var \`package\`: String? = null
  fun replaceExtras(value: android.os.Bundle): Intent { extras = value; return this }
  fun setPackage(value: String): Intent { \`package\` = value; return this }
  fun setComponent(value: ComponentName) = this
  fun putExtra(key: String, value: String): Intent { if (extras == null) extras = android.os.Bundle(); extras!!.putString(key, value); return this }
  fun getStringExtra(key: String) = extras?.values?.get(key) as? String
}
class IntentFilter(action: String)
class ComponentName(context: Context, type: Class<*>)
`],
      ['PackageManager.kt', 'package android.content.pm\nclass PackageManager { fun getServiceInfo(component: android.content.ComponentName, flags: Int) = ServiceInfo() }; class ServiceInfo { val enabled = true; val processName = "dev.happier" }'],
      ['App.kt', 'package android.app\nobject Activity { const val RESULT_FIRST_USER = 1; const val RESULT_CANCELED = 0 }; object Application { fun getProcessName() = "dev.happier" }; class ActivityManager { val runningAppProcesses = emptyList<ProcessInfo>(); class ProcessInfo { val pid = 1; val processName = "dev.happier" } }'],
      ['AndroidOs.kt', 'package android.os\nclass Bundle(other: Bundle? = null) { val values: MutableMap<String, Any> = other?.values?.toMutableMap() ?: mutableMapOf(); fun keySet() = values.keys; fun remove(key: String) { values.remove(key) }; fun putString(key: String, value: String) { values[key] = value } }; class HandlerThread(name: String) { val looper = Any(); fun start() {} }; class Handler(looper: Any); object Build { object VERSION { const val SDK_INT = 35 }; object VERSION_CODES { const val P = 28 } }; object Process { fun myPid() = 1 }'],
      ['ContextCompat.kt', 'package androidx.core.content\nobject ContextCompat { const val RECEIVER_NOT_EXPORTED = 0; fun registerReceiver(context: android.content.Context, receiver: android.content.BroadcastReceiver, filter: android.content.IntentFilter, flags: Int) { context.receiver = receiver } }'],
      ['Uri.kt', 'package android.net\nobject Uri { fun encode(value: String) = java.net.URLEncoder.encode(value, "UTF-8") }'],
      ['Os.kt', 'package android.system\nobject Os { fun rename(from: String, to: String) { java.io.File(from).renameTo(java.io.File(to)) } }'],
      ['Base64.kt', 'package android.util\nobject Base64 { const val DEFAULT = 0; const val NO_WRAP = 2; fun decode(value: String, flags: Int) = java.util.Base64.getDecoder().decode(value); fun encodeToString(value: ByteArray, flags: Int) = java.util.Base64.getEncoder().encodeToString(value) }'],
      // The JNI envelope-opening boundary is unavailable on a host JVM. Keep
      // the canonical envelope adapter and real AES-GCM worker beneath it.
      ['NativeCrypto.kt', 'package dev.happier.cryptoworker\nobject HappierCryptoWorkerNative { fun openDataKeyEnvelopeV1(envelope: ByteArray, recipient: ByteArray): ByteArray? = if (envelope.contentEquals(byteArrayOf(1)) && recipient.contentEquals(byteArrayOf(9))) ByteArray(32) { 7 } else null; fun openSecretboxJson(ciphertext: ByteArray, key: ByteArray): ByteArray? = null }'],
      ['Firebase.kt', `package com.google.firebase.messaging
class RemoteMessage(val data: Map<String, String>) {
  constructor(extras: android.os.Bundle): this(extras.values.filterKeys { !it.startsWith("gcm.n.") }.mapValues { it.value as String }) { if (extras.values["gcm.n.e"] == "1") notification = Notification(extras) }
  var notification: Notification? = null
  class Notification(extras: android.os.Bundle) { val title = extras.values["gcm.n.title"] as? String; val body = extras.values["gcm.n.body"] as? String; val sound = extras.values["gcm.n.sound"] as? String; val channelId = extras.values["gcm.n.android_channel_id"] as? String }
  val from: String? = null; val messageId: String? = null; val sentTime: Long = 1
  class Builder(from: String) { var data = emptyMap<String, String>(); fun setMessageId(id: String) = this; fun setData(value: Map<String, String>): Builder { data=value; return this }; fun build() = RemoteMessage(data) }
}`],
      ['FirebaseApp.kt', 'package com.google.firebase\nobject FirebaseApp { fun initializeApp(context: android.content.Context) {} }'],
      ['ExpoService.kt', 'package expo.modules.notifications.service\nopen class ExpoFirebaseMessagingService { val applicationContext get() = android.content.Context.current; open fun onCreate() {}; open fun onNewToken(token: String) {}; open fun onMessageReceived(message: com.google.firebase.messaging.RemoteMessage) {}; open fun handleIntent(intent: android.content.Intent) { onMessageReceived(com.google.firebase.messaging.RemoteMessage(intent.extras!!)) } }'],
      ['Serializer.kt', 'package expo.modules.notifications.notifications\nobject RemoteMessageSerializer { fun toBundle(message: com.google.firebase.messaging.RemoteMessage) = android.os.Bundle() }'],
      ['FirebaseDelegate.kt', `package expo.modules.notifications.service.delegates
class FirebaseMessagingDelegate(val context: android.content.Context) {
  companion object { var foregroundBehavior = "full"; fun runTaskManagerTasks(context: android.content.Context, bundle: android.os.Bundle) {} }
  fun onNewToken(token: String) {}
  fun onMessageReceived(message: com.google.firebase.messaging.RemoteMessage) {
    val request = expo.modules.notifications.notifications.model.NotificationRequest(message.data["tag"]!!, expo.modules.notifications.notifications.model.RemoteNotificationContent(message), Any())
    ExpoPresentationDelegate(context).presentNotification(expo.modules.notifications.notifications.model.Notification(request, java.util.Date()), foregroundBehavior)
  }
}`],
      ['Models.kt', 'package expo.modules.notifications.notifications.model\nclass RemoteNotificationContent(message: com.google.firebase.messaging.RemoteMessage) { val body = message.data["body"]?.let { org.json.JSONObject(it) } }\nclass NotificationRequest(val identifier: String, val content: RemoteNotificationContent, trigger: Any)\nclass Notification(val notificationRequest: NotificationRequest, date: java.util.Date)'],
      ['Trigger.kt', 'package expo.modules.notifications.notifications.model.triggers\nclass FirebaseNotificationTrigger(message: com.google.firebase.messaging.RemoteMessage)'],
      ['Presentation.kt', 'package expo.modules.notifications.service.delegates\nclass ExpoPresentationDelegate(context: android.content.Context) { companion object { var dismissed = emptyList<String>(); var presented = 0; var behaviors = emptyList<String>(); var notifications = emptyList<expo.modules.notifications.notifications.model.Notification>() }; fun getAllPresentedNotifications() = notifications; fun dismissNotifications(ids: Collection<String>) { dismissed = ids.toList(); notifications = notifications.filter { it.notificationRequest.identifier !in ids } }; fun presentNotification(notification: expo.modules.notifications.notifications.model.Notification, behavior: Any?) { if (behavior == "off") return; presented += 1; behaviors = behaviors + (behavior as? String ?: "default"); notifications = notifications.filter { it.notificationRequest.identifier != notification.notificationRequest.identifier } + notification } }'],
      ['Probe.kt', probe],
    ].map(([name, source]) => { const path = join(work, name); writeFileSync(path, source); return path; });
    const classes = join(work, 'classes');
    const realSources = ['ActivityRemoteAlert.kt', 'MachineRemoteAlert.kt', 'ActivityPreparedContext.kt', 'ActivityNotificationEnricher.kt', 'ActivityNotificationPresenter.kt', 'ActivityFirebaseMessagingService.kt', 'ActivityNotificationMainProcessHandoff.kt', 'ActivityRemoteAlertIntent.kt', 'ActivityNotificationProcess.kt', 'ActivityNotificationTokenBridge.kt', 'SessionChangedWake.kt'].map((name) => join(androidDir, name));
    const cryptoSources = ['HappierCryptoWorker.kt', 'HappierCryptoWorkerBase64.kt', 'HappierCryptoWorkerTypes.kt', 'HappierCryptoWorkerSessionCrypto.kt'].map((name) => join(cryptoDir, name));
    try {
      execFileSync('java', ['-cp', toolchain.compilerJars.join(delimiter), 'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler', '-classpath', toolchain.runtimeJars.join(delimiter), '-no-stdlib', '-d', classes, '-nowarn', ...realSources, ...cryptoSources, ...sources], { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) { throw new Error(error.stderr?.toString() ?? error.message); }
    const plainEnvelope = (v) => Buffer.from(JSON.stringify({ t: 'plain', v })).toString('base64');
    const output = execFileSync('java', ['-cp', [classes, ...toolchain.runtimeJars].join(delimiter), 'dev.happier.activitynotifications.ProbeKt', work], {
      encoding: 'utf8', input: JSON.stringify({ plainMarker: plainEnvelope(null), plainMetadata: plainEnvelope({ displayName: 'edge-1', host: 'host-1' }), encryptedMetadata: encrypted }),
    });
    assert.deepEqual(output.trim().split('\n'), [
      'plain|edge-1|Generic machine status|2', 'e2ee|edge-1|Generic machine status|2',
      'runner|edge-1|Generic machine status|2',
      'stale_account|Happier|Generic machine status|1', 'foreign_machine|Happier|Generic machine status|2',
      'bad_key|Happier|Generic machine status|2', 'network_failure|Happier|Generic machine status|1',
      'revoked_preparation|Happier|Generic machine status|2', 'status_only|Happier|Generic machine status|0',
      'recovered|Happier|Generic machine status|0',
    ]);
  } finally { rmSync(work, { recursive: true, force: true }); }
});

test('Android admits exactly the Protocol content-free wake and never an alert as one', async (t) => {
  const toolchain = discoverKotlinToolchain();
  if (!toolchain) {
    t.skip('local Kotlin toolchain (Gradle distribution) unavailable; the behavioral native admission gate needs it');
    return;
  }

  // The canonical Protocol owner decides every expectation; this test restates
  // none of the wake's admission rules.
  const expected = new Map(wakeScenarios.map((scenario) => [
    scenario.id,
    parseSessionChangedWakeV1(scenario.payload),
  ]));
  assert.ok([...expected.values()].some((wake) => wake), 'Protocol must admit at least one wake under test');
  assert.ok([...expected.values()].some((wake) => !wake), 'Protocol must reject at least one payload under test');

  const work = mkdtempSync(join(tmpdir(), 'activity-session-changed-wake-'));
  let stdout;
  try {
    const jsonStub = join(work, 'OrgJsonStub.kt');
    const firebaseStubFile = join(work, 'FirebaseStub.kt');
    const probeFile = join(work, 'SessionChangedWakeProbe.kt');
    writeFileSync(jsonStub, jsonRuntimeStub);
    writeFileSync(firebaseStubFile, firebaseStub);
    writeFileSync(probeFile, wakeProbeSource);
    const classes = join(work, 'classes');
    execFileSync(
      'java',
      [
        '-cp', toolchain.compilerJars.join(delimiter),
        'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler',
        '-classpath', toolchain.runtimeJars.join(delimiter),
        '-no-stdlib',
        '-d', classes,
        '-nowarn',
        kotlinWakeSource, kotlinAlertSource, jsonStub, firebaseStubFile, probeFile,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );

    const scenarioInput = {};
    for (const scenario of wakeScenarios) scenarioInput[scenario.id] = JSON.stringify(scenario.payload);
    stdout = execFileSync(
      'java',
      [
        '-cp', [classes, ...toolchain.runtimeJars].join(delimiter),
        'dev.happier.activitynotifications.SessionChangedWakeProbeKt',
      ],
      { input: JSON.stringify(scenarioInput), encoding: 'utf8' },
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }

  const observed = new Map(
    stdout.trim().split('\n').filter(Boolean).map((line) => {
      const [id, status, sessionId, serverId, alertStatus] = line.split('|');
      return [id, { status, sessionId, serverId, alertStatus }];
    }),
  );

  for (const scenario of wakeScenarios) {
    const row = observed.get(scenario.id);
    assert.ok(row, `missing probe result for ${scenario.id}`);
    const canonical = expected.get(scenario.id);
    assert.equal(row.status, canonical ? 'accepted' : 'rejected', `${scenario.id} native admission must equal Protocol`);
    if (canonical) {
      assert.equal(row.sessionId, canonical.sessionId, `${scenario.id} native session identity must equal Protocol`);
      assert.equal(row.serverId, canonical.serverId ?? '-', `${scenario.id} native Home identity must equal Protocol`);
    }
    // One message, one native owner: the wake consumer never sees an alert and
    // the alert consumer never sees a wake.
    assert.equal(row.alertStatus, scenario.id === ALERT_SCENARIO ? 'accepted' : 'rejected',
      `${scenario.id} must not be admitted by both native owners`);
    if (scenario.id === ALERT_SCENARIO) assert.equal(row.status, 'rejected');
  }
});
