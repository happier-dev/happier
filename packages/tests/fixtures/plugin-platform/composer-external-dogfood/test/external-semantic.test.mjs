import assert from 'node:assert/strict';
import test from 'node:test';

import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import * as composerHelpers from 'happier-composer-external-dogfood/composer';

const {
  attachIssueMediaFromCurrentComposer,
  attachIssueWithoutControl,
  inspectAndReleaseIssueMediaFromCurrentComposer,
} = composerHelpers;

async function loadDogfoodPlugin() {
  return await import('happier-composer-external-dogfood');
}

function assertJsonSemantics(actual, expected) {
  assert.deepEqual(JSON.parse(JSON.stringify(actual)), expected);
}

const stagedMediaHandle = Object.freeze({
  v: 1,
  id: 'external-stage-42',
  executionTarget: Object.freeze({
    serverId: 'external-server',
    machineId: 'external-machine',
  }),
  owner: Object.freeze({
    pluginId: 'acme.composer.issue-dogfood',
    localId: 'issue-media',
  }),
  mediaKind: 'image',
  mimeType: 'image/png',
  name: 'issue-evidence.png',
  sizeBytes: 4,
  sha256: 'a'.repeat(64),
});

function invocationContext(signal = new AbortController().signal) {
  return Object.freeze({ signal });
}

function actionServices(state) {
  return {
    logger: {
      debug() {},
      info() {},
      warn() {},
      error() {},
      diagnostic() {},
    },
    settings: {
      forScope(scope) {
        assert.deepEqual(scope, { kind: 'account' });
        return {
          async snapshot() {
            return { scope, revision: state.revision, values: state.values };
          },
        };
      },
    },
  };
}

test('external fixture projects Action, settings, placement, and approval contracts', async () => {
  const { manifest } = await loadDogfoodPlugin();
  const inspect = manifest.contributes.actions.find(({ id }) => id === 'inspect');
  assert.deepEqual(inspect.surfaces, ['cli', 'agent', 'ui']);
  assert.deepEqual(inspect.scopes, ['global']);
  assert.deepEqual(inspect.placementBindings, ['commandPalette']);
  assert.equal(inspect.dangerLevel, 'safe');
  assert.equal(inspect.execution.target, 'daemon');
  assert.equal(inspect.inputSchema.properties.message.type, 'string');
  assert.equal(inspect.resultSchema.properties.marker.type, 'string');

  const approval = manifest.contributes.actions.find(({ id }) => id === 'approval-probe');
  assert.equal(approval.dangerLevel, 'writesLocal');
  assert.deepEqual(approval.confirmation, {
    title: 'Run the external Action approval probe?',
    body: 'This dogfood Action validates the host approval path without modifying user data.',
    confirmLabel: 'Run probe',
  });

  assert.deepEqual(manifest.contributes.settings, [{
    id: 'action-preferences',
    title: 'External Action preferences',
    target: { kind: 'plugin' },
    scope: 'account',
    fields: [{
      id: 'multiplier',
      title: 'Message length multiplier',
      schema: { type: 'integer', minimum: 1, maximum: 5 },
      default: 2,
    }, {
      id: 'label',
      title: 'Result label',
      schema: { type: 'string', minLength: 1, maxLength: 64 },
      default: 'external',
    }],
  }]);
});

test('external Action invocation observes current settings, host surface, and cancellation', async () => {
  const { activate, manifest } = await loadDogfoodPlugin();
  const settingsState = {
    revision: 'settings-revision-7',
    values: { multiplier: 3, label: 'fresh' },
  };
  const testkit = await createPluginTestkit({
    manifest,
    module: { activate },
    services: actionServices(settingsState),
  });
  try {
    assertJsonSemantics(await testkit.invokeAction('inspect', { message: 'dogfood' }, { surface: 'cli' }), {
      marker: 'composer-external-action-v1',
      message: 'dogfood',
      multipliedLength: 21,
      multiplier: 3,
      label: 'fresh',
      settingsRevision: 'settings-revision-7',
      surface: 'cli',
    });

    settingsState.revision = 'settings-revision-8';
    settingsState.values = { multiplier: 4, label: 'newer' };
    assertJsonSemantics(await testkit.invokeAction('inspect', { message: 'again' }, { surface: 'ui' }), {
      marker: 'composer-external-action-v1',
      message: 'again',
      multipliedLength: 20,
      multiplier: 4,
      label: 'newer',
      settingsRevision: 'settings-revision-8',
      surface: 'ui',
    });

    const caller = new AbortController();
    const pending = testkit.invokeAction('inspect', {
      message: 'cancel-me',
      delayMs: 30_000,
    }, { surface: 'agent', signal: caller.signal });
    await Promise.resolve();
    caller.abort(new Error('fixture cancellation'));
    await assert.rejects(pending, { code: 'plugin_action_aborted' });
  } finally {
    await testkit.dispose();
  }
});

test('external Composer declaration projects every independent r1.0 family', async () => {
  const { manifest } = await loadDogfoodPlugin();
  assert.deepEqual(manifest.contributes.ui.renderers, [{
    id: 'issue-surface',
    kind: 'reactNative',
    artifact: 'issue-surface-native',
    requiredHostMethods: [
      'readComposer',
      'watchComposer',
      'applyComposer',
      'pickComposerMedia',
      'inspectComposerContent',
      'releaseComposerContent',
    ],
  }]);
  assert.deepEqual(manifest.contributes.composerReferences, [{
    id: 'issues',
    title: 'Issues',
    icon: 'error',
    triggers: ['@', '$'],
  }]);
  assert.deepEqual(manifest.contributes.composerControls, [{
    id: 'issue-control',
    label: 'Issue',
    icon: 'error',
    state: { resource: 'issue-control-state' },
    compactRenderer: { renderer: 'issue-surface' },
    overflow: {
      label: 'More external issue actions',
      icon: 'more',
    },
    interaction: {
      kind: 'attachmentPicker',
      attachment: 'issue',
      presentation: 'popover',
      layout: 'split',
    },
  }]);
  assert.deepEqual(manifest.contributes.resources, [{
    id: 'issue-control-state',
    source: 'dynamic',
    kind: 'config',
    contentType: 'application/vnd.happier.composer-control-state+json;v=1',
    maxBytes: 4096,
    scope: 'global',
  }]);
  assert.deepEqual(manifest.contributes.composerRegions, [{
    id: 'warning',
    placement: 'beforeComposer',
    renderer: { renderer: 'issue-surface' },
  }]);

  const attachment = manifest.contributes.composerAttachments.find(({ id }) => id === 'issue');
  assertJsonSemantics(attachment, {
    id: 'issue',
    title: 'Issue',
    description: 'Attach issue context to the next message',
    icon: 'error',
    cardinality: 'many',
    valueSchema: {
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      properties: { issueId: { type: 'string', minLength: 1 } },
      required: ['issueId'],
      additionalProperties: false,
    },
    preparedValueSchema: {
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'string',
    },
    picker: { renderer: 'issue-surface' },
    display: {
      kind: 'surface',
      renderer: { renderer: 'issue-surface' },
      sizing: 'compact',
    },
    preview: {
      kind: 'surface',
      renderer: { renderer: 'issue-surface' },
      presentation: 'popover',
    },
    runtime: {
      prepareForSend: true,
      resolveForDispatch: true,
      afterMessageAccepted: true,
    },
  });
  assert.equal('content' in attachment, false);
  assertJsonSemantics(
    manifest.contributes.composerAttachments.find(({ id }) => id === 'issue-media'),
    {
      id: 'issue-media',
      title: 'Issue image evidence',
      description: 'Attach portable image evidence to the next message',
      icon: 'preview',
      cardinality: 'many',
      valueSchema: {
        $schema: 'http://json-schema.org/draft-07/schema#',
        type: 'object',
        properties: { issueId: { type: 'string', minLength: 1 } },
        required: ['issueId'],
        additionalProperties: false,
      },
      runtime: {
        prepareForSend: true,
      },
    },
  );
  assert.deepEqual(manifest.contributes.composerControls[0].state, {
    resource: 'issue-control-state',
  });
});

test('external Composer queues daemon-origin media through a contentless attachment', async () => {
  assert.equal(typeof composerHelpers.attachDaemonIssueMediaFromCurrentComposer, 'function');
  const calls = [];
  const composer = {
    async read() {
      calls.push(['read']);
      return { status: 'ready', snapshot: { revision: 31, capabilities: { attachments: true } } };
    },
    async apply(transaction) {
      calls.push(['apply', transaction]);
      return { status: 'applied', revision: 32, attachmentInstanceIds: ['external-daemon-media'] };
    },
  };

  assert.deepEqual(
    await composerHelpers.attachDaemonIssueMediaFromCurrentComposer(
      { current: () => composer },
      'EXT-84',
    ),
    { status: 'applied', revision: 32, attachmentInstanceIds: ['external-daemon-media'] },
  );
  assert.deepEqual(calls, [
    ['read'],
    ['apply', {
      expectedRevision: 31,
      operations: [{
        kind: 'attachment.add',
        attachmentLocalId: 'issue-media',
        value: {
          key: 'issue-media:EXT-84',
          value: { issueId: 'EXT-84' },
          presentation: {
            label: 'Image evidence for Issue EXT-84',
            description: 'Portable external issue evidence selected through the Composer media picker.',
            icon: 'preview',
            tone: 'info',
          },
        },
      }],
    }],
  ]);
});

test('external mounted Composer uses public pick, inspect, apply, and release with one real staged identity', async () => {
  const calls = [];
  const composer = {
    content: {
      async pickMedia(request) {
        calls.push(['pick', request]);
        return stagedMediaHandle;
      },
      async inspect(handle, request) {
        calls.push(['inspect', handle, request]);
        return { offset: 0, bytes: Uint8Array.from([0x89, 0x50, 0x4e, 0x47]), eof: true };
      },
      async release(handle) {
        calls.push(['release', handle]);
      },
    },
    async read() {
      calls.push(['read']);
      return { status: 'ready', snapshot: { revision: 29, capabilities: { attachments: true } } };
    },
    async apply(transaction) {
      calls.push(['apply', transaction]);
      return { status: 'applied', revision: 30, attachmentInstanceIds: ['external-media-instance'] };
    },
  };
  const composers = { current: () => composer };

  assert.deepEqual(await attachIssueMediaFromCurrentComposer(composers, 'EXT-42'), {
    status: 'applied',
    revision: 30,
    attachmentInstanceIds: ['external-media-instance'],
  });
  assert.deepEqual(calls, [
    ['pick', { attachmentLocalId: 'issue-media', kinds: ['image'] }],
    ['inspect', stagedMediaHandle, { offset: 0, maxBytes: 64 }],
    ['read'],
    ['apply', {
      expectedRevision: 29,
      operations: [{
        kind: 'attachment.add',
        attachmentLocalId: 'issue-media',
        value: {
          key: 'issue-media:EXT-42',
          value: { issueId: 'EXT-42' },
          presentation: {
            label: 'Image evidence for Issue EXT-42',
            description: 'Portable external issue evidence selected through the Composer media picker.',
            icon: 'preview',
            tone: 'info',
          },
        },
        content: { kind: 'stagedMedia', handle: stagedMediaHandle },
      }],
    }],
  ]);

  const persistedOperation = calls[3][1].operations[0];
  assert.deepEqual(persistedOperation.value.value, { issueId: 'EXT-42' });
  assert.deepEqual(persistedOperation.content.handle.executionTarget, {
    serverId: 'external-server',
    machineId: 'external-machine',
  });
  assert.deepEqual(persistedOperation.content.handle.owner, {
    pluginId: 'acme.composer.issue-dogfood',
    localId: 'issue-media',
  });
  const synchronizedAttachmentJson = JSON.stringify(persistedOperation);
  for (const forbiddenField of [
    'path',
    'uri',
    'bytes',
    'base64',
    'credential',
    'token',
    'uploadUrl',
    'transferSessionId',
  ]) {
    assert.equal(
      synchronizedAttachmentJson.includes(`\"${forbiddenField}\"`),
      false,
      `synchronized attachment must not contain ${forbiddenField}`,
    );
  }

  calls.length = 0;
  assert.deepEqual(
    await inspectAndReleaseIssueMediaFromCurrentComposer(composers),
    { offset: 0, bytes: Uint8Array.from([0x89, 0x50, 0x4e, 0x47]), eof: true },
  );
  assert.deepEqual(calls, [
    ['pick', { attachmentLocalId: 'issue-media', kinds: ['image'] }],
    ['inspect', stagedMediaHandle, { offset: 0, maxBytes: 64 }],
    ['release', stagedMediaHandle],
  ]);
});

test('external Composer source performs exact-session contentless document mutation', async () => {
  const { activate, manifest } = await loadDogfoodPlugin();
  const appliedTransactions = [];
  const installed = await createPluginTestkit({ manifest, module: { activate } });
  const composers = {
    async get(ref) {
      assert.deepEqual(ref, { kind: 'session', sessionId: 'session-external' });
      return {
        async read() {
          return { status: 'ready', snapshot: { revision: 17 } };
        },
        async apply(transaction) {
          appliedTransactions.push(transaction);
          return { status: 'applied', revision: 18, attachmentInstanceIds: ['instance-1'] };
        },
      };
    },
  };

  try {
    assert.deepEqual(
      await attachIssueWithoutControl(composers, 'session-external', 'EXT-42'),
      { status: 'applied', revision: 18, attachmentInstanceIds: ['instance-1'] },
    );
  } finally {
    await installed.dispose();
  }
  assert.deepEqual(appliedTransactions, [{
    expectedRevision: 17,
    operations: [{
      kind: 'attachment.add',
      attachmentLocalId: 'issue',
      value: {
        key: 'issue:EXT-42',
        value: { issueId: 'EXT-42' },
        presentation: {
          label: 'Issue EXT-42',
          description: 'External issue selected from the Composer picker.',
          icon: 'error',
          tone: 'warning',
        },
      },
    }],
  }]);
  assert.deepEqual(
    appliedTransactions[0].operations[0].value.presentation,
    {
      label: 'Issue EXT-42',
      description: 'External issue selected from the Composer picker.',
      icon: 'error',
      tone: 'warning',
    },
    'the immutable fallback input remains plain host-renderable data after plugin retirement',
  );

  assert.deepEqual(
    await attachIssueWithoutControl({ get: async () => null }, 'closed-session', 'EXT-42'),
    { status: 'unavailable' },
  );
});

test('external Composer runtime proves prepare retry, acceptance timing, fresh resolve, and reinstall', async () => {
  const { activate, manifest, readAcceptedMessageLocalIds } = await loadDogfoodPlugin();
  const testkit = await createPluginTestkit({ manifest, module: { activate } });
  const localId = `external-local-${process.pid}-${Date.now()}`;
  const sessionId = 'external-session';
  const attachment = {
    instanceId: 'external-instance',
    key: 'external-retry',
    value: { issueId: 'EXT-42' },
  };

  try {
    const runtime = testkit.registration('composerAttachments', 'issue');
    assert.ok(runtime);
    assert.equal(typeof runtime.prepareForSend, 'function');
    assert.equal(typeof runtime.resolveForDispatch, 'function');
    assert.equal(typeof runtime.afterMessageAccepted, 'function');
    const controlState = testkit.registration('resources', 'issue-control-state');
    assert.ok(controlState);
    assert.deepEqual(
      JSON.parse(new TextDecoder().decode(await controlState.read({}))),
      { enabled: true, label: 'External issues' },
    );
    const references = testkit.registration('composerReferences', 'issues');
    assert.ok(references);
    assert.deepEqual(await references.search('EXT', new AbortController().signal), []);
    assert.deepEqual(await references.resolve('EXT-42', new AbortController().signal), {
      id: 'EXT-42',
      label: 'Issue',
      context: 'External issue EXT-42',
    });

    assert.deepEqual(await runtime.prepareForSend(
      { sessionId, localId, attachments: [attachment] },
      invocationContext(),
    ), {
      attachments: [{
        instanceId: 'external-instance',
        status: 'failed',
        retryable: true,
        message: 'Issue preparation can be retried.',
      }],
    });

    const prepared = await runtime.prepareForSend(
      { sessionId, localId, attachments: [attachment] },
      invocationContext(),
    );
    assert.deepEqual(prepared, {
      attachments: [{
        instanceId: 'external-instance',
        status: 'ready',
        value: 'prepared:EXT-42',
      }],
    });

    assert.equal(readAcceptedMessageLocalIds().includes(localId), false);
    await runtime.afterMessageAccepted({
      sessionId,
      localId,
      attachments: [{ ...attachment, value: 'prepared:EXT-42' }],
    }, invocationContext());
    assert.ok(readAcceptedMessageLocalIds().includes(localId));

    assert.deepEqual(await runtime.resolveForDispatch({
      sessionId,
      localId,
      attachments: [{ ...attachment, value: 'prepared:EXT-42' }],
    }, invocationContext()), {
      attachments: [{
        instanceId: 'external-instance',
        status: 'ready',
        context: 'Fresh external lookup for EXT-42',
        data: { issueId: 'EXT-42', sessionId, localId },
      }],
    });

    const cancelled = new AbortController();
    cancelled.abort('retired');
    assert.deepEqual(await runtime.prepareForSend({
      sessionId,
      localId: `${localId}-cancelled`,
      attachments: [{ ...attachment, key: 'cancelled' }],
    }, invocationContext(cancelled.signal)), {
      attachments: [{
        instanceId: 'external-instance',
        status: 'failed',
        retryable: true,
        message: 'Issue preparation was interrupted.',
      }],
    });
    assert.deepEqual(await runtime.resolveForDispatch({
      sessionId,
      localId: `${localId}-cancelled`,
      attachments: [{ ...attachment, value: 'prepared:EXT-42' }],
    }, invocationContext(cancelled.signal)), {
      attachments: [{
        instanceId: 'external-instance',
        status: 'unavailable',
        retryable: true,
        message: 'Issue resolution was interrupted.',
      }],
    });
  } finally {
    await testkit.dispose();
  }

  const reinstalled = await createPluginTestkit({ manifest, module: { activate } });
  try {
    assert.ok(reinstalled.registration('composerAttachments', 'issue'));
  } finally {
    await reinstalled.dispose();
  }
});
