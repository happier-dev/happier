import { describe, expect, it } from 'vitest';
import { BrowserSessionV1Schema } from './session/v1.js';
import { BrowserViewV1Schema } from './view/v1.js';
import { BrowserTargetSuggestionV1Schema } from './target/v1.js';
import { BrowserCloseViewCommandV1Schema } from './control/v1.js';
import { BrowserTitleChangedEventV1Schema } from './events/v1.js';
import { BrowserProfileV1Schema } from './profile/v1.js';
import { BrowserStoragePartitionV1Schema } from './storage/v1.js';
import { BrowserPermissionGrantV1Schema } from './permissions/v1.js';
import { BrowserTargetPolicyDecisionV1Schema } from './policy/v1.js';
import { BrowserControlPlaneCapabilitiesV1Schema } from './capabilities/v1.js';
import { BrowserDiagnosticCollectorV1Schema } from './diagnostics/v1.js';
import { BrowserAutomationRequesterRefV1Schema } from './automation/v1.js';
import { BrowserSidecarBinaryProvenanceV1Schema } from './sidecar/v1.js';
import { BrowserRecordingActionChapterV1Schema } from './recording/v1.js';

// Long producer values are valid data, rather than a transport or presentation budget.
const identity = 'owned-browser-identity-'.repeat(20);
const prose = 'readable page metadata '.repeat(150).trim();
const target = { kind: 'hostedPluginWeb', targetId: identity, pluginId: identity, contributionId: identity };

describe('complete browser producer values at protocol boundaries', () => {
  const cases = [
    ['session identity', BrowserSessionV1Schema, {
      browserSessionId: identity, profileId: identity, createdAt: 1, state: 'active',
    }],
    ['view identity and page title', BrowserViewV1Schema, {
      viewId: identity, browserSessionId: identity, openerViewId: identity, target,
      state: 'ready', platform: 'web', title: prose, lastError: prose, errorCode: prose,
      canGoBack: false, canGoForward: false,
    }],
    ['plugin target and presentation', BrowserTargetSuggestionV1Schema, {
      suggestionId: identity, source: { kind: 'hostedPluginWeb', pluginId: identity, contributionId: identity },
      target, display: { title: prose, addressLabel: prose, folderLabel: prose, iconToken: identity },
      lastSeenAt: 1, disabledReason: prose,
    }],
    ['command routing identity', BrowserCloseViewCommandV1Schema, {
      kind: 'closeView', commandId: identity, browserSessionId: identity, viewId: identity,
    }],
    ['event page title and routing identity', BrowserTitleChangedEventV1Schema, {
      kind: 'titleChanged', eventId: identity, browserSessionId: identity, viewId: identity, occurredAt: 1, title: prose,
    }],
    ['authoritative profile name', BrowserProfileV1Schema, {
      profileId: identity, storageMode: 'user', owner: { kind: 'user', id: identity },
      displayName: prose, disabledReasons: [prose], cleanupOnSessionClose: true,
    }],
    ['storage partition identity', BrowserStoragePartitionV1Schema, {
      partitionId: identity, profileId: identity, originKey: 'https://example.test',
      targetKind: 'externalUrl', persistence: 'persistent', createdAt: 1, updatedAt: 1, disabledReasons: [prose],
    }],
    ['permission target identity', BrowserPermissionGrantV1Schema, {
      id: identity, profileId: identity, browserSessionId: identity, targetId: identity,
      origin: 'https://example.test', permission: 'camera', state: 'prompt', scope: 'target', updatedAt: 1,
    }],
    ['policy unavailable reason', BrowserTargetPolicyDecisionV1Schema, {
      targetKind: 'externalUrl', state: 'allowed', profileId: identity, disabledReasons: [prose],
    }],
    ['capability unavailable reason', BrowserControlPlaneCapabilitiesV1Schema, {
      supportedCommands: [], supportedEvents: [], adapters: [], disabledReasons: [prose],
    }],
    ['collector nonce and version', BrowserDiagnosticCollectorV1Schema, {
      collectorId: identity, nonce: prose, version: identity,
    }],
    ['private automation requester', BrowserAutomationRequesterRefV1Schema, { kind: identity, id: identity }],
    ['artifact provenance diagnostics', BrowserSidecarBinaryProvenanceV1Schema, {
      origin: 'managed_package', pinnedVersion: '127.0.6533.88', channel: 'stable',
      integrityDigest: `sha256:${'a'.repeat(64)}`,
      signature: `https://artifacts.example.test/signatures/${'a'.repeat(2100)}`,
      license: Array.from({ length: 30 }, () => '(MIT OR Apache-2.0)').join(' AND '),
    }],
    ['recording action chapter metadata', BrowserRecordingActionChapterV1Schema, {
      v: 1, chapterId: identity, actionId: identity, startOffsetMs: 1, endOffsetMs: 2,
      actionKind: identity, status: 'succeeded', requesterClass: 'human', targetSummary: prose,
      reason: prose, diagnosticsRefs: [identity],
    }],
  ] as const;

  it.each(cases)('preserves %s', (_name, schema, value) => {
    expect(schema.parse(value)).toEqual(value);
  });
});
