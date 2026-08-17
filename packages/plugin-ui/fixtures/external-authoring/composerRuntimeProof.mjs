import {
  activate,
  readExternalAuthoringAcceptedMessageLocalIds,
} from './dist-node/index.js';

const attachmentRuntimes = new Map();

await activate({
  composerReferences: {
    register() {},
  },
  composerAttachments: {
    register(id, runtime) {
      attachmentRuntimes.set(id, runtime);
    },
  },
});

const runtime = attachmentRuntimes.get('external-issue');
if (
  runtime === undefined
  || typeof runtime.prepareForSend !== 'function'
  || typeof runtime.resolveForDispatch !== 'function'
  || typeof runtime.afterMessageAccepted !== 'function'
) {
  throw new Error('External Composer attachment runtime was not registered with all lifecycle callbacks.');
}

const invocationContext = {
  signal: new AbortController().signal,
};
const retryRequest = {
  sessionId: 'external-composer-session',
  localId: 'pending-external-retry',
  attachments: [{
    instanceId: 'external-composer-attachment',
    key: 'external-retry',
    value: { reviewId: 'external-retry' },
  }],
};
const firstPreparation = await runtime.prepareForSend(retryRequest, invocationContext);
if (
  firstPreparation.attachments.length !== 1
  || firstPreparation.attachments[0]?.status !== 'failed'
  || firstPreparation.attachments[0]?.retryable !== true
) {
  throw new Error('External Composer attachment did not expose its controlled retryable preparation failure.');
}

const retriedPreparation = await runtime.prepareForSend(retryRequest, invocationContext);
const preparedAttachment = retriedPreparation.attachments[0];
if (
  retriedPreparation.attachments.length !== 1
  || preparedAttachment?.status !== 'ready'
  || preparedAttachment.value !== 'prepared:external-retry'
) {
  throw new Error('External Composer attachment retry did not produce the prepared value.');
}

const resolved = await runtime.resolveForDispatch({
  sessionId: retryRequest.sessionId,
  localId: retryRequest.localId,
  attachments: [{
    instanceId: retryRequest.attachments[0].instanceId,
    key: retryRequest.attachments[0].key,
    value: preparedAttachment.value,
  }],
}, invocationContext);
if (
  resolved.attachments.length !== 1
  || resolved.attachments[0]?.status !== 'ready'
  || resolved.attachments[0]?.context !== 'Fresh external lookup for external-retry'
) {
  throw new Error('External Composer attachment did not produce the fresh dispatch resolution.');
}

const acceptedEvent = {
  sessionId: retryRequest.sessionId,
  localId: retryRequest.localId,
  attachments: [{
    instanceId: retryRequest.attachments[0].instanceId,
    key: retryRequest.attachments[0].key,
    value: preparedAttachment.value,
  }],
};
await runtime.afterMessageAccepted(acceptedEvent, invocationContext);
await runtime.afterMessageAccepted(acceptedEvent, invocationContext);
if (JSON.stringify(readExternalAuthoringAcceptedMessageLocalIds()) !== JSON.stringify([
  retryRequest.localId,
])) {
  throw new Error('External Composer post-accept side effect did not dedupe by localId.');
}

console.log('external-plugin-ui-composer-runtime:ok');
